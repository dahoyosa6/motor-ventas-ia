# Spec: flow `core/flows/discount_authorization` — autorización puntual de descuento

> **Owner técnico:** `core-architect`
> **Estado:** spec — pendiente de implementación (Sem 5).
> **Aplica a:** Sem 5 (motor runtime).
> **Fuentes de verdad:** `core/tools/cotizar.spec.md` (la tool que lo dispara) · `core/tools/contracts.spec.md` · `core/flows/escalation.spec.md` (no confundir con este flow) · `core/data_model/turn_envelope.spec.md` · `docs/core_invariant.md` §5.1.

---

## 1. Para qué existe este flow

Materializa la **regla CORE inviolable**: el agente **NUNCA** aplica descuentos por iniciativa propia (`autonomy_pct = 0` fijo). Cuando un cliente solicita un descuento, el agente:

1. Registra la solicitud (vía `cotizar` con `discount_pct_requested > 0`).
2. Le dice al cliente "déjame consultar con {{primary_contact_name}}".
3. **Consulta puntualmente** al responsable autorizado por WhatsApp (u otro canal configurado).
4. **Espera** la respuesta dentro de un TTL configurable.
5. **Reanuda la conversación con el cliente** aplicando lo que el responsable autorizó (puede ser 0% si rechaza).

**Diferencia clave vs `core/flows/escalation`:**

| Aspecto | `discount_authorization` (este flow) | `escalation` |
|---|---|---|
| Naturaleza | Consulta puntual asíncrona sobre **una decisión específica** | Transferencia completa de la conversación al humano |
| Estado conversacional | `awaiting_discount_authorization` (cliente sigue activo, agente responde mensajes no-descuento) | `escalated` (agente queda en silencio total) |
| Lockout | NO. Solo se pausa la cotización; el resto de la conversación continúa | SÍ. 48h o hasta resolución manual |
| Cliente percibe | "El vendedor me está consultando" | "Me pasaron con una persona" |
| TTL típico | Minutos (default 30) | Horas (default 48) |
| Reanudación | Automática al llegar la respuesta del responsable | Manual: humano marca `resolved_at` |
| Disparador | `cotizar` con `discount_pct_requested > 0` | Keyword, queja, regla dura, etc. |

Este flow es CORE porque la mecánica (handshake asíncrono con un humano sobre una decisión acotada) sirve a cualquier PyME LATAM: una clínica dental que pregunta "¿le hago 2x1 en limpieza?", una óptica que pregunta "¿le doy 15% en armazones gama media?", una química industrial que pregunta "¿le aplico la lista B en este pedido?". Lo que cambia entre clientes es el TTL, el comportamiento de fallback y el canal — todo CONFIG.

---

## 2. Estado conversacional

Se introduce un estado nuevo en la máquina del orquestador:

```
conversations.status enum(
    'active',
    'awaiting_discount_authorization',   -- NUEVO
    'escalated',
    'closed'
)
```

**Reglas del estado `awaiting_discount_authorization`:**

- El cliente puede seguir enviando mensajes; el agente puede responder a temas que **no** sean el descuento pendiente (ej. el cliente pregunta por otra referencia, el agente responde normalmente).
- Si el cliente insiste sobre el descuento ("¿ya te respondió?", "necesito una respuesta ya", "mejor déjalo en X%"), el agente aplica la regla §7 de idempotencia: NO genera una segunda consulta; responde "ya consulté a {{primary_contact_name}}, en cuanto me responda te aviso. ¿Quieres que mientras tanto avancemos con el pedido sin descuento o prefieres esperar la confirmación?".
- El agente NO puede prometer un porcentaje, ni siquiera tentativo.
- Solo una cotización a la vez puede estar en `awaiting_discount_authorization` por conversación. Si llega otra solicitud de descuento sobre una cotización distinta antes de que la primera resuelva, queda en cola FIFO o se rechaza (decisión: por simplicidad Sem 5, **se rechaza con mensaje "déjame primero confirmar el descuento que ya consulté"**; FIFO queda como deuda Sem 7+).

---

## 3. Disparador

**Único disparador:** la tool `cotizar` retorna con `pending_discount_authorization=true` y un bloque `discount_authorization` en el output (ver `core/tools/cotizar.spec.md` §4).

