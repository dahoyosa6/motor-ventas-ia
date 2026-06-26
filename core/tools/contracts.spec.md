# Spec: `core/tools/contracts` — contratos generales de las tools del agente

> **Owner técnico:** `core-architect`
> **Estado:** spec — pendiente de implementación (Sem 4-5)
> **Aplica a:** Sem 3 (POC n8n: las tools viven como sub-workflows o nodos Code con la misma firma), Sem 4-5 (motor runtime, registry de tools).
> **Fuentes de verdad:** `docs/core_invariant.md` §3 (fila "Tools del agente"), §5.1, §5.2 · `core/utils/config_loader.spec.md` (de dónde sale el `tenant_slug`) · `core/data_model/turn_envelope.spec.md` §5 (`available_tools`).

---

## 1. Las 6 tools del CORE (decisión)

| # | Nombre | Verbo | Side-effect? | Idempotente? | Vive en |
|---|---|---|:---:|:---:|---|
| 1 | `consultar_catalogo` | search | No | Sí | `core/tools/consultar_catalogo.spec.md` |
| 2 | `consultar_stock` | read | No | Sí | `core/tools/consultar_stock.spec.md` |
| 3 | `cotizar` | compute + persist | Sí (escribe `quotes`) | Sí (por `quote_idempotency_key`) | `core/tools/cotizar.spec.md` |
| 4 | `agendar` | persist + external (Calendar + WhatsApp) | Sí | Sí (por `appointment_idempotency_key`) | `core/tools/agendar.spec.md` |
| 5 | `escalar_humano` | persist + notify | Sí | Sí (por `(conversation_id, reason)` en ventana 10 min) | `core/tools/escalar_humano.spec.md` |
| 6 | `registrar_lead` | persist | Sí (update `conversations.bant_state`) | Sí (por `(conversation_id, turn_id)`) | `core/tools/registrar_lead.spec.md` |

### Justificación de los 6 vs hipótesis original

La hipótesis del usuario tenía las 6 correctas. Confirmación:

- **`consultar_catalogo`, `consultar_stock`, `cotizar`, `agendar`, `escalar_humano`, `registrar_lead`**: cubren los 5 verbos universales de una venta consultiva PyME (descubrir producto, validar disponibilidad, proponer precio, cerrar cita, captura del lead) + el verbo de evacuación (escalar). Sirven a clínica dental, óptica, veterinaria y química industrial sin reescribirse.

### Tools que NO entran al core (decisión razonada)

- **`enviar_ficha_tecnica`** (estaba mencionada en `core/README.md` §"Subcarpetas"): **no es tool independiente**, es side-effect de `consultar_catalogo` (cuando devuelve un producto con `media_attached`) o de la respuesta del agente (cuando elige adjuntar una ficha). Mantenerla como tool sería duplicar caminos de envío de media. Decisión: **integrar al `consultar_catalogo` output schema** (campo `attachments[]`) y al `OutboundMedia` del `TurnResponse`.
- **`capturar_lead`**: nombre redundante con `registrar_lead`. Unificado bajo `registrar_lead`.
- **`reactivar_dormido`** (sugerida por el data drop del 23-05): es un *flujo* (outbound proactivo), no una tool del agente reactivo. Vive como pipeline aparte en Sem 7-8.
- **`calcular_litros_por_m2`** (caso límite §5.2 del Core Invariant): si un tenant lo necesita y no se generaliza, vive en `clients/<tenant_slug>/custom_tools/` como tool de cliente. NO al core.

### Cambios respecto a la lista del Core Invariant §3

El Core Invariant §3 lista: `cotizar, agendar, escalar_humano, capturar_lead, consultar_catalogo, enviar_ficha_tecnica`. Diff:

- `capturar_lead` → renombrado a `registrar_lead` (más preciso: la captura inicial y la actualización son la misma operación).
- `enviar_ficha_tecnica` → eliminado como tool autónoma, integrado como atributo de output de otras tools.
- `consultar_stock` → **añadido** (no estaba en la tabla maestra, pero D-40 + `umbrales_stock_v2.md` lo hacen indispensable y es claramente universal: cualquier PyME comercial necesita "tengo eso ahora?").

