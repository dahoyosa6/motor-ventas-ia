# Spec: tool `cotizar`

> **Owner técnico:** `core-architect`
> **Estado:** spec — pendiente de implementación (Sem 4-5).
> **Aplica a:** Sem 4-5 (no entra al POC Sem 3; el POC solo demuestra catálogo + RAG).
> **Fuentes de verdad:** `core/tools/contracts.spec.md` · `core/flows/discount_authorization.spec.md` · `docs/core_invariant.md` §5.1 · D-43 (descuentos = política del cliente, no del export ERP).

---

## 1. Propósito

Construye y persiste una cotización: lista de ítems con cantidad, precio unitario, subtotales y total. **El agente NUNCA aplica descuentos por sí mismo.** Si el cliente solicita un descuento, la tool retorna la cotización en estado borrador (sin descuento aplicado) y emite la señal `pending_discount_authorization=true`, que dispara el flow `core/flows/discount_authorization` para consultar puntualmente al responsable autorizado (definido en `cfg.meta.primary_contact` / `cfg.policies.escalation.notify.primary`). La conversación con el cliente **NO se escala ni se bloquea**; queda en estado conversacional `awaiting_discount_authorization` esperando respuesta.

NO compromete stock (eso es responsabilidad de `consultar_stock`). NO envía la cotización al cliente — devuelve el objeto; el agente decide cómo presentarlo.

---

## 2. Descripción para el LLM

> "Construye una cotización para uno o varios productos con cantidades. **No estás autorizado a aplicar descuentos por iniciativa propia ni a comprometer un porcentaje al cliente.** Si el cliente solicita un descuento (`discount_pct_requested > 0`), llama a esta tool igualmente: la tool retornará la cotización como borrador con `pending_discount_authorization=true`. Tu respuesta al cliente debe ser del tipo *'déjame consultar con {{primary_contact_name}} qué descuento te puedo ofrecer; te confirmo en {{sla}}'*. Mientras tanto, el orquestador dispara el flow `discount_authorization` que pregunta al responsable y reanuda la conversación cuando hay respuesta. Llama a `cotizar` SOLO después de haber confirmado stock con `consultar_stock`."

---

## 3. Input schema

```json
{
  "type": "object",
  "required": ["items"],
  "properties": {
    "items": {
      "type": "array",
      "minItems": 1,
      "maxItems": 30,
      "items": {
        "type": "object",
        "required": ["sku", "quantity"],
        "properties": {
          "sku":              { "type": "string" },
          "quantity":         { "type": "number", "minimum": 0.001 },
          "discount_pct_requested": {
            "type": "number",
            "minimum": 0,
            "maximum": 100,
            "default": 0,
            "description": "Porcentaje de descuento SOLICITADO por el cliente. El agente NO decide este número; lo extrae literal del mensaje del cliente. Si > 0, dispara discount_authorization."
          },
          "discount_reason":  {
            "type": "string",
            "maxLength": 200,
            "description": "Contexto que el cliente alegó para el descuento (volumen, fidelidad, comparación con competencia). Se reenvía al responsable autorizado para que decida."
          }
          ,
          "attribute_value":  {
            "type": "string",
            "maxLength": 120,
            "description": "D-48: valor del atributo de precio variable que el cliente eligió (ej. el color entonado, la graduación, la concentración). Solo aplica a SKUs con extra.price_variability. Si el SKU es de precio variable y este campo NO viene (o no resuelve a un precio del rango), el item NO se cotiza con precio: se devuelve requires_attribute + price_range y el agente pide el atributo. El agente NUNCA inventa un valor; lo extrae del mensaje del cliente."
          }
        }
      }
    },
    "customer_segment": {
      "type": "string",
      "description": "Opcional. Si el agente identificó al cliente como B2B / mostrador / cuenta especial, lo pasa aquí. Se reenvía como contexto al responsable autorizado; el agente NO lo usa para decidir descuento."
    },
    "valid_for_days": { "type": "integer", "minimum": 1, "maximum": 90, "default": 7 },
    "notes": { "type": "string", "maxLength": 1000 }
  }
}
```

---

## 4. Output schema (`data`)