El orquestador, al recibir ese output:
1. Persiste la cotización como `draft`.
2. Cambia el estado de la conversación a `awaiting_discount_authorization`.
3. Crea un row en `discount_authorizations` (DDL §8).
4. Dispara el outbound al responsable (§4).
5. Compone y envía el mensaje al cliente (§4 mensaje al cliente).
6. Arma un timer del TTL.

No hay otros disparadores. No es invocable por LLM directamente.

---

## 4. Outbound al responsable autorizado

### 4.1. Resolución del target

```
target = cfg.policies.discount_authorization.notify_target
      or cfg.policies.escalation.notify.primary.target
      or cfg.meta.primary_contact.phone_e164
```

Default razonable: usar el mismo `primary_contact` del cliente. El cliente puede sobreescribir vía `cfg.policies.discount_authorization.notify_target` si la persona que autoriza descuentos no es la misma que recibe escalaciones generales.

### 4.2. Canal

WhatsApp por default (mismo que `cfg.meta.primary_contact.channel`). Otros canales (email, slack, webhook) se soportan vía la misma `NotifyConfig` que escalación.

### 4.3. Mensaje al responsable (formato CORE)

Template (CORE, vive en `core/flows/i18n/discount_authorization_request_{lang}.txt`):

```
[Autorización descuento] {tenant.display_name}
Cotización: {quote_id_short} (cliente {customer.display_name or customer.identifier})
Monto sin descuento: {currency} {grand_total_no_discount}
Descuento solicitado: hasta {requested_max_pct}%

Detalle de ítems con descuento:
{for item in items_with_discount}
  - {sku} {description}: {quantity} × {unit_price} → {item.discount_pct_requested}% pedido. Razón: {item.discount_reason or "no especificada"}
{endfor}

Contexto del cliente:
- Segmento: {customer_segment or "no identificado"}
{if context_to_share.include_customer_history}
- Historial: {customer.total_purchases_12m or "primer contacto"}
{endif}

Responde con el % que autorizas:
  • Un número: "10" o "10%" → aplicar 10% a todos los ítems pedidos.
  • Un número por ítem (si son varios): "SKU1:10 SKU2:5".
  • "no" / "no se puede" → rechazar (descuento queda en 0%).
  • "ok" sin número → aceptar el % máximo solicitado ({requested_max_pct}%).

Si no respondes en {ttl_min} min, el agente {on_timeout_human_description}.
```

Donde `on_timeout_human_description` se materializa según el config:
- `escalate` → "te escalará la conversación completa"
- `decline` → "rechazará el descuento y seguirá con el pedido sin descuento"
- `ask_client_to_wait` → "le pedirá al cliente que espere más tiempo y volverá a consultarte"

El template es CORE; el cliente NO puede reescribirlo (defensa contra ofuscar la decisión al responsable). El cliente solo puede ajustar qué contexto se incluye vía `context_to_share`.

### 4.4. Mensaje al cliente (ack)

Template (CORE, vive en `core/flows/i18n/discount_authorization_ack_{lang}.txt`):

```
Déjame consultar con {{primary_contact_name}} qué descuento te puedo ofrecer en esta cotización. Te confirmo {{sla_consultation}}.
```

Donde `sla_consultation` se renderiza CORE como "en los próximos {ttl_min} minutos" (granularidad: si `ttl_min < 60` → minutos; si `>= 60` → "en aproximadamente N horas"). El cliente NO puede reescribir el template; solo aporta `ttl_min`.

**Importante:** el ack NO menciona el porcentaje solicitado (defensa contra "ya casi lo tienes" y manipulación). NO promete que la respuesta será positiva.

---

## 5. Inbound: respuesta del responsable

### 5.1. Canal y ruteo

El webhook entrante (WhatsApp Cloud API en piloto) ya está identificado por `from_phone_e164`. El orquestador busca si ese número está marcado como "responsable autorizado" para alguna `discount_authorization` activa en estado `pending` cuyo `notify_target` matchea.

Si matchea exactamente una → ruta como respuesta del responsable. Si matchea cero o más de una en la misma ventana de tiempo → comportamiento de §5.4 (ambigüedad).