**Propuesta de ajuste a Core Invariant §3:** actualizar la fila "Tools del agente" para reflejar las 6 finales. Ver §10 ajustes pendientes.

---

## 2. Anatomía común de toda tool

Toda tool del CORE cumple este contrato general; los specs individuales solo añaden el schema concreto de input/output y errores específicos.

### 2.1. Firma genérica

```python
def tool(input: ToolInput, ctx: ToolContext) -> ToolOutput:
    ...
```

### 2.2. `ToolContext` (inyectado por el orquestador, NO viene del LLM)

```
ToolContext
├── tenant_slug: str                  # OBLIGATORIO, viene del TurnEnvelope.tenant_slug
├── conversation_id: str
├── turn_id: str                      # el turno que está invocando la tool
├── customer_id: str | None
├── client_config: ClientConfig       # objeto del config_loader, NO el dict crudo
├── trace_id: str                     # OTel/Langfuse, para anidar spans
├── now_iso: str                      # timestamp consistente con el envelope
├── dry_run: bool                     # si true, la tool simula side-effects
└── budget:                           # límites por tool call
    ├── timeout_ms: int               # default 5000 (Core; CONFIG no puede subirlo)
    └── max_external_calls: int       # cuántas llamadas a servicios externos se permiten
```

**Por qué `ClientConfig` y no el slug solo:** evita que la tool re-cargue config (race conditions, latencia). El orquestador la carga una vez por turno y la pasa.

### 2.3. `ToolOutput` (shape común — el `data` es específico por tool)

```
ToolOutput
├── status: enum                      # "ok" | "error" | "partial" | "deferred"
├── data: dict | None                 # payload específico de la tool (schema en el spec de cada una)
├── summary: str                      # ≤ 200 chars, lo que el agente lee como "resultado"
├── attachments: list[OutboundMedia]  # opcional, archivos a enviar al cliente
├── side_effects: list[SideEffectRecord]   # qué persistió/llamó esta tool
│   └── {kind, target, target_id, idempotency_key}
├── error: ErrorRecord | None
├── observability:
│   ├── latency_ms: int
│   ├── external_calls: list[{service, latency_ms, status}]
│   └── cache_hit: bool
└── _tool_version: str                # semver del contrato de esta tool
```

**Regla:** `data` es opaco al orquestador; solo el LLM lo razona. `summary` es lo que el orquestador inserta en `context_history` para evitar inflar el contexto.

### 2.4. Errores tipados (jerarquía común)

| Código | Significado | Recoverable? | Acción del agente |
|---|---|:---:|---|
| `TOOL_TIMEOUT` | Excedió `budget.timeout_ms` | Sí (1 retry) | Reintentar; si vuelve a fallar, `escalar_humano(reason="tool_failure_3_attempts")` |
| `TOOL_TENANT_MISMATCH` | El tool recibió un `tenant_slug` distinto al del contexto | No | Abortar turno, alertar (señal de bug crítico multi-tenant) |
| `TOOL_INPUT_INVALID` | Schema validation falló | No | El agente reformula la llamada |
| `TOOL_EXTERNAL_UNAVAILABLE` | Servicio externo caído (Calendar, Supabase) | Sí (con backoff) | Reintentar; si persiste, ofrecer fallback (ej. "te confirmo en un momento") |
| `TOOL_DATA_STALE` | Datos disponibles pero antiguos (ej. inventario > 24h) | Parcial | Responder con disclaimer ("según mi última info...") + flag para revisar con humano |
| `TOOL_POLICY_VIOLATION` | La operación pedida viola una política configurada (caso reservado para futuras tools/customs que validen reglas duras). **Descuentos NO usan este error**: el agente nunca tiene tope autónomo que violar; toda solicitud de descuento se canaliza por el flow asíncrono `discount_authorization` (ver `core/flows/discount_authorization.spec.md` y `core/tools/cotizar.spec.md` §5). | No | Loguear y, si aplica, `escalar_humano` con la razón específica del caso (la razón antigua `discount_above_policy` fue eliminada del enum). |
| `TOOL_NOT_FOUND` | Recurso no existe (SKU, cita) | No | Informar al cliente |
| `TOOL_UNAUTHORIZED` | Permisos insuficientes | No | Loguear y escalar |

