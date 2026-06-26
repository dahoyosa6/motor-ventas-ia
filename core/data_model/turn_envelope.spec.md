# Spec: `core/data_model/turn_envelope`

> **Owner técnico:** `core-architect`
> **Estado:** spec — pendiente de implementación (Sem 4-5)
> **Aplica a:** Sem 3 (POC n8n: el "envelope" es el shape del JSON que viaja entre nodos), Sem 4-5 (motor runtime, instancias tipadas)
> **Fuentes de verdad:** `infra/supabase/migrations/0001_init.sql` (tablas `conversations`, `turns`, `escalations`) · `core/utils/config_loader.spec.md` §9 (scope de `client_slug` en runtime) · `docs/core_invariant.md` §5.9 y §5.10.

---

## 1. Para qué existe el turn envelope

Contrato único de datos que viaja del webhook → router → AI agent → tools → response → log. Sin él, cada nodo del workflow (o cada función del motor) inventa su propio shape y la observabilidad/auditoría se vuelve imposible. Es la materialización en datos de la frontera Core/Config: ningún campo lleva nombre o valor específico de un cliente; el `tenant_slug` es el único discriminador.

Es también la frontera de seguridad multi-tenant: **`tenant_slug` nunca es opcional**. Si llega null, el motor aborta antes de ejecutar la primera tool (D-42).

---

## 2. Shape del `TurnEnvelope` (entrada — request del turno)

```
TurnEnvelope
├── turn_id: str                          # uuid v4, generado al recibir el webhook
├── conversation_id: str                  # uuid v4; el router lo resuelve o crea
├── tenant_slug: str                      # OBLIGATORIO. Validado regex (config_loader §2)
├── customer:                             # quién habla
│   ├── identifier: str                   # phone E.164 (whatsapp) o session_id (webchat)
│   ├── channel_user_id: str | None       # wamid del peer (whatsapp), web cookie (webchat)
│   ├── display_name: str | None          # nombre si el canal lo provee
│   ├── customer_id: str | None           # uuid de tabla `customers` si ya existe
│   ├── segment_id: str | None            # segmento del cliente (string opaco; clave de buyer_personas.json del tenant). Atributo del customer, NO del lead_state BANT. null si nunca clasificado/indeterminado
│   └── segment_confidence: float | None  # confianza [0..1] del segment_id vigente (del clasificador §5.22 o de la última persistencia). null si segment_id es null
├── channel: enum                         # "whatsapp" | "webchat" (Sem 6+: "voice", "email")
├── inbound:                              # contenido entrante de este turno
│   ├── text: str | None                  # texto plano normalizado (después de OCR/transcripción)
│   ├── media: list[InboundMedia]         # 0..N adjuntos
│   │   ├── kind: enum                    # "image" | "audio" | "document" | "video" | "sticker"
│   │   ├── mime_type: str
│   │   ├── url_or_id: str                # URL firmada o media_id del provider
│   │   ├── transcript: str | None        # poblado por preprocess (audio→texto, OCR)
│   │   └── duration_ms: int | None       # solo audio/video
│   ├── reply_to_turn_id: str | None      # si el cliente respondió citando un mensaje
│   └── raw_provider_event: dict          # webhook crudo del provider (auditoría)
├── context_history: list[ContextTurn]    # últimos N turnos relevantes (ver §4)
│   └── {role, content, created_at, tool_name?, tool_output?}
├── available_tools: list[str]            # subset de tools habilitadas este turno (ver §5)
├── lead_state: LeadState                 # estado BANT actual (snapshot, no diff)
│   ├── budget: enum                      # "unknown" | "qualified" | "disqualified"
│   ├── authority: enum                   # idem
│   ├── need: enum                        # idem
│   ├── timeline: enum                    # idem
│   ├── score: int                        # 0-100, calculado
│   ├── stage: enum                       # "cold" | "warm" | "hot" (derivado vs cfg.bant_thresholds)
│   └── notes: list[str]                  # observaciones del agente, append-only
├── retrieval_hints: dict | None          # pistas opcionales para RAG (categoría sugerida, etc.)
├── metadata:
│   ├── now_iso: str                      # ISO-8601 en cfg.meta.timezone
│   ├── locale: str                       # BCP-47, copia de cfg.meta.language
│   ├── trace_id: str                     # OTel / Langfuse
│   ├── parent_span_id: str | None
│   ├── ingress_ts: str                   # cuándo entró al sistema
│   └── flags: dict                       # toggles del runtime (debug, dry_run, eval_mode)
└── _envelope_version: str                # semver del shape; default "1.0"
```