### 5.2. Contrato mínimo de parseo de la respuesta

El parser debe tolerar respuestas humanas escritas a vuelapluma. Reglas CORE (en orden de prioridad):

1. **Rechazo explícito:** texto matchea regex case-insensitive `(?i)^(no|no se puede|imposible|nel|nope|negativo|rechazado)\b` → autoriza 0%.
2. **Aceptación sin número:** texto matchea `(?i)^(si|ok|sale|listo|va|dale|adelante|aprobado|autorizado)\b` y no contiene dígitos → autoriza `requested_max_pct` (lo máximo que pidió el cliente).
3. **Número global:** texto contiene un único número entre 0-100 (con o sin "%"), opcionalmente precedido por "ok"/"sí"/"hasta"/"máximo" → autoriza ese % a TODOS los ítems con descuento solicitado, **limitado al `discount_pct_requested` por ítem** (si el responsable autoriza 15% pero el cliente pidió 10%, se aplica 10%).
4. **Por ítem:** texto contiene pares `SKU:N` separados por espacios/comas → autoriza N% al SKU correspondiente. Para ítems no listados, autoriza 0%.
5. **No interpretable:** ningún patrón matchea → ver §5.4 (ambigüedad).

El parser CORE vive en `core/flows/discount_authorization/parser.py` (cuando se implemente). Es **case-insensitive**, ignora acentos para los matches de keywords, y trim espacios. La lista de keywords (Sí/No) en otros idiomas vive en `core/flows/i18n/discount_response_keywords_{lang}.json`.

### 5.3. Resultado del parseo

```
ParseResult:
  status: "approved" | "rejected" | "approved_per_item" | "ambiguous"
  authorized_pct_global: float | None        # si status=approved
  authorized_pct_per_sku: dict[str, float]   # si status=approved_per_item
  raw_response: str
  parser_confidence: "high" | "medium" | "low"
```

### 5.4. Caso ambiguo

Si `ParseResult.status == "ambiguous"`:
1. Re-pregunta al responsable UNA sola vez con un mensaje aclaratorio:
   ```
   No entendí tu respuesta para la cotización {quote_id_short}. ¿Apruebas? Si sí, indica el %. Si no, escribe "no".
   ```
2. Resetea el TTL (vuelve a contar desde 0 con `ttl_min` original).
3. Si la segunda respuesta también es ambigua, ejecuta `on_timeout` directamente. Loguea como `discount_authorization_parse_failure`.

---

## 5.5. Excepciones por segmento de cliente (segment overrides)

Antes de disparar el outbound al responsable (§4), el flow consulta el segmento del cliente actual y verifica si aplica una excepción configurada por el cliente. Mecanismo CORE; los segmentos concretos son CONFIG (vive en `clients/<slug>/segments/buyer_personas.json` y se referencia desde `cfg.policies.discount_authorization.segment_overrides`).

### 5.5.1. Por qué existe

Ciertos segmentos de clientes pueden tener, por política comercial del tenant, una decisión de descuento ya tomada y estable (ej. "este segmento NO recibe descuento"). Forzar la consulta puntual a un humano para una decisión que ya está tomada genera:
- Ruido al responsable (mismas preguntas repetidas todos los días).
- Latencia innecesaria para el cliente (espera por algo que ya está decidido).
- Riesgo de que el responsable, abrumado, autorice por inercia algo que la política excluye.

Mecanizar la regla en config (no en system prompt) evita que el LLM la incumpla en un turno desafortunado.

### 5.5.2. Estado en la máquina

Se introduce un punto de decisión nuevo en el dispatcher del flow, **antes** del paso 2 de §3 (cambio de `conversations.status` a `awaiting_discount_authorization`):

```
cotizar(discount_pct_requested > 0)
  └─→ resolver segmento del cliente actual (§5.5.3)
        ├─ segmento ∈ cfg.policies.discount_authorization.segment_overrides
        │     └─→ ejecutar action del override (§5.5.4); NO se manda outbound al dueño
        │           └─→ conversación queda `active`, cotización `draft_finalized_no_discount`
        └─ segmento ∉ segment_overrides (o no resoluble)
              └─→ flujo normal §3 paso 2 en adelante (consultar al responsable)
```