```json
{
  "type": "object",
  "required": ["quote_id", "items", "totals", "validity", "status"],
  "properties": {
    "quote_id": { "type": "string", "description": "uuid v4 del registro en tabla `quotes`" },
    "status": {
      "type": "string",
      "enum": ["draft", "issued", "pending_visit"],
      "description": "draft si pending_discount_authorization=true; pending_visit si grand_total > cfg.policies.quote.visit_required_above_amount (D-47, ver §11); issued en el resto de casos. Si ambas condiciones aplican, prevalece pending_visit (la visita absorbe la consulta de descuento)."
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["sku", "quantity", "unit_price", "subtotal"],
        "properties": {
          "sku":                     { "type": "string" },
          "description":             { "type": "string" },
          "presentation":            { "type": "string" },
          "quantity":                { "type": "number" },
          "unit_price":              { "type": ["number","null"], "description": "null cuando el item es de precio variable (D-48) y attribute_value no fue provisto/no resuelve: vienen price_range y requires_attribute en su lugar. number en el flujo normal de precio fijo." },
          "price_range":             {
            "type": ["object","null"],
            "description": "D-48: presente cuando unit_price=null por variabilidad. El agente comunica 'desde {min}'; NO cierra precio.",
            "properties": { "min": {"type":"number"}, "max": {"type":"number"}, "currency": {"type":"string"} }
          },
          "requires_attribute":      { "type": ["string","null"], "description": "D-48: atributo que el cliente debe elegir (color/graduacion/concentracion/medida) para resolver el precio de este item. null en flujo de precio fijo." },
          "discount_pct_requested":  { "type": "number", "description": "Lo que pidió el cliente." },
          "discount_pct_applied":    { "type": "number", "description": "0 mientras pending_discount_authorization=true. Se actualiza vía discount_authorization cuando el responsable responde." },
          "subtotal":                { "type": "number", "description": "Subtotal SIN descuento aplicado mientras hay autorización pendiente." },
          "currency":                { "type": "string" }
        }
      }
    },
    "totals": {
      "type": "object",
      "properties": {
        "subtotal":       { "type": "number" },
        "discount_total": { "type": "number", "description": "0 mientras pending_discount_authorization=true." },
        "tax_total":      { "type": "number" },
        "grand_total":    { "type": "number", "description": "Total SIN descuento mientras hay autorización pendiente." },
        "currency":       { "type": "string" }
      }
    },
    "validity": {
      "type": "object",
      "properties": {
        "issued_at":   { "type": "string", "format": "date-time" },
        "valid_until": { "type": "string", "format": "date-time" }
      }
    },
    "pending_discount_authorization": {
      "type": "boolean",
      "description": "true si algún ítem trajo discount_pct_requested > 0. Mientras sea true, la cotización está congelada como draft, el flow discount_authorization está activo, y el agente NO debe re-cotizar ni prometer un porcentaje al cliente."
    },
    "discount_authorization": {
      "type": "object",
      "description": "Presente solo si pending_discount_authorization=true. Es el handshake con el flow discount_authorization.",
      "properties": {
        "authorization_id":           { "type": "string", "description": "uuid del row en discount_authorizations" },
        "requested_max_pct":          { "type": "number", "description": "Máximo % solicitado entre todos los ítems (lo que se le pregunta al responsable)." },
        "items_with_discount":        {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sku":                   { "type": "string" },
              "discount_pct_requested":{ "type": "number" },
              "discount_reason":       { "type": "string" }
            }
          }
        },
        "ttl_min":                    { "type": "integer", "description": "Tiempo máximo de espera. Tomado de cfg.policies.discount_authorization.consultation_ttl_min." },
        "expires_at":                 { "type": "string", "format": "date-time" }
      }
    },
    "pending_visit": {
      "type": "boolean",
      "description": "D-47: true si grand_total > cfg.policies.quote.visit_required_above_amount. Mientras sea true, la cotización está congelada como pending_visit, el agente NO la cierra autónomamente, y se dispara agendar(visita) con cfg.meta.primary_contact. NO hay lockout 48h: la conversación sigue activa; el cliente queda esperando confirmación de cita."
    },
    "requires_attribute_resolution": {
      "type": "boolean",
      "description": "D-48: true si algún item es de precio variable (extra.price_variability) y su attribute_value no fue provisto o no resuelve a un precio del rango. Mientras sea true, esos items traen unit_price=null + price_range + requires_attribute, NO se computan en totals, y el agente debe pedir el/los atributo(s) al cliente antes de poder cerrar precio. NO es escalación: la conversación sigue activa. Distinto de QUOTE_PRICE_UNAVAILABLE (§7), que es el caso 'ni precio fijo ni price_variability' y SÍ escala."
    },
    "visit_request": {
      "type": "object",
      "description": "Presente solo si pending_visit=true. Es el handshake con la tool agendar(). El orquestador toma estos campos para invocar agendar() en el mismo turno.",
      "properties": {
        "appointment_kind":     { "type": "string", "const": "technical_visit", "description": "Tipo de cita fijo en CORE: visita técnica para deals grandes." },
        "trigger_threshold":    { "type": "number", "description": "Valor de cfg.policies.quote.visit_required_above_amount usado para disparar (auditoría)." },
        "grand_total":          { "type": "number", "description": "Total que disparó el branch." },
        "currency":             { "type": "string" },
        "notify_target":        { "type": "string", "description": "Resuelto desde cfg.meta.primary_contact (E.164 / email / etc.)." },
        "client_message_rendered": { "type": "string", "description": "Texto final del aviso al cliente: render de cfg.policies.quote.visit_required_message_template con placeholders sustituidos. Si template null/vacío, render del fallback CORE i18n." }
      }
    },
    "attachments": {
      "type": "array",
      "description": "Si el orquestador genera PDF, viene aquí. Sem 4-5: vacío. Mientras pending_discount_authorization=true OR pending_visit=true, no se genera PDF.",
      "items": { "$ref": "#/$defs/OutboundMedia" }
    }
  }
}
```