**Invariantes del envelope:**
- `tenant_slug` matchea `^[a-z][a-z0-9_]{2,63}$` (mismo regex que `config_loader.spec.md` §2). Si no, error `EnvelopeValidationError` ANTES de tocar el `ClientConfig`.
- `conversation_id` único por `(tenant_slug, customer.identifier, channel)`. El router lo resuelve.
- `inbound.text` y `inbound.media` no pueden ser **ambos vacíos** (sería webhook ruido).
- `available_tools` ⊆ del catálogo CORE de tools (ver `core/tools/contracts.spec.md`).
- `context_history` está acotado en N (ver §4); el orquestador lo recorta si excede.

**`customer.segment_id` (§5.22):** atributo del *customer*, no del estado conversacional BANT (`lead_state` es estrictamente budget/authority/need/timeline/score/stage). Lo pobla la cadena de resolución de segmento: 1) valor persistido en `customers.segment`, o 2) el clasificador runtime (`core/scoring/segmentation.spec.md`), o 3) `null` si indeterminado. El `segment_id` viaja como **string opaco** (R1: el motor nunca conoce segmentos concretos; son del tenant vía `buyer_personas.json`). Es señal de calibración de persona/tono/ruteo/BANT y resuelve el routing de `segment_overrides`; 🔒 **NUNCA es palanca de descuento** — ver `docs/core_invariant.md` §5.22.

**Auditoría R1:** los nombres de campos son genéricos. El único valor "cliente-específico" es el contenido de `tenant_slug`, que es por definición su discriminador.

---

## 3. Shape del `TurnResponse` (salida — respuesta del agente)

```
TurnResponse
├── turn_id: str                          # mismo de la request (correlación)
├── conversation_id: str
├── tenant_slug: str                      # eco; defensa contra cross-tenant leak
├── response:                             # qué le decimos al cliente
│   ├── text: str | None                  # cuerpo del mensaje (puede ser null si solo media)
│   ├── media: list[OutboundMedia]        # adjuntos salientes (ficha técnica PDF, foto producto)
│   ├── quick_replies: list[str] | None   # botones (canal whatsapp interactive)
│   └── format: enum                      # "plain" | "markdown" | "whatsapp_interactive"
├── tool_calls_executed: list[ToolCallRecord]
│   ├── tool_name: str
│   ├── input: dict                       # args JSON
│   ├── output: dict                      # resultado JSON
│   ├── status: enum                      # "ok" | "error" | "timeout"
│   ├── error_code: str | None
│   ├── started_at: str
│   ├── ended_at: str
│   └── latency_ms: int
├── lead_state_delta:                     # cambios respecto al lead_state de entrada
│   ├── fields_changed: list[str]         # ej. ["need", "score"]
│   ├── before: dict                      # snapshot anterior
│   ├── after: dict                       # snapshot nuevo
│   └── trigger: str                      # qué causó el cambio ("tool:registrar_lead", "agent_inference")
├── escalation:                           # null si no escala este turno
│   ├── requested: bool
│   ├── reason: enum                      # ver `core/tools/escalar_humano.spec.md`
│   ├── reason_detail: str | None
│   ├── triggered_by: enum                # "agent" | "auto_rule" | "customer_keyword"
│   └── ack_text_to_customer: str         # mensaje que YA se le envió al cliente
├── safety:                               # bloqueos / warnings de guardrails
│   ├── guardrails_triggered: list[str]   # nombres de reglas que se activaron
│   └── disclosure_emitted: bool          # true si en este turno se respondió "¿eres bot?"
├── observability:
│   ├── model: str                        # "claude-sonnet-4-6"
│   ├── template_version: str             # semver del system_template usado
│   ├── tokens_in: int
│   ├── tokens_out: int
│   ├── cost_usd: float
│   ├── latency_ms: int                   # latencia total del turno (ingress → response_ready)
│   └── langfuse_trace_id: str
├── status: enum                          # "ok" | "error" | "partial" | "deferred"
├── error: ErrorRecord | None             # solo si status != "ok"
│   ├── code: str
│   ├── message: str
│   ├── recoverable: bool
│   └── retry_after_ms: int | None
└── _envelope_version: str                # "1.0"
```