El estado `awaiting_discount_authorization` **no** se entra cuando aplica un override. La cotización queda inmediatamente resuelta sin handshake humano.

### 5.5.3. Resolución del segmento del cliente

El flow obtiene el segmento del cliente actual consultando, en orden de preferencia:

1. `customer.segment_id` ya persistido en la tabla `customers` (si el cliente está identificado y categorizado).
2. Resultado del clasificador de segmento en runtime (ver `core/scoring/segmentation.spec.md` cuando exista) sobre el contexto BANT acumulado.
3. Si ninguno aplica → **segmento indeterminado**.

Caso edge **segmento indeterminado**: el flow procede con el comportamiento por defecto (consultar al responsable). NO se asume excepción. Razón: la regla `segment_overrides` resta autoridad al humano; aplicarla sin certeza del segmento es peor que el ruido de una consulta extra.

La regla se evalúa **en el momento del request**, no se retroactiva: si el segmento del cliente cambia entre turnos (recategorización por BANT), los overrides aplican según el segmento vigente al disparar `cotizar`. Cotizaciones anteriores ya resueltas no se recalculan.

### 5.5.4. Acciones soportadas

Por ahora el enum de `action` soporta un solo valor; el campo está diseñado para crecer con futuros patrones sin romper el schema.

| `action` | Comportamiento |
|---|---|
| `decline_no_consultation` | El flow NO envía outbound al responsable. Renderiza el `decline_message_template` configurado y lo envía al cliente como turno del agente. La cotización queda como `draft_finalized_no_discount` con `pending_discount_authorization = false`. El cliente puede seguir conversando (la conversación sigue `active`); puede aceptar la cotización sin descuento o ajustar cantidades. |

### 5.5.5. Mensaje al cliente

El `decline_message_template` se renderiza con los placeholders estándar del flow (`{{currency}}`, `{{grand_total}}`, `{{customer_name}}`, etc.) más cualquier placeholder específico que el cliente quiera usar. Es texto del **cliente** (no CORE) porque la forma de comunicar "no hay descuento para tu segmento" es decisión comercial del tenant.

Caso edge: si el template renderizado queda vacío o falla la renderización (placeholder inexistente), el flow cae al fallback CORE en `core/flows/i18n/discount_authorization_segment_decline_{lang}.txt`:

```
Por el momento esta cotización no aplica para descuento. La dejo en {{currency}} {{grand_total}}. ¿Avanzamos así o prefieres que ajustemos algo?
```

### 5.5.6. Auditoría

El override aplicado se persiste en `discount_authorizations` (DDL §8) con los siguientes campos:

- `status = 'segment_blocked'` (nuevo valor del enum; ver §8 ampliado).
- `resolved_outcome = 'segment_override:<segment_id>'` (donde `<segment_id>` es la clave del dict `segment_overrides` que matcheó).
- `resolved_at = now()` (resuelto sincrónicamente; no hay TTL ni espera).
- `notify_sent_at = null`, `notify_target = null`, `response_raw = null` — no hubo handshake.
- `raw_metadata.segment_override = { "segment_id": "<id>", "action": "decline_no_consultation", "reason_for_audit": "<texto del config>" }`.

Esto deja trazabilidad para reportes ("¿cuántas cotizaciones se bloquearon por override de segmento en el mes?", "¿cuál es el segmento que más bloquea descuentos?") y para evaluación de si la política está correctamente configurada.

Span en Langfuse del turno que disparó `cotizar` queda etiquetado con `discount_outcome = "segment_blocked"`.

### 5.5.7. Idempotencia

Las reglas §7 siguen aplicando. Notas específicas para overrides:

- Si la misma cotización vuelve a procesarse (por reintento del orquestador), el override se aplica de nuevo de manera idempotente (mismo segmento → mismo resultado). El `idempotency_key` evita duplicar el row en `discount_authorizations`.
- Si el cliente cambia de segmento entre turnos (recategorización) y la cotización original ya fue resuelta con override, la cotización vieja queda como está. Una **nueva** cotización (otro `quote_id`) se evalúa con el segmento vigente al momento.

### 5.5.8. Auditoría R1/R2 sobre esta sección