**`summary`:**
- Caso sin descuento ni visita requerida: `"Cotización N items, total ${grand_total} ${currency}, vence el {valid_until_date}."`
- Caso con autorización pendiente: `"Cotización borrador {quote_id}: cliente pidió hasta {requested_max_pct}% de descuento. Consultando a {{primary_contact_name}}; TTL {ttl_min} min."`
- Caso con visita requerida (D-47): `"Cotización pending_visit {quote_id}: total ${grand_total} ${currency} supera umbral {trigger_threshold}. Agendando visita técnica con {{primary_contact_name}}."`

---

## 5. Política de descuentos — política dura

> **Regla CORE inviolable (alineada con `docs/core_invariant.md` §5.1):** el agente NO aplica descuentos por sí mismo en ningún caso, sin importar segmento, categoría o monto. El campo `autonomy_pct` del `DiscountAuthorizationPolicy` está fijado a `0` en CORE y no es configurable por el cliente. Cualquier descuento solicitado por el cliente requiere consulta puntual al responsable autorizado vía el flow `discount_authorization`.

> Lo configurable por el cliente vive en `clients/<tenant>/policies/descuentos.yaml` y se reduce a parámetros del **flow asíncrono** (TTL de espera y comportamiento de fallback), no a un "tope autónomo".

```yaml
# clients/<tenant>/policies/descuentos.yaml (CONFIG — no en core/)
# Shape sugerido. NO contiene tope autónomo del agente.
version: 2.0
consultation_ttl_min: 30                          # cuánto esperar respuesta del responsable
on_timeout: "ask_client_to_wait"                  # escalate | decline | ask_client_to_wait
notify_target: null                               # null → usa cfg.policies.escalation.notify.primary
context_to_share:                                 # opcional: qué contexto enviar al responsable
  include_customer_history: true
  include_segment: true
  include_competitor_mention: true
```