**Invariantes de la response:**
- `tenant_slug` debe ser **idéntico** al de la request. Si difiere → bug crítico, abortar el log y alertar.
- `response.text` puede ser `null` solo si `escalation.requested == true` o si `response.media` no está vacío.
- `tool_calls_executed` está en orden cronológico.
- `safety.disclosure_emitted == true` ⇒ `safety.guardrails_triggered` contiene `"core:disclosure"`.

---

## 4. `context_history` — política de recorte

**Decisión:** `context_history` lo arma el orquestador, no el LLM. El LLM solo ve lo que se le da. Estrategia:

| Regla | Valor |
|---|---|
| Últimos N turnos del mismo `conversation_id` | N = 12 (6 pares user/assistant) |
| Tool outputs en historia | Solo `output.summary` (≤ 200 chars), no el dict completo |
| Edad máxima | 24 horas; turnos más viejos se omiten incluso si caben en N |
| Sumario para edades > 24h | Si la conversación es vieja, se inserta un único `system`-role turn con resumen generado por el orquestador (mecanismo CORE, no LLM call por turno) |
| Tamaño total | Hard cap 3,000 tokens; si excede, drop FIFO hasta caber |

Valores son CORE (mecanismo). Si un cliente quisiera "memoria larga", entra como feature futura, no como override de cliente.

---

## 5. `available_tools` — quién decide qué tools entran

Por defecto, `available_tools` = todas las del catálogo CORE de tools que aplican al canal. El orquestador puede restringir:

- **Por fase conversacional:** si `lead_state.stage == "cold"`, no incluir `cotizar` (forzar calificación antes).
- **Por canal:** `webchat` puede usar `enviar_ficha_tecnica` con descarga directa; `whatsapp` requiere template HSM preaprobado.
- **Por flag de runtime:** `flags.dry_run == true` → excluir `agendar` y `escalar_humano` (no efectos secundarios).
- **Por estado de servicios:** si Google Calendar no responde a healthcheck, excluir `agendar` y dejar que el agente proponga "te confirmo en un momento".

El cliente NO puede deshabilitar tools del CORE. Sí puede añadir tools en `clients/<slug>/custom_tools/` (Core Invariant §5.2) que se *agregan* a `available_tools`. Nunca se restan.

---

## 6. Persistencia en Supabase

Mapeo del envelope al schema existente (`0001_init.sql`):

| Campo del envelope | Tabla / columna | Notas |
|---|---|---|
| `turn_id` | `turns.id` | uuid |
| `conversation_id` | `turns.conversation_id` + FK `conversations.id` | |
| `tenant_slug` | `turns.tenant_slug` + `conversations.tenant_slug` | Denormalizado, defensa multi-tenant |
| `customer.identifier` (phone) | `customers.phone` (resolvido vía `conversations.customer_id`) | |
| `channel` | `conversations.channel` | |
| `inbound.text` | `turns.content` (con `role='user'`) | Un row por mensaje user |
| `inbound.media` | `turns.raw_metadata.media[]` (ajuste pendiente, ver §10) | Hoy no hay columna, se aprovecha jsonb |
| `response.text` | `turns.content` (con `role='assistant'`, fila siguiente) | |
| `tool_calls_executed[]` | `turns` (un row por tool call, `role='tool'`, `parent_turn_id` = turn del assistant) | El schema 0001 ya soporta este árbol |
| `lead_state` (entrada) | `conversations.bant_state` (snapshot anterior) | |
| `lead_state_delta.after` | `conversations.bant_state` (actualizado al final del turno) | |
| `escalation.requested == true` | `escalations` (un row nuevo) | Triggered_by_turn_id = `turn_id` |
| `escalation.reason` | `escalations.reason` | Enum tipado |
| `observability.*` | `turns.tokens_in/out`, `cost_usd`, `latency_ms`, `model`, `langfuse_trace_id` | |
| `safety.disclosure_emitted` | `turns.raw_metadata.safety.disclosure_emitted` | Ajuste pendiente §10 |
| `error.*` | `turns.status`, `error_type`, `error_message` | |
| `_envelope_version`, `template_version` | `turns.raw_metadata` | Ajuste pendiente §10 |