- **R1:** los identificadores concretos de segmento del primer cliente no aparecen como literales en esta sección. Los identificadores son provistos por el cliente vía `cfg.policies.discount_authorization.segment_overrides` (claves del dict) y por `clients/<slug>/segments/buyer_personas.json`. El motor solo conoce el mecanismo. Cumple.
- **R2:** el flow consume `cfg.policies.discount_authorization.segment_overrides` vía el loader. Cero `import` desde `clients/`. Cumple.

---

## 6. Reanudación de la conversación con el cliente

Cuando llega la autorización (`approved`, `rejected`, o `approved_per_item`):

1. Actualizar `quotes` y `quote_items`:
   - `discount_pct_applied` por ítem según la autorización (mínimo entre lo autorizado y lo solicitado).
   - Recalcular `subtotal`, `discount_total`, `grand_total`.
   - `quotes.status = 'issued'` (si hay al menos un ítem con descuento aplicado) o `'rejected'` (si todos quedaron en 0% por rechazo).
   - `quotes.pending_discount_authorization = false`.
2. Cambiar `conversations.status` de `awaiting_discount_authorization` a `active`.
3. Generar un turno del agente al cliente. El template depende del resultado (CORE, vive en `core/flows/i18n/discount_authorization_resume_{lang}.txt`):

   **Aprobación total** (autorizó exactamente lo pedido):
   > "Listo, {{primary_contact_name}} autorizó el {{authorized_pct}}% que pediste. Tu cotización queda en {{currency}} {{grand_total}}. ¿Cerramos así?"

   **Aprobación parcial** (autorizó menos de lo pedido):
   > "Hablé con {{primary_contact_name}}: podemos manejarte {{authorized_pct}}% (en lugar de {{requested_pct}}%). Eso deja la cotización en {{currency}} {{grand_total}}. ¿Te sirve?"

   **Aprobación por ítem** (mix):
   > "Ya pude validar con {{primary_contact_name}}. Quedó así: {por_item_breakdown}. Total con descuentos: {{currency}} {{grand_total}}. ¿Avanzamos?"

   **Rechazo:**
   > "Consulté con {{primary_contact_name}} y por ahora no podemos aplicar descuento en esta cotización. La dejo en {{currency}} {{grand_total}} sin descuento. ¿Quieres que avancemos así o prefieres ajustar las cantidades?"

4. Marcar `discount_authorizations.resolved_at = now()` y `resolved_outcome = <status>`.

El agente recupera capacidad normal de respuesta inmediatamente después de emitir el turno de reanudación.

---

## 7. Idempotencia

**Regla CORE:** una misma cotización no genera dos preguntas al responsable.

- `idempotency_key = sha256(tenant_slug + quote_id + "discount_auth")`. Sin bucket temporal: la cotización es identificable únicamente.
- Si el cliente insiste durante el `awaiting_discount_authorization` ("¿cuánto descuento me puedes dar?" repetido), el orquestador retorna el row existente y el LLM responde con el mensaje de espera (ver §2).
- Si el cliente modifica la cotización (cambia ítems o cantidades) mientras hay una autorización pendiente:
  - **Opción Sem 5 (simple):** se cancela la autorización en curso (`discount_authorizations.status = 'superseded'`), se crea cotización nueva, y se dispara una segunda consulta al responsable. Se notifica al responsable que la primera consulta queda sin efecto: "El cliente cambió la cotización; ignora la consulta anterior. Nueva consulta sigue".
  - Opción Sem 7+: permitir re-uso parcial. Fuera de alcance Sem 5.

---

## 8. Persistencia

DDL nueva:

```sql
discount_authorizations (
  id uuid pk,
  tenant_slug text not null,
  conversation_id uuid references conversations(id),
  quote_id uuid references quotes(id),
  status enum('pending', 'approved', 'approved_per_item', 'rejected', 'timeout', 'superseded', 'segment_blocked') default 'pending',  -- 'segment_blocked' = resuelto sincrónicamente por segment_overrides (§5.5)
  requested_max_pct numeric(5,2) not null,
  authorized_pct_global numeric(5,2),
  authorized_pct_per_sku jsonb,
  notify_target text not null,
  notify_channel text not null default 'whatsapp',
  notify_sent_at timestamptz,
  notify_delivery_error text,
  response_raw text,
  response_received_at timestamptz,
  parser_confidence text,
  ttl_min int not null,
  expires_at timestamptz not null,
  on_timeout text not null,
  resolved_at timestamptz,
  resolved_outcome text,
  idempotency_key text unique,
  raw_metadata jsonb,
  created_at timestamptz not null default now()
);

create index discount_auth_tenant_pending
  on discount_authorizations (tenant_slug, status, expires_at)
  where status = 'pending';
```