### 2.5. Idempotencia

Toda tool con side-effect declara su **`idempotency_key`** y la persiste con el side-effect. Si la misma tool se llama dos veces con la misma `idempotency_key` en una ventana de 10 minutos, devuelve el resultado anterior sin reejecutar.

Convenciones de key (definidas en el spec de cada tool):
- `cotizar` → sha256(`tenant_slug` + `conversation_id` + `sorted(items)` + truncated_ts)
- `agendar` → sha256(`tenant_slug` + `customer_id` + `slot_start_iso`)
- `escalar_humano` → sha256(`tenant_slug` + `conversation_id` + `reason` + truncated_ts(10min))
- `registrar_lead` → sha256(`tenant_slug` + `conversation_id` + `turn_id`)

### 2.6. Tenant scoping (defensa)

Toda tool ejecuta esta validación al entrar:

```python
if input.tenant_slug and input.tenant_slug != ctx.tenant_slug:
    raise ToolTenantMismatch(expected=ctx.tenant_slug, got=input.tenant_slug)

input.tenant_slug = ctx.tenant_slug   # nunca confiar en el LLM
```

Razón: el LLM puede alucinar `tenant_slug` en el input. El único valor confiable es el del `ToolContext`, que vino del `TurnEnvelope` validado en la frontera del webhook. **Defensa en profundidad** alineada con D-42 y migration `0003`.

### 2.7. Timeouts y reintentos

| Param | Valor | Razón |
|---|---|---|
| `budget.timeout_ms` default | 5000 | CORE; balance respuesta-rápida vs tools con I/O |
| Retries dentro de la tool | 0 | Las tools no reintentan internamente; el orquestador decide |
| Reintentos a nivel orquestador | 2 (delta exponencial 500ms, 1500ms) | Después del segundo, escala |
| Circuit breaker por (tool, tenant) | abre tras 3 fallos consecutivos en 60s | Cierra tras 30s sin tráfico |

---

## 3. Cómo el LLM ve las tools (descripción para el modelo)

Cada tool expone su **descripción para el LLM** en formato Anthropic tool-use:

```json
{
  "name": "<nombre>",
  "description": "<frase imperativa de 1-2 oraciones, sin jerga interna>",
  "input_schema": { "type": "object", ... }
}
```

Reglas para la descripción:
- Lenguaje natural neutral, NO menciona implementación.
- NO referencia tenants concretos.
- Indica qué pasa si la tool falla (para que el LLM tenga estrategia).
- Indica cuándo NO usarla (anti-overuse).

Ejemplo (consultar_stock):
> "Verifica la disponibilidad actual de uno o varios productos por su SKU. Devuelve el estado de stock (disponible / bajo / agotado / sobre pedido). Si los datos están desactualizados, lo indicará en el resultado y deberás aclarárselo al cliente. Úsala SIEMPRE antes de comprometer una venta, NO la uses si el cliente solo pregunta por características."

---

## 4. Versionado y compatibilidad

- Cada tool lleva `_tool_version` (semver) en su output.
- Cambio en `input_schema` requerido (campo nuevo obligatorio) = major bump.
- Cambio en `data` shape (campo nuevo opcional) = minor bump.
- Bug fix interno sin cambio de contrato = patch.

El registry de tools (Sem 4-5) puede tener varias versiones registradas simultáneamente; el orquestador elige por defecto la `latest stable`. Útil para canary deploys del piloto Sem 7.

---

## 5. Registro y discovery

