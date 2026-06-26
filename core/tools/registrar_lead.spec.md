# Spec: tool `registrar_lead`

> **Owner técnico:** `core-architect`
> **Estado:** implementado y en producción — migración `0013_registrar_lead_rpc.sql` + fix `0013b_registrar_lead_fix_ambiguous.sql` aplicados al remoto.
> **Implementación real:** RPC PostgreSQL `public.registrar_lead` (SECURITY DEFINER, D-42). Nodo 11 del workflow n8n la llama vía PostgREST con la anon key.
> **Fuentes de verdad:** `core/tools/contracts.spec.md` · `core/data_model/turn_envelope.spec.md` (LeadState) · `docs/core_invariant.md` §3 ("Algoritmo BANT") · `infra/supabase/migrations/0013_registrar_lead_rpc.sql`.

---

## 1. Propósito

Captura o actualiza el estado BANT de la conversación. Persiste el cambio en `conversations.bant_state` (jsonb) y emite el delta para auditoría.

Esta tool **reemplaza** la separación entre `capturar_lead` (primera vez) y `actualizar_lead` (siguientes): un solo verbo idempotente.

---

## 2. Descripción para el LLM

> "Registra o actualiza la información de calificación del lead (presupuesto, autoridad para decidir, necesidad concreta, plazo). Úsala cada vez que el cliente revele información nueva relevante para BANT. La tool sabe combinar lo que ya sabes con lo nuevo; tú envías solo los campos sobre los que tienes evidencia. NO inventes valores."

---

## 3. Input schema (implementación real — schema plano)

> **Nota de reconciliación (2026-06-13):** la spec original diseñaba un schema
> anidado por dimensión (con sub-objeto `{value, evidence, amount, role, …}`).
> La implementación real en `0013_registrar_lead_rpc.sql` usa un schema **plano**:
> cuatro strings independientes para las dimensiones BANT + un único campo
> `evidence` compartido. Este schema plano es el contrato vigente.

La firma real del RPC (PostgreSQL / PostgREST):

```
registrar_lead(
  p_tenant_slug   text,                    -- REQUERIDO (guard D-42)
  p_phone         text,                    -- REQUERIDO (identifica al cliente)
  p_budget        text    default null,    -- 'qualified' | 'unknown' | 'disqualified' | null
  p_authority     text    default null,
  p_need          text    default null,
  p_timeline      text    default null,
  p_persona       text    default null,    -- etiqueta del buyer persona (opaca al CORE)
  p_evidence      text    default null,    -- evidencia conversacional COMPARTIDA (ver §6 state machine)
  p_weights       jsonb   default null,    -- {"budget":0.25,"authority":0.25,"need":0.25,"timeline":0.25} — CONFIG
  p_hot_min       integer default 80,      -- cfg.bant_thresholds.hot.min_score — CONFIG
  p_warm_min      integer default 50       -- cfg.bant_thresholds.warm.min_score — CONFIG
)
```

El agente emite el marcador `[[LEAD]]{…}` en su respuesta y el nodo 11 deserializa
los campos y llama al RPC. El LLM no llama directamente al RPC; el nodo 11 actúa
de intermediario determinista.

**Todos los campos BANT son opcionales.** El agente solo pasa las dimensiones
sobre las que tiene evidencia en este turno. El merge con el estado previo es
responsabilidad de la RPC.

### 3.1 Definición operativa de cada dimensión BANT para retail/PyME LATAM