---

## 9. Fallback si el responsable no responde (TTL agotado)

Cuando `now() >= expires_at` y `status = 'pending'`, ejecutar el `on_timeout` configurado en `cfg.policies.discount_authorization.on_timeout`:

| `on_timeout` | Acción CORE | Mensaje al cliente |
|---|---|---|
| `escalate` | Disparar `escalar_humano` con `reason="discount_authorization_timeout"` y `reason_detail` incluyendo `quote_id` + `requested_max_pct`. El cliente entra a lockout. | Se compone como ack de escalación (ver `core/flows/escalation.spec.md` §5). |
| `decline` | Marcar autorización como `rejected` con `resolved_outcome="timeout_decline"`. Continuar con cotización sin descuento (flujo §6 caso rechazo). | "Quedó la cotización en {{currency}} {{grand_total}} sin descuento. {{primary_contact_name}} no pudo confirmarme a tiempo. ¿Avanzamos así o prefieres que ajustemos algo?" |
| `ask_client_to_wait` | NO escalar. Resetear el TTL una vez más (segundo intento, hasta máximo 2 intentos totales — CORE hard cap). Reenviar el outbound al responsable con flag "segundo intento". | "{{primary_contact_name}} aún no me confirma. ¿Prefieres esperar otros {{ttl_min}} min o que avancemos sin descuento por ahora?" — el siguiente turno del cliente decide. Si el cliente dice "sin descuento" → flujo §6 caso rechazo. Si dice "espero" → segundo intento. |

**Hard cap CORE inviolable:** máximo 2 intentos totales por cotización con `ask_client_to_wait`. Tras el segundo timeout, se fuerza `decline` automáticamente (no se permite re-configurar a infinitos retries). Razón: defensa contra dejar al cliente eterno en limbo.

---

## 10. Errores específicos

| Código | Cuándo | Acción |
|---|---|---|
| `DISCAUTH_NOTIFY_FAILED` | Outbound al responsable no se entregó | Reintentar 1x con backoff 30s. Si falla otra vez, ejecutar `on_timeout` directamente. |
| `DISCAUTH_AMBIGUOUS_TWICE` | Parser no pudo interpretar tras 2 intentos | Ejecutar `on_timeout`; loguear texto recibido para mejora del parser. |
| `DISCAUTH_RESPONSE_FROM_WRONG_NUMBER` | Un mensaje WhatsApp llegó de un número distinto al `notify_target` y matcheó la heurística | NO usar como respuesta. Persistir como evento auditable. El responsable real sigue siendo el único válido. |
| `DISCAUTH_QUOTE_NOT_FOUND` | Llega respuesta pero el `quote_id` referenciado no existe | Loguear; ignorar mensaje. |
| `DISCAUTH_POLICY_MISSING` | `cfg.policies.discount_authorization` es null y `cotizar` necesita disparar el flow | Usar defaults CORE: `consultation_ttl_min=30`, `on_timeout="ask_client_to_wait"`. Warning a logs. |
| `DISCAUTH_CONCURRENT` | El cliente solicita un segundo descuento sobre otra cotización mientras hay una pendiente | Rechazar el segundo con mensaje del agente: "Déjame primero confirmar el descuento de la cotización anterior; en cuanto resuelva, vemos el siguiente". Persistir como evento auditable. |

---

## 11. Auditoría

Cada flow queda con trazabilidad completa:
- Row en `discount_authorizations` con todos los timestamps.
- Span en Langfuse del turn que disparó la `cotizar` con descuento, vinculado por `quote_id`.
- Outbound al responsable persistido en `discount_authorizations.raw_metadata.notify_payload`.
- Respuesta del responsable persistida en `discount_authorizations.response_raw`.
- Turno de reanudación al cliente marcado con flag `raw_metadata.is_discount_authorization_resume = true`.