**Resolución (algoritmo CORE):**
```
# PASO 0 — resolución de precio variable por atributo (D-48, §5.21 Core Invariant). Corre ANTES del descuento.
pv_key = cfg.policies.quote.price_variability_attribute_key  # default: "price_variability"
requires_attribute_resolution = False
for item in items:
    pv = sku.extra.get(pv_key)                 # objeto {attribute,min,max,currency?,resolvable_by_attribute?} o None
    if pv is None:
        continue                               # SKU de precio fijo: flujo legacy, unit_price del export
    resolved = resolve_price_for_attribute(sku, pv, item.attribute_value)  # None si no resuelve
    if item.attribute_value is None or resolved is None:
        # CORE: NO inventar precio. Exponer rango + pedir atributo. NO escalar.
        item.unit_price = None
        item.price_range = {"min": pv["min"], "max": pv["max"], "currency": pv.get("currency", cfg.client.currency)}
        item.requires_attribute = pv["attribute"]
        # NOTA: si item.attribute_value vino pero NO resuelve a un precio del rango y
        #       pv.resolvable_by_attribute is False -> QUOTE_PRICE_UNAVAILABLE (§7, escala: precio especial del responsable).
        requires_attribute_resolution = True
    else:
        item.unit_price = resolved             # atributo elegido -> precio fijo; sigue flujo normal

# Los items con requires_attribute (unit_price=None) NO se computan en totals ni en el branch de descuento.
# Si requires_attribute_resolution: el agente pide el/los atributo(s) y NO se emite cotización cerrada todavía.

for item in items:
    if item.unit_price is None:                # item de precio variable no resuelto (D-48): no participa del descuento
        continue
    if item.discount_pct_requested is None or item.discount_pct_requested == 0:
        item.discount_pct_applied = 0
        item.subtotal = item.quantity * item.unit_price
        continue

    # CORE: el agente NUNCA aplica descuento autónomamente
    item.discount_pct_applied = 0
    item.subtotal = item.quantity * item.unit_price
    pending_discount_authorization = True

if pending_discount_authorization:
    status = "draft"
    requested_max_pct = max(it.discount_pct_requested for it in items)
    authorization = trigger_discount_authorization_flow(
        quote_id, items_with_discount, requested_max_pct,
        ttl_min=cfg.policies.discount_authorization.consultation_ttl_min,
    )
else:
    status = "issued"
```

El **shape** del yaml (campos `consultation_ttl_min`, `on_timeout`, `context_to_share`) es CORE; el loader parsea a `DiscountAuthorizationPolicy` tipado (ver `core/utils/config_loader.spec.md` §3). Los **valores** son CONFIG. Si un cliente quiere campos extra (ej. `notify_target` distinto al de escalación), van como `extra: {}` opcional o se evalúan como extensión CORE.

---

## 6. Persistencia

Crea row en `quotes` y N rows en `quote_items` (tablas pendientes — ver `core/tools/contracts.spec.md` §10 ajuste 3). Shape mínimo:

```sql
quotes (
  id uuid pk,
  tenant_slug text not null,
  conversation_id uuid references conversations(id),
  customer_id uuid references customers(id),
  status enum('draft','issued','approved','rejected','expired','authorization_timeout'),
  subtotal, discount_total, tax_total, grand_total numeric(12,2),
  currency text,
  issued_at, valid_until timestamptz,
  idempotency_key text unique,
  pending_discount_authorization boolean default false,
  discount_authorization_id uuid references discount_authorizations(id),
  raw_metadata jsonb,
  created_at, updated_at timestamptz
)
quote_items (
  id uuid pk,
  quote_id uuid references quotes(id) on delete cascade,
  tenant_slug text not null,
  sku, description text,
  quantity, unit_price,
  discount_pct_requested,
  discount_pct_applied,                    -- 0 hasta que llegue autorización
  subtotal numeric,
  raw_metadata jsonb
)
```

- Si `pending_discount_authorization=true` → `status = 'draft'`. La tool NO llama a `escalar_humano`. **La cotización NO está escalada; está esperando una autorización puntual.** Solo dispara el flow `discount_authorization` (que vive en `core/flows/`), retorna y el orquestador continúa la conversación con un mensaje del tipo "déjame consultar". El cliente sigue activo en la conversación (no hay lockout 48h).

- Cuando llega la respuesta del responsable (vía el flow), un job/handler actualiza:
  - `quote_items.discount_pct_applied` con el % autorizado por ítem (puede ser 0 si el responsable rechaza).
  - `quotes.subtotal, discount_total, grand_total` recalculados.
  - `quotes.status = 'issued'` si fue aprobado, o `'rejected'` si fue declinado.
  - `quotes.pending_discount_authorization = false`.
  - Emite un nuevo turno del agente al cliente con la cotización actualizada (ver `core/flows/discount_authorization.spec.md` §6).

---

## 7. Errores específicos