**Convención de filas:** un turno conversacional completo genera 1 row `role='user'`, 0..N rows `role='tool'`, y 1 row `role='assistant'`, todos con el mismo `conversation_id` y enlazados por `parent_turn_id` cuando aplique. `turn_id` del envelope = `id` del row `assistant` (es el "turno" desde el punto de vista del cliente).

---

## 7. Validación T1 multi-tenant del envelope

Ejemplo: el mismo envelope shape debe servir para:

- `tenant_slug = "<tenant_slug_A>"`, `channel = "whatsapp"`, `inbound.text = "<query del catálogo del tenant A>"`, → `available_tools` incluye `consultar_catalogo`, `consultar_stock`, `cotizar`.
- `tenant_slug = "clinica_demo"`, `channel = "whatsapp"`, `inbound.text = "tienen guantes de látex talla M?"` → mismo envelope shape, mismo `available_tools` (las mismas 6 tools CORE), diferentes resultados porque el RAG va contra otro `tenant_slug` en `match_products`.

Si para soportar `clinica_demo` hay que añadir un campo al envelope que no necesita `<tenant_slug_A>`, **es bug arquitectónico**: el campo es CORE o no existe.

---

## 8. Errores tipados del envelope

| Error | Cuándo | Acción |
|---|---|---|
| `EnvelopeValidationError` | Falta campo obligatorio o tipo inválido | 400 al webhook; no se logea como turno |
| `TenantSlugMissingError` | `tenant_slug` null o vacío | 400; alerta a observabilidad (señal de routing roto) |
| `TenantUnknownError` | `tenant_slug` no está en `tenants` table | 404; log como `tenant_unknown` (puede ser typo o ataque) |
| `EnvelopeVersionMismatch` | `_envelope_version` no soportado | 400 con mensaje de migración |
| `ContextHistoryCorruptError` | `context_history` referencia `conversation_id` distinto al actual | 500; bug del orquestador |

---

## 9. Idempotencia

Cada turno tiene `turn_id` único (uuid v4 generado al recibir el webhook). Si el provider reenvía el webhook (WhatsApp puede), el motor:

1. Calcula un **dedup key** = sha256(`tenant_slug` + `channel_user_id` + `raw_provider_event.id`).
2. Si ya existe un `turn_id` con ese dedup key en los últimos 5 min → retorna la `TurnResponse` cacheada (idempotente).
3. Si no, procesa nuevo.

Dedup key vive en `turns.raw_metadata.dedup_key` (ajuste pendiente §10). TTL 5 min — más allá, asumimos que es un mensaje nuevo intencionado.

---

## 10. Ajustes necesarios en specs previos

> **NO se editan aquí.** Se listan para que el `core-architect` los proponga al PM como migration / spec update separados.

1. **`infra/supabase/migrations/000X_envelope_metadata.sql` (nueva migration sugerida):** documentar que `turns.raw_metadata` debe incluir las claves `media[]`, `safety.disclosure_emitted`, `envelope_version`, `template_version`, `dedup_key`. No requiere DDL nuevo (el campo ya existe como jsonb), pero sí check de shape vía función SQL o solo a nivel app. **Decisión propuesta:** validar a nivel app (Pydantic) para no acoplar el schema al envelope version.

2. **`core/utils/config_loader.spec.md` §3:** sin cambios obligatorios para este spec, pero ver el ajuste en `system_template.spec.md` §11 (campo `escalation` parseado tipado) — el envelope lo asume disponible vía `cfg.policies.escalation`.

3. **`docs/core_invariant.md` §5:** caso §5.13 nuevo — "El `tenant_slug` es campo obligatorio del envelope. Falla ruidosa si falta." Espejo aplicado del §5.10 a la capa de aplicación (no solo SQL).