Estas definiciones son CORE: aplican a cualquier vertical sin modificarse.
Los umbrales de calificación concretos (ej. "monto mínimo para considerar
`budget=qualified`") son CONFIG del cliente.

| Dimensión | Pregunta que responde | `qualified` — señales conversacionales | `disqualified` — señales conversacionales | `unknown` — cuándo usar |
|---|---|---|---|---|
| **Budget** | ¿tiene (o gestiona) dinero para comprar? | "necesito X unidades de Y", menciona monto concreto, hace pedido con cantidad, pregunta precio para cerrar, menciona que ya tiene presupuesto aprobado o crédito activo, historial de compra reciente en el mismo ciclo. | Dice explícitamente que no tiene dinero, que el precio está fuera de su alcance, que lo consultará "en otro momento cuando tenga", que está solo cotizando sin autorización de compra. | No reveló nada relacionado con capacidad de pago o volumen. |
| **Authority** | ¿puede tomar la decisión de compra solo? | Se presenta como dueño, encargado de compras, jefe de obra, administrador; hace preguntas de cierre ("¿cuándo llega?", "¿cómo pago?"); pide factura a su nombre/empresa; compró antes sin pedir aprobación. | Dice "tengo que consultarlo con mi jefe/socio/esposa", "no soy yo quien decide", "solo estoy viendo opciones para presentarlas". | No se mencionó su rol ni quién decide. |
| **Need** | ¿tiene una necesidad concreta de producto/servicio? | Menciona producto concreto (marca, presentación, color, cantidad), describe un proyecto específico (obra, remodelación, reabastecimiento), pregunta por especificaciones técnicas, compara alternativas. | Está "nada más viendo", no tiene proyecto activo, pregunta genérica sin destino claro, solo quiere lista de precios sin intención de compra próxima. | No reveló qué necesita o para qué. |
| **Timeline** | ¿cuándo necesita el producto? | "lo necesito esta semana", "para el lunes", "tengo obra empezando", "¿tienes en stock?", pregunta por entrega inmediata o fecha concreta próxima. | "Cuando tenga dinero", "en unos meses", "solo cotizando por si acaso", "no es urgente". | No mencionó plazo ni urgencia. |

### 3.2 Evidencia compartida (`p_evidence`)

Un único string texto libre que el agente extrae de la conversación. Lo usa la
state machine (§6) para validar transiciones sensibles. No hay campo de evidencia
por dimensión; si el agente tiene evidencias distintas para cada dimensión, las
concatena separadas por punto y coma. Máximo recomendado: ~300 caracteres.

Ejemplo: `"Cliente dice que necesita 20 botes para el lunes y es él quien compra directamente."`

---

## 4. Output schema (`data`)

```json
{
  "type": "object",
  "required": ["lead_state", "delta", "stage"],
  "properties": {
    "lead_state": {
      "type": "object",
      "description": "Snapshot completo post-merge (mismo shape que TurnEnvelope.lead_state)."
    },
    "delta": {
      "type": "object",
      "properties": {
        "fields_changed": { "type": "array", "items": { "type": "string" } },
        "before":         { "type": "object" },
        "after":          { "type": "object" }
      }
    },
    "score": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100,
      "description": "Calculado por el algoritmo BANT CORE en base al nuevo estado."
    },
    "stage": {
      "type": "string",
      "enum": ["cold", "warm", "hot"],
      "description": "Derivado por comparar `score` contra `cfg.bant_thresholds`."
    },
    "stage_transition": {
      "type": ["string","null"],
      "description": "Si cambió de stage en este turno, ej. 'warm→hot'."
    }
  }
}
```

**`summary`:** `"Lead actualizado: stage {stage} (score {score}). Cambios: {fields_changed}."`

---

## 5. Algoritmo de scoring BANT (CORE)

Implementado en la RPC `public.registrar_lead` + helper `public.bant_status_int`.

```
-- status_to_int (CORE, inmutable):
qualified    → 1.0
unknown      → 0.3
disqualified → 0.0

-- Pesos (CONFIG; el caller — nodo 11 — los lee de cfg.bant_thresholds.weights):
w_budget, w_authority, w_need, w_timeline  (default 0.25 c/u si weights = null)
w_sum = w_budget + w_authority + w_need + w_timeline

-- Score (CORE):
score = ROUND(
  (w_budget   * status_to_int(budget)   +
   w_authority * status_to_int(authority) +
   w_need      * status_to_int(need)     +
   w_timeline  * status_to_int(timeline))
  * 100 / w_sum
)
-- Resultado: integer 0–100.
```

**Frontera CORE/CONFIG:**
- CORE: `status_to_int`, la fórmula de scoring, la derivación de `stage`.
- CONFIG: `p_weights` (jsonb pasado por nodo 11 desde `cfg.bant_thresholds.weights`),
  `p_hot_min` / `p_warm_min` (desde `cfg.bant_thresholds.hot.min_score` /
  `cfg.bant_thresholds.warm.min_score`).

`stage` se deriva (nunca se setea directo desde el agente):
- `score >= p_hot_min`  → `hot`
- `score >= p_warm_min` → `warm`
- en otro caso          → `cold`

El nodo 11 hace: `const weights = bt.weights || null;` y pasa `p_weights: weights`.
Si el config del cliente no tiene clave `weights`, el RPC usa el default 0.25 c/u.

---

## 6. State machine asimétrica por dimensión (CORE)

Implementada en `public.bant_merge_dim(p_old text, p_new text, p_evidence text)`.
La asimetría es CORE: aplica igual a todos los clientes. Lo que varía por cliente
son los umbrales de score (CONFIG), no las reglas de transición.

| Transición | Condición sobre `p_evidence` | Comportamiento si no se cumple |
|---|---|---|
| `unknown → qualified` | Sin restricción | Acepta |
| `unknown → disqualified` | Sin restricción | Acepta |
| `qualified → disqualified` | `length(trim(evidence)) >= 10 chars` | Conserva `qualified` (soft, no rompe el turno) |
| `disqualified → qualified` | `length(trim(evidence)) > 30 chars` | Conserva `disqualified` (soft, no rompe el turno) |
| `X → X` (sin cambio) | — | Devuelve el mismo valor |
| `p_new` inválido o null | — | Devuelve `p_old` (o `'unknown'` si tampoco hay old) |

**Razón de la asimetría:** re-calificar desde `disqualified` a `qualified` es
una decisión consciente (el cliente cambió de postura); exige evidencia sólida
para evitar oscilaciones. La penalización inversa (`qualified → disqualified`)
es más baja porque descalificar tiene menos riesgo.

La RPC usa **un único `p_evidence`** para las cuatro dimensiones en el mismo
turno. Si el agente quiere transicionar múltiples dimensiones en un turno,
la evidencia debe ser suficientemente larga para cubrir la transición más
restrictiva que intente hacer.

`stage` (cold/warm/hot) **no se setea directo**; siempre se deriva del score.
Si el agente incluye `stage` o `score` en el marcador `[[LEAD]]`, nodo 11 los
ignora (no los pasa al RPC).

---

## 7. Side-effects

1. Update `conversations.bant_state` (jsonb) con el snapshot post-merge.
2. Update `customers` (display_name, persona, segment) si `customer_metadata` viene.
3. Insert en `turns` con `role='tool'` (registro del invocation).
4. Si `stage_transition` no es null y va `→ hot`, dispara evento `lead_became_hot` a observabilidad (Langfuse + posible webhook al CRM del cliente Sem 7+).

---

## 8. Errores específicos

| Código | Cuándo | Acción |
|---|---|---|
| `LEAD_STAGE_NOT_SETTABLE` | Input tiene clave `stage` o `score` | Reject; el agente solo provee dimensiones BANT |
| `LEAD_DISQUALIFY_WITHOUT_EVIDENCE` | Pasar de `qualified` a `disqualified` sin `evidence` ≥ 10 chars | Reject |
| `LEAD_REQUALIFY_NEEDS_DETAIL` | Pasar de `disqualified` a `qualified` con `evidence` < 30 chars | Reject |
| `LEAD_NO_CHANGES` | El merge da snapshot idéntico al previo | `status=ok`, `delta.fields_changed=[]` — no es error, pero `summary` lo indica |
| `TOOL_TENANT_MISMATCH` | (genérico) | Abortar |

---

## 9. Idempotencia

`idempotency_key = sha256(tenant_slug + conversation_id + turn_id + hash(input))`.

Si el agente la llama dos veces dentro del mismo turno con el mismo input, una sola escritura.

---

## 10. Ajustes pendientes en specs previos

1. **`core/utils/config_loader.spec.md` §3:** añadir `bant_thresholds.weights: dict[str, float] | None` (default CORE 0.25 cada uno).
2. **`infra/supabase/migrations/000X_lead_events.sql` (Sem 7):** considerar tabla `lead_events` para tracking de transitions, en lugar de inferir del histórico de `turns`. Opcional, no bloqueante.
3. **`docs/core_invariant.md` §3:** la fila "Algoritmo BANT" ya está; añadir nota "Pesos por dimensión son CONFIG calibrable. El mecanismo de ponderación es CORE."