| Código | Cuándo | Acción |
|---|---|---|
| `QUOTE_SKU_UNKNOWN` | Algún SKU no existe en `products` del tenant | `status=error`; el agente debe consultar_catalogo primero |
| `QUOTE_PRICE_UNAVAILABLE` | El SKU existe, `unit_price` es null **y NO lleva `extra.price_variability`** (no hay ni precio fijo ni rango resoluble por atributo). | `status=error`; escalar. **D-48:** si el SKU SÍ lleva `price_variability`, NO es este error: se devuelve `requires_attribute`+`price_range` y se pide el atributo (no escala). Si el cliente eligió un `attribute_value` que no resuelve a un precio del rango, entonces sí cae aquí (precio especial que cierra el responsable). |
| `QUOTE_DISCOUNT_AUTH_POLICY_MISSING` | `cfg.policies.discount_authorization` es null y algún ítem trae `discount_pct_requested > 0` | Usar defaults CORE (`consultation_ttl_min=30`, `on_timeout="ask_client_to_wait"`); warning. NO aplicar el descuento en ningún caso. |
| `QUOTE_DISCOUNT_AUTH_DISPATCH_FAILED` | El flow `discount_authorization` no pudo notificar al responsable | Persistir quote como `draft`; reintentar la notificación 1x; si vuelve a fallar, ejecutar `on_timeout` directamente. NO aplicar descuento por defecto. |
| `TOOL_TENANT_MISMATCH` | (genérico) | Abortar |

> **Eliminado en esta versión:** `TOOL_POLICY_VIOLATION` (asociado al antiguo `discount_above_policy`) y `QUOTE_POLICY_MISSING` con su fallback `default.max_pct = 0`. Ya no aplican: el agente no tiene tope autónomo que violar; siempre consulta.

---

## 8. Idempotencia

`idempotency_key = sha256(tenant_slug + conversation_id + sorted(items) + truncated_ts(1min))`.

Razón del bucket 1 min: el cliente puede repetir la solicitud y queremos una sola cotización; si pasa más de 1 min asumimos que es intencional (cambió algo).

**Caso especial discount_authorization:** si la misma cotización ya tiene una autorización pendiente activa y el cliente vuelve a pedir descuento (mismo o distinto %), la tool NO crea otra `discount_authorization`. Retorna el `authorization_id` existente y deja que el flow gestione el follow-up (ver `core/flows/discount_authorization.spec.md` §7).

---

## 9. Tax handling (impuesto)

`tax_total` se calcula vía `cfg.policies.tax_rate` (campo opcional, default 0). Si null → no aplica impuesto (el motor no asume IVA mexicano automáticamente; es CONFIG por país).

**Ajuste pendiente §10.4:** añadir `tax_rate: float | None` al `ClientConfig.policies`.

---

## 11. Branch de visita física (D-47, deals grandes)

> **Propósito:** cuando el total de una cotización supera un umbral CONFIG del cliente, el agente NO cierra la cotización autónomamente. En su lugar persiste la cotización como `pending_visit` y dispara `agendar(visita)` con el `primary_contact` del tenant. Origen: el responsable del primer cliente confirmó en reunión 2026-05-27 que las cotizaciones grandes él las cierra con visita física personal; intentar cerrarlas autónomamente daña la relación con el cliente.

### 11.1 Frontera CORE / CONFIG

- **CORE:** existencia del branch, comparación `grand_total > umbral`, integración con `agendar()`, semántica `pending_visit` (NO lockout 48h, NO escalación), prioridad sobre `discount_authorization` cuando ambas aplican.
- **CONFIG (`clients/<slug>/policies/quote_policy.yaml`, sub-bundle `QuotePolicy`):**
  - `visit_required_above_amount: int | None` — monto disparador. `None` ⇒ branch nunca se activa (comportamiento legacy).
  - `visit_required_message_template: str | None` — texto del aviso al cliente. `None` ⇒ fallback CORE i18n `core/prompts/i18n/quote_visit_required_{lang}.txt`.

### 11.2 Algoritmo (extiende §5)

Tras computar `grand_total` (suma de subtotales, sin descuento aplicado mientras `pending_discount_authorization=true`):

