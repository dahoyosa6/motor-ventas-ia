# Spec: flow `core/flows/escalation` — escalación a humano

> **Owner técnico:** `core-architect`
> **Estado:** spec — pendiente de implementación (Sem 5).
> **Aplica a:** Sem 5 (motor runtime).
> **Fuentes de verdad:** `core/tools/escalar_humano.spec.md` (la tool) · `core/tools/contracts.spec.md` · `core/data_model/turn_envelope.spec.md` (campo `escalation` del response).

---

## 1. Para qué existe este flow

La tool `escalar_humano` define **el verbo** (cómo se persiste, cómo se notifica). Este flow define **el contexto operativo**:

- Cuándo se dispara automáticamente (sin que el LLM la invoque).
- A quién, en qué canal, con qué mensaje.
- Qué ve el cliente mientras espera.
- Cuándo termina el lockout y el agente puede volver.

Es la diferencia entre "tener un botón de escalar" y "operar con discipline una transferencia humana".

---

## 2. Disparadores

### 2.1. Disparadores explícitos (el LLM llama `escalar_humano`)

El system prompt instruye al LLM a llamar la tool cuando:
- El cliente pide hablar con una persona (independiente de palabra exacta).
- Detecta una pregunta fuera del alcance comercial (devoluciones, queja garantía, RR.HH., legal).
- Detecta sentimiento muy negativo o lenguaje hostil.
- Necesita una autorización que no tiene (descuento > política, condición especial).

### 2.2. Disparadores automáticos (orquestador, sin LLM)

| Disparador | Detalle | `reason` |
|---|---|---|
| **Keyword del cliente** | El texto entrante matchea (case-insensitive, palabra completa) el set CORE `{"AGENTE","HUMANO","ASESOR","PERSONA"}` ∪ `cfg.policies.escalation.keywords` | `customer_requests_human` |
| **Keyword nominal del cliente** | El texto contiene el nombre del contacto primario del cliente (`cfg.meta.primary_contact.name`) en frases como "quiero hablar con X". El motor escapa el nombre y matchea como palabra. | `customer_requests_human` |
| **N retries fallidos** | Misma tool falla 3 veces en la misma conversación dentro de 5 min | `tool_failure_3_attempts` |
| **Latencia excedida** | Cualquier turno excede `budget.timeout_ms * 3` (15s default) | `tool_failure_3_attempts` |
| **Stock crítico de SKU bandera** | `consultar_stock` retorna `agotado` para SKU marcado como bandera en `cfg.policies.stock_thresholds.banderas` | `stock_critical` |
| **Regla dura** | `consultar_stock` retorna `policy_flags` con `siempre_escala_humano` | `policy_hard_rule_triggered` |
| **Bucle conversacional** | El agente emite 3 turnos consecutivos sin avance (mismas tool calls, similitud texto > 0.9) | `complex_question` |

> **Nota — descuentos no disparan escalación directa.** Cualquier solicitud de descuento del cliente se canaliza por el flow asíncrono `discount_authorization` (ver `core/flows/discount_authorization.spec.md`), que consulta puntualmente al responsable sin bloquear la conversación. El descuento solo cae a escalación si la autorización agota su TTL y la política del cliente tiene `on_timeout="escalate"`; en ese caso se materializa como `reason="discount_authorization_timeout"` (definido en `core/tools/escalar_humano.spec.md`).

**Reglas de prioridad si varios disparan simultáneamente:** se queda la de prioridad más alta (`urgent > high > normal > low`). Las demás se anotan como `reason_detail`.

### 2.3. Anti-trigger (cuando NO escalar aunque parezca)

- Si el cliente solo pregunta "¿con quién hablo?" → respuesta es disclosure, NO escalación.
- Si la tool falla pero el LLM ya pivotó con éxito (siguiente turno OK), el contador de retries se resetea.

---

## 3. A quién se notifica

Notificación va al **responsable on-call del tenant**:

```yaml
# clients/<tenant>/policies/escalation.yaml  (CONFIG — shape sugerido)
version: 1.0
keywords: ["DUENO", "JEFE"]          # keywords adicionales a las CORE
notify:
  channel: whatsapp                    # whatsapp | email | slack | webhook
  primary:
    target: "+52XXXXXXXXXX"            # E.164
    name: "Nombre del contacto"
  on_call_rotation:                    # opcional, Sem 7+
    - { weekday: mon-fri, hours: "08:00-18:00", target: "+52XXX" }
    - { weekday: sat,     hours: "08:00-14:00", target: "+52YYY" }
    - { default: true,                 target: "+52ZZZ" }       # fuera de horario
group_target: null                     # opcional, grupo WA o canal Slack
sla_business_hours: "en los próximos 15 minutos"
sla_after_hours: "mañana antes de las 10:00"
hours:
  monday:    "08:00-18:00"
  tuesday:   "08:00-18:00"
  wednesday: "08:00-18:00"
  thursday:  "08:00-18:00"
  friday:    "08:00-18:00"
  saturday:  "08:00-14:00"
  sunday:    null                       # cerrado
timezone: "America/Mexico_City"         # fallback si difiere de cfg.meta.timezone
```

**Mecanismo de resolución del target (CORE):**

1. Si `on_call_rotation` definida → buscar slot que cubra `now_iso` en zone del tenant.
2. Si no hay slot que cubra → `notify.primary.target`.
3. Si `group_target` definido → notificar también al grupo (paralelo, no sustituye al individual).

El responsable on-call recibe un mensaje formateado (ver §4). El cliente recibe el ack (ver §5).

---

## 4. Mensaje al humano (formato CORE)

Mismo template para todas las escalaciones del tenant (paramétrico):

```
[Escalación {reason}] {priority}
Tenant: {tenant.display_name}
Cliente: {customer.display_name or customer.identifier}
Conversación: {conversation_id_short}
Disparado por: {triggered_by}        # agent / auto_rule / customer_keyword
{reason_detail}

Último mensaje del cliente:
"{snippet_to_share}"

Abrir: {dashboard_url}#/conversations/{conversation_id}
```

`dashboard_url` viene de env var del runtime (no del config del cliente — es del producto). Si no hay dashboard, se omite la línea.

**Por canal:**
- WhatsApp → un mensaje con el bloque. Sin botones por ahora (HSM requiere preaprobación; Sem 7+).
- Email → asunto `[ESCALADO][{priority}] {tenant} – {reason}`.
- Slack → mismo bloque en formato `mrkdwn`.
- Webhook → JSON con todos los campos.

El template literal vive en `core/flows/i18n/human_notification_{lang}.txt`. Cliente NO puede reescribirlo (defensa contra ofuscar la razón de la escalación al humano).

---

## 5. Mensaje al cliente (ack) — formato y timing

### 5.1. Cuándo se envía

Se envía **antes** de retornar del turno actual. El cliente nunca queda sin respuesta tras un mensaje suyo. Si el ack falla (`ESC_ACK_FAILED` en `escalar_humano`), es bug crítico.

### 5.2. Cómo se compone

Plantillas (CORE) por idioma, parametrizadas con dos slots:
- `{{primary_contact_name}}` — del `cfg.meta.primary_contact.name`.
- `{{sla}}` — resultado de `render_sla()`.

Ejemplo es-MX (CORE):
> "Listo, te conecto con {{primary_contact_name}}. Te responde {{sla}}."

### 5.3. Lógica de `render_sla()` (CORE)

```python
def render_sla(escalation_cfg, now_iso, tenant_tz):
    now = parse(now_iso).astimezone(zone(tenant_tz))
    if within_business_hours(now, escalation_cfg.hours):
        return escalation_cfg.sla_business_hours   # ej. "en los próximos 15 minutos"
    else:
        return escalation_cfg.sla_after_hours      # ej. "mañana antes de las 10:00"
```

Reglas adicionales CORE (no calibrable):
- Si `now` es viernes después del cierre → "el lunes antes de las 10:00".
- Si el día siguiente es cerrado (sunday=null en hours) → saltar al próximo día abierto y ajustar el texto.
- Si el cliente está fuera de toda hora abierta y no hay `sla_after_hours` definido → fallback CORE "el siguiente día hábil".