---

## 12. Auditoría R1/R2 sobre este spec

- **R1 (sin literales de un cliente concreto):** ningún nombre de empresa, marca, ciudad o persona de un cliente real aparece en este archivo. Los placeholders son `{{primary_contact_name}}`, `{{currency}}`, etc. — sustantivos del dominio "PyME comercial". Cumple.
- **R2 (no `import` desde `clients/`):** este flow consume su configuración exclusivamente vía `cfg.policies.discount_authorization`, `cfg.meta.primary_contact`, `cfg.policies.escalation.notify` — todos provistos por `core/utils/config_loader.spec.md`. Cero rutas hardcodeadas a `clients/`. Cumple.

---

## 13. Ajustes pendientes en specs previos

1. **`core/utils/config_loader.spec.md` §3:** añadir `policies.discount_authorization: DiscountAuthorizationPolicy` tipado (campos `consultation_ttl_min: int`, `on_timeout: enum`, `notify_target: str | None`, `context_to_share: dict | None`). Eliminar el antiguo `DiscountPolicy` con tope autónomo.
2. **`core/utils/schema/client_config.schema.json`:** añadir el sub-schema `DiscountAuthorizationPolicy` con validaciones (`consultation_ttl_min: int >= 1 && <= 1440`, `on_timeout: enum["escalate","decline","ask_client_to_wait"]`).
3. **`infra/supabase/migrations/000X_discount_authorization.sql`:** crear tabla `discount_authorizations` (DDL §8) y migración del enum de `conversations.status` para añadir `'awaiting_discount_authorization'`.
4. **`docs/core_invariant.md` §5.1:** reformular para reflejar que `autonomy_pct = 0` es CORE inviolable y la consulta puntual no equivale a escalación (no hay lockout 48h).
5. **`docs/core_invariant.md` §5 (caso nuevo §5.17 propuesto):** "Distinción `discount_authorization` vs `escalation`: la consulta puntual de descuento NO escala la conversación; mantiene al cliente en estado `awaiting_discount_authorization` con TTL de minutos. Solo cae a `escalation` si `on_timeout=\"escalate\"` y se agota el TTL." Este caso queda registrado por el PM al actualizar §3 y §5.11-5.17 (no se hace en este sprint).
6. **`core/flows/escalation.spec.md` §2.2:** la fila "Descuento sobre política → discount_above_policy" debe eliminarse; el descuento ya no dispara escalación automática (solo el timeout de la autorización con `on_timeout=escalate`, que es razón `discount_authorization_timeout`).
7. **`core/prompts/system_template.spec.md`:** ajustar instrucciones al LLM para reflejar el nuevo patrón asíncrono (ver §10.7 de `cotizar.spec.md`).
8. **`core/flows/i18n/` (nuevo subdir):** crear plantillas `discount_authorization_request_es.txt`, `discount_authorization_ack_es.txt`, `discount_authorization_resume_es.txt`, `discount_response_keywords_es.json`. Quedan como TODO de implementación, no se materializan en este spec.
9. **`core/utils/config_loader.spec.md` §3.1 (extensión 2026-05-24):** `DiscountAuthorizationPolicy` añade campo `segment_overrides: dict[str, SegmentDiscountOverride] | None = None` (mecanismo CORE para §5.5; valores por-cliente). Default `None` → comportamiento idéntico al original (consultar siempre).
10. **`core/utils/schema/client_config.schema.json` (extensión 2026-05-24):** `$defs.DiscountAuthorizationPolicy` añade propiedad `segment_overrides` (objeto opcional con `additionalProperties` tipados como `SegmentDiscountOverride`).
11. **`core/flows/i18n/discount_authorization_segment_decline_es.txt` (nuevo):** fallback CORE para §5.5.5 cuando el `decline_message_template` del cliente queda vacío o falla. TODO de implementación.
12. **`infra/supabase/migrations/000Y_discount_authorization_segment_blocked.sql` (nueva migración):** extender el enum `discount_authorizations.status` con el valor `'segment_blocked'`. Bloqueante para Sem 5 si se va a implementar §5.5.