```
umbral = cfg.policies.quote.visit_required_above_amount  # puede ser None

if umbral is not None and grand_total > umbral:
    status = "pending_visit"
    pending_visit = True
    visit_request = {
        appointment_kind: "technical_visit",
        trigger_threshold: umbral,
        grand_total: grand_total,
        currency: cfg.meta.currency,
        notify_target: cfg.meta.primary_contact.phone_e164,  # o .target según canal
        client_message_rendered: render_template(
            cfg.policies.quote.visit_required_message_template
            or core_i18n_fallback("quote_visit_required", cfg.meta.language),
            placeholders={
                primary_contact_name: cfg.meta.primary_contact.name,
                display_name: cfg.meta.display_name,
                currency: cfg.meta.currency,
                grand_total: grand_total,
            },
        ),
    }
    # No se llama a discount_authorization aunque pending_discount_authorization fuese true;
    # la consulta de descuento queda absorbida por la visita (el responsable la resuelve in situ).
    pending_discount_authorization = False
    discount_authorization = None
    orchestrator.invoke_tool("agendar", {
        kind: "technical_visit",
        for_quote_id: quote_id,
        target: cfg.meta.primary_contact,
        proposed_window: derive_from_business_hours(cfg.policies.business_hours),
    })
```

### 11.3 Comparación con `pending_discount_authorization`

| Aspecto | `pending_discount_authorization` (D-flow descuentos) | `pending_visit` (D-47) |
|---|---|---|
| Disparador | algún `item.discount_pct_requested > 0` | `grand_total > visit_required_above_amount` |
| Flow al que delega | `core/flows/discount_authorization` | invocación directa de `agendar(technical_visit)` |
| Lockout de la conversación | NO | NO |
| El agente sigue conversando | sí, en estado `awaiting_discount_authorization` | sí, en estado `awaiting_visit_confirmation` |
| Texto al cliente | "déjame consultar con {{primary_contact_name}}, te confirmo en {sla}" | render de `visit_required_message_template` |
| Resolución | responsable responde con %; quote se issued/rejected | visita ocurre; el responsable cierra la cotización fuera del agente (manual) |

**Prevalencia:** si ambas condiciones aplican en la misma llamada a `cotizar`, gana `pending_visit`. Razón: el responsable resuelve descuento + cierre en la visita; multiplicar canales (consulta asíncrona + visita) confunde al cliente y al responsable.

### 11.4 Persistencia (extiende §6)

`quotes.status` admite ahora `'pending_visit'` además de los valores ya declarados. Cuando `pending_visit=true`:

- `quotes.status = 'pending_visit'`.
- `quote_items.discount_pct_applied = 0` (no se aplica descuento autónomamente; el responsable lo resuelve en la visita).
- `quotes.raw_metadata.visit_request = visit_request` (auditoría: qué umbral disparó, qué texto se envió, hacia qué `appointment_id` de `appointments`).
- Cuando la visita se resuelve manualmente fuera del agente, un admin marca `quotes.status = 'issued'` o `'rejected'` desde el dashboard interno (Sem 6+). Sin handler automático Sem 5.

### 11.5 Errores específicos (extiende §7)

| Código | Cuándo | Acción |
|---|---|---|
| `QUOTE_VISIT_AGENDAR_FAILED` | `agendar(technical_visit)` falló (Calendar caído, slot inválido) | Persistir quote como `pending_visit` igualmente; el orquestador envía el `client_message_rendered` y notifica al `primary_contact` por WhatsApp con "llamar al cliente manualmente". Cumple §5.15 (ack sobrevive a Calendar caído). |
| `QUOTE_VISIT_TEMPLATE_RENDER_FAILED` | El template del cliente referencia un placeholder ausente del config | Fallback CORE i18n; warning en `cfg.warnings`. NO aborta el branch. |

### 11.6 Ejemplo concreto

Cliente: PyME con `cfg.policies.quote.visit_required_above_amount: 100000` y `cfg.meta.currency: "MXN"`. El agente cotiza 200 cubetas a $750 c/u (`grand_total: 150000 MXN`).

- 150000 > 100000 ⇒ `pending_visit = true`, `status = "pending_visit"`.
- `visit_request.client_message_rendered`: *"Esta cotización por 150,000 MXN requiere una visita técnica. Le agendo una cita con un asesor para cerrar los detalles y confirmarle la propuesta final."*
- `agendar(technical_visit)` se invoca con `proposed_window` derivado de `business_hours`.
- El agente NO promete porcentaje de descuento ni cierra el deal. El responsable cierra in situ.

Mismo cliente, 50 cubetas a $750 c/u (`grand_total: 37500 MXN`): 37500 < 100000 ⇒ branch NO se activa, flujo normal de cotización.

### 11.7 Tests del branch (pendiente Sem 5, `quality-engineer`)