**Razón de tenerlo CORE:** evita que cada cliente codifique mal "mañana"; el cálculo de "próximo día hábil" es trampa.

### 5.4. Lockout post-ack

Después del ack:
- `conversations.status = 'escalated'`.
- En los siguientes turnos del cliente en esta conversación, el orquestador retorna **silencio del agente** durante la ventana SLA: ningún mensaje generado.
  - Excepción: si pasa el SLA y nadie respondió, el orquestador envía un segundo ack "sigo intentando contactar a {{name}}" UNA sola vez.
- El lockout termina cuando un humano marca `escalations.resolved_at`. Entonces el agente vuelve a poder responder en esta conversación.

---

## 6. Fuera de horario

Política CORE: el cliente recibe el ack con `sla_after_hours` (config). El responsable on-call recibe la notificación igual, con prioridad ajustada:

- `priority: urgent` → notificar inmediato incluso fuera de horario.
- Otros → notificar inmediato, pero el cliente sabe que la respuesta es para el día siguiente.

Si el cliente NO declaró `sla_after_hours`, el motor usa el fallback CORE "el siguiente día hábil antes de las 10:00".

---

## 7. Resolución manual

Un humano marca la escalación resuelta vía:
- (Sem 5) Endpoint REST `POST /api/escalations/{id}/resolve` con `resolved_by` + nota.
- (Sem 7+) Dashboard.

Update aplicado:
- `escalations.resolved_at = now()`, `resolved_by = name`.
- `conversations.status = 'active'`.
- Si el humano marca `agent_can_resume = true` (default), el lockout termina.
- Si marca `agent_can_resume = false`, la conversación queda cerrada para el agente; humano la maneja sola.

---

## 8. Auditoría

Cada escalación queda con trazabilidad completa:
- Row en `escalations` con triggered_by_turn_id.
- Span en Langfuse del turn que la disparó.
- Notificación al humano queda persistida en `escalations.raw_metadata.notification`.
- Ack al cliente queda como `role='assistant'` row en `turns` con flag `raw_metadata.is_escalation_ack = true`.

---

## 9. Casos límite

| Caso | Política |
|---|---|
| Cliente envía mensaje durante el lockout | Persistir en `turns` (`role='user'`); NO responder. Notificación al humano "el cliente sigue escribiendo: '...'" (rate-limited: máximo 1 ping por cada 3 mensajes del cliente). |
| Cliente vuelve a usar keyword "AGENTE" durante el lockout | Idempotente (mismo `idempotency_key` por ventana 10min); ack al cliente "ya alerté a {{name}}, en camino." |
| Humano nunca resuelve | Pasadas 48h sin resolución, auto-cierre con `resolved_by='auto_timeout'` y notificación al admin del tenant. |
| Tenant sin `policies.escalation` definido | Defaults CORE: notify por WhatsApp a `cfg.meta.primary_contact.phone_e164`, SLA "lo antes posible". Warning en logs. |

---

## 10. Ajustes pendientes en specs previos

1. **`core/utils/config_loader.spec.md` §3:** añadir `policies.escalation: EscalationPolicy` tipado (espejo del shape de §3 de este spec). Ver también `core/prompts/system_template.spec.md` §11.1.
2. **`core/utils/schema/client_config.schema.json`:** añadir `paths.policies.escalation` (opcional, ruta relativa). Nota: en el tenant de referencia hoy ese key apunta a un archivo de umbrales de stock — naming inconsistente flagged en `config_loader.spec.md` §4 y §13. Resolver separando en dos paths del config (`paths.policies.escalation_sla` para escalación y `paths.policies.stock_thresholds` para stock). **Decisión propuesta:** dos paths distintos, no uno ambiguo.
3. **`docs/core_invariant.md` §5:** caso §5.17 — "Lockout post-escalación: el agente NO responde en una conversación con `status=escalated` hasta que un humano la resuelva o pasen 48h."