`core/tools/registry.py` (pendiente, Sem 4-5) expone:

```python
def get_tool(name: str, version: str = "latest") -> ToolHandle: ...
def list_available_tools(channel: str, stage: str, flags: dict) -> list[ToolDescriptor]: ...
```

El orquestador construye `TurnEnvelope.available_tools[]` llamando a `list_available_tools`. El LLM nunca llama directamente al registry.

---

## 6. Side-effects: trazabilidad obligatoria

Toda tool que escribe a DB o llama servicio externo:

1. Persiste un row en `turns` con `role='tool'`, `tool_name`, `tool_input`, `tool_output`, `parent_turn_id` = turn del assistant que la invocó.
2. Loguea a Langfuse como span anidado dentro del trace del turn.
3. Si llama servicio externo, registra `(service, latency_ms, status)` en `observability.external_calls`.

Esto hace **toda acción del agente reproducible** desde la tabla `turns`.

---

## 7. Anti-patterns prohibidos

- Una tool que **lee config de cliente directamente del disco**: viola §1 de `config_loader.spec.md`. Debe recibir `ClientConfig` por `ToolContext`.
- Una tool que **decide tono o copy del mensaje al cliente**: las tools devuelven `data` y `summary` neutro; el LLM compone la respuesta con el `tono` del cliente.
- Una tool que **hardcodea umbrales**: ej. `if stock < 10`. Los umbrales son CONFIG por cliente.
- Una tool que **escribe en tabla de otro tenant**: rechazado por la migration `0003` para `match_products`; replicar el patrón en cualquier escritura.
- Una tool que **invoca a otra tool**: tools son hojas. Si necesitas componer, hazlo a nivel orquestador o crea un *flow* en `core/flows/`.

---

## 8. Tools específicas de cliente (custom_tools)

Core Invariant §5.2 las permite con justificación. Convención:

- Viven en `clients/<slug>/custom_tools/<nombre>.py`.
- Cumplen el mismo contrato (`ToolContext`, `ToolOutput`) — el motor las trata igual.
- Aparecen en `available_tools` cuando el orquestador detecta su existencia para ese tenant.
- **Cada una requiere entrada en `docs/manual_adaptacion.md` (doc 11) con razón "por qué no se generalizó al CORE".**

---

## 9. Las 6 tools — referencias a sus specs

| Tool | Spec |
|---|---|
| `consultar_catalogo` | `core/tools/consultar_catalogo.spec.md` |
| `consultar_stock` | `core/tools/consultar_stock.spec.md` |
| `cotizar` | `core/tools/cotizar.spec.md` |
| `agendar` | `core/tools/agendar.spec.md` |
| `escalar_humano` | `core/tools/escalar_humano.spec.md` |
| `registrar_lead` | `core/tools/registrar_lead.spec.md` |

---

## 10. Ajustes necesarios en specs previos

> **NO se editan aquí.** Se listan para que el `core-architect` los proponga al PM.

1. **`docs/core_invariant.md` §3 fila "Tools del agente":** actualizar la lista a las 6 finales (`consultar_catalogo, consultar_stock, cotizar, agendar, escalar_humano, registrar_lead`). Quitar `enviar_ficha_tecnica`, renombrar `capturar_lead → registrar_lead`, añadir `consultar_stock`.

2. **`core/README.md` §"Subcarpetas":** actualizar la fila `tools/` quitando `enviar_ficha_tecnica` de la columna "Qué vive aquí".

3. **`infra/supabase/migrations/000X_quotes_appointments.sql` (nueva, Sem 4-5):** crear tablas `quotes`, `quote_items`, `appointments` referenciadas por `cotizar` y `agendar`. No bloqueante para Sem 3 (POC no las usa todavía).

4. **`core/utils/config_loader.spec.md` §3:** parsear `policies.discounts` como sub-bundle tipado `DiscountPolicy` (hoy es `dict | None`). Necesario para que `cotizar` valide tope por categoría sin re-parsear el yaml.