- **Eval E7 (BLOCKING para piloto):** dado `cfg.policies.quote.visit_required_above_amount = 100000` y un escenario con `grand_total > 100000`, verificar que `cotizar` retorna `status="pending_visit"`, `pending_visit=true`, `visit_request.appointment_kind="technical_visit"`, y que `agendar()` fue invocado.
- **Eval E8:** dado `cfg.policies.quote.visit_required_above_amount = None`, verificar que el branch NUNCA se dispara aunque `grand_total = 10_000_000`.
- **Eval E9:** dado `grand_total > umbral` AND `discount_pct_requested > 0`, verificar que prevalece `pending_visit` (NO `pending_discount_authorization`).

---

## 10. Ajustes pendientes en specs previos

1. **`infra/supabase/migrations/000X_quotes_appointments.sql`:** crear tablas `quotes` + `quote_items` (DDL en §6). Añadir además tabla `discount_authorizations` (DDL en `core/flows/discount_authorization.spec.md` §8).
2. **`core/utils/config_loader.spec.md` §3:** parsear `policies.discount_authorization` como `DiscountAuthorizationPolicy` tipado (campos `consultation_ttl_min`, `on_timeout`, `context_to_share`). El antiguo `DiscountPolicy` (con `default.max_pct`, `by_segment`, `by_category`, `require_approval_above_pct`) **queda eliminado** — el agente no tiene tope autónomo.
3. **`core/utils/schema/client_config.schema.json`:** añadir clave opcional `paths.policies.discounts` apuntando al YAML del nuevo shape v2.0 (TTL + fallback, no tope).
4. **`core/utils/config_loader.spec.md` §3:** añadir `policies.tax_rate: float | None`.
5. **`docs/core_invariant.md` §5.1:** reformular para reflejar la regla nueva: "El agente NUNCA aplica descuentos por iniciativa propia. Cualquier descuento solicitado por el cliente requiere consulta puntual al responsable autorizado vía el flow `discount_authorization`. `autonomy_pct = 0` es CORE inviolable; ningún cliente puede pedir desactivarlo (ej. 'que el agente sí pueda dar 5% sin preguntar' está prohibido). El flow asíncrono distingue esta consulta puntual de una escalación completa (lockout 48h)."
6. **`core/tools/contracts.spec.md` §10:** retirar `discount_above_policy` de la lista de razones esperadas en `TOOL_POLICY_VIOLATION`. Esa razón se elimina del enum de `escalar_humano`. Reemplazar la referencia por `discount_authorization_timeout` (caso edge cuando se ejecuta `on_timeout: escalate`).
7. **`core/prompts/system_template.spec.md`:** ajustar la línea "No prometer descuentos > política sin escalar" por "**No prometer descuentos al cliente**: si el cliente solicita uno, el agente lo registra y consulta al responsable vía `cotizar` → flow `discount_authorization`. Nunca cierra un porcentaje sin esa confirmación." Marcar este ajuste como pendiente del owner del system prompt.
8. **(D-47) `core/prompts/system_template.spec.md`:** añadir guía al system prompt: "**No cerrar cotizaciones > `cfg.policies.quote.visit_required_above_amount`:** si el total supera el umbral, `cotizar` devuelve `status=pending_visit` y dispara `agendar(visita)`. El agente comunica al cliente que se le agenda visita técnica con el responsable; NO promete cierre por chat. Si `visit_required_above_amount=null`, el branch no aplica." Owner: `prompt-conversation-engineer`.
9. **(D-47) `core/prompts/i18n/quote_visit_required_{lang}.txt`:** crear archivo fallback CORE i18n. Contenido genérico LATAM hispano del estilo "Esta cotización por {{grand_total}} {{currency}} requiere una visita técnica. Le agendo una cita con {{primary_contact_name}}." Owner: `prompt-conversation-engineer`.
10. **(D-47) `infra/supabase/migrations/000X_quotes_appointments.sql`:** ampliar `quotes.status` enum con `'pending_visit'`. Añadir índice por `(tenant_slug, status)` para queries del dashboard. Owner: `data-engineer`.
11. **(D-47) `core/tools/agendar.spec.md`:** soportar `appointment_kind="technical_visit"` con vinculación opcional `for_quote_id`. Owner: `prompt-conversation-engineer` / `integrations-engineer`.
