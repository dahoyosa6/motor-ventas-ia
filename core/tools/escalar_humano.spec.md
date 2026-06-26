# Spec: tool `escalar_humano`

> **Owner técnico:** `core-architect`
> **Estado:** spec — pendiente de implementación (Sem 5).
> **Aplica a:** Sem 5 (motor runtime).
> **Fuentes de verdad:** `core/tools/contracts.spec.md` · `core/flows/escalation.spec.md` · `infra/supabase/migrations/0001_init.sql` tabla `escalations`.

---

## 1. Propósito

Transfiere la conversación a un humano. Persiste un row en `escalations`, dispara la notificación al responsable on-call y envía al cliente un acuse (texto compuesto desde la política del cliente).

Es **simétrica**: el agente puede llamarla explícitamente, o el orquestador puede invocarla automáticamente por reglas (ver `core/flows/escalation.spec.md`).

---

## 2. Descripción para el LLM

> "Transfiere la conversación a un asesor humano. Úsala cuando: (a) el cliente pide hablar con una persona, (b) la pregunta excede tu capacidad, (c) la operación requiere una autorización que no tienes, (d) detectas frustración o queja seria, (e) una herramienta ha fallado repetidamente. Indica la razón con la lista permitida. Después de invocarla, el cliente recibe un acuse automático; tú no debes seguir respondiendo en esta conversación hasta que el asesor te libere."

---

## 3. Input schema

```json
{
  "type": "object",
  "required": ["reason"],
  "properties": {
    "reason": {
      "type": "string",
      "enum": [
        "customer_requests_human",
        "stock_critical",
        "discount_authorization_timeout",
        "complex_question",
        "tool_failure_3_attempts",
        "complaint_or_anger",
        "out_of_scope",
        "calendar_sync_fallback",
        "policy_hard_rule_triggered",
        "manual_unknown"
      ]
    },
    "reason_detail": {
      "type": "string",
      "maxLength": 500,
      "description": "Texto libre que el agente añade para contextualizar al humano (qué dijo el cliente, qué intentó la tool, etc.)."
    },
    "priority": {
      "type": "string",
      "enum": ["low", "normal", "high", "urgent"],
      "default": "normal"
    },
    "snippet_to_share": {
      "type": "string",
      "maxLength": 1000,
      "description": "Opcional. El último mensaje del cliente o un resumen, para incluir en la notificación al humano."
    }
  }
}
```

---

## 4. Output schema (`data`)

```json
{
  "type": "object",
  "required": ["escalation_id", "ack_text_to_customer", "notification"],
  "properties": {
    "escalation_id": { "type": "string", "description": "uuid del row en `escalations`" },
    "ack_text_to_customer": {
      "type": "string",
      "description": "Texto compuesto que YA se envió al cliente (o que el orquestador debe enviar)."
    },
    "notification": {
      "type": "object",
      "properties": {
        "channel":         { "enum": ["whatsapp","email","slack","webhook"] },
        "target":          { "type": "string", "description": "número, email, channel id" },
        "sent":            { "type": "boolean" },
        "sent_at":         { "type": ["string","null"], "format": "date-time" },
        "delivery_error":  { "type": ["string","null"] }
      }
    },
    "conversation_locked": {
      "type": "boolean",
      "description": "true si la conversación queda marcada `status='escalated'` y el agente no debe responder más turnos."
    }
  }
}
```

**`summary`:** `"Escalado por {reason}; asesor {target} notificado. Cliente confirmado con SLA {sla}."`

---

## 5. Side-effects

1. Insert en `escalations` (`tenant_slug`, `conversation_id`, `reason`, `triggered_by_turn_id`, `created_at`).
2. Update `conversations.status` → `'escalated'` (futuro `bant_state.notes` append).
3. Notificar al humano on-call (canal según `cfg.policies.escalation.notify`):
   - WhatsApp del responsable (default si `cfg.policies.escalation.notify.channel == "whatsapp"`).
   - Email / Slack / webhook según config.
4. Enviar `ack_text_to_customer` al cliente por el mismo canal del turno.
5. Marcar la conversación como **`conversation_locked=true`** durante la ventana SLA — el agente recibe `available_tools=[]` mientras tanto y no genera respuestas.

---

## 6. Composición del `ack_text_to_customer` (CORE + CONFIG)

```
ack = (
    template_base[lang]
      .replace("{{primary_contact_name}}", cfg.meta.primary_contact.name)
      .replace("{{sla}}", render_sla(cfg.policies.escalation, now=ctx.now_iso))
)
```

Donde `template_base[lang]` (CORE) es algo como:
> "Listo, te conecto con {{primary_contact_name}}. Te responde {{sla}}."

Variantes por idioma viven en `core/flows/i18n/escalation_ack_{lang}.txt`. El texto del ack **NO es totalmente reescribible por el cliente** — solo nombre y SLA. Razón: garantizar que la promesa al cliente sea consistente y auditable (defensa contra "olvidé poner el SLA en la plantilla").

`render_sla()` decide entre `sla_business_hours` y `sla_after_hours` según `ctx.now_iso` y `cfg.policies.escalation.hours`. Es CORE (mecanismo).

---

## 7. Errores específicos

| Código | Cuándo | Acción |
|---|---|---|
| `ESC_NOTIFY_FAILED` | Notificación al humano no se entregó | Row escalation se persiste igual; `notification.sent=false` con `delivery_error`. NO bloquea; un job periódico reintenta. Ack al cliente se envía con disclaimer ("ya alerté al equipo, te responderemos a la brevedad"). |
| `ESC_ACK_FAILED` | Ack al cliente no se envió | `status=error`; el cliente quedó sin respuesta. Esto sí es bloqueante (situación silenciosa peor que escalación abierta). |
| `ESC_DUPLICATE` | Misma razón + conversación ya escalada en últimos 10 min | Retorna el row existente (idempotente); no re-notifica al humano. |
| `ESC_POLICY_MISSING` | `cfg.policies.escalation` es null | Usar defaults CORE: notificar a `cfg.meta.primary_contact.phone_e164` por WhatsApp, SLA "lo más pronto posible"; warning a logs. |
| `TOOL_TENANT_MISMATCH` | (genérico) | Abortar |

---

## 8. Idempotencia

`idempotency_key = sha256(tenant_slug + conversation_id + reason + truncated_ts(10min))`.

Ventana 10 min: si el agente y una regla automática llaman al mismo tiempo por la misma razón, solo se ejecuta una vez.

---

## 9. Razones tipadas — semántica

| Reason | Disparado por | Prioridad sugerida |
|---|---|---|
| `customer_requests_human` | Agente (cliente dijo keyword o lo pidió explícito) o auto (keyword match) | high |
| `stock_critical` | Tool `consultar_stock` retorna `agotado` para SKU bandera del cliente o `policy_flags` incluye `siempre_escala_humano` | high |
| `discount_authorization_timeout` | Flow `discount_authorization` agotó el TTL sin respuesta del responsable Y `on_timeout="escalate"` en `cfg.policies.discount_authorization`. Caso edge: no es lo normal — lo normal es que el responsable conteste y la conversación reanude sin escalar. Ver `core/flows/discount_authorization.spec.md` §5. | normal |
| `complex_question` | Agente cuando no encuentra respuesta tras intentar `consultar_catalogo` 2x | normal |
| `tool_failure_3_attempts` | Auto: 3 fallos consecutivos de la misma tool en la conversación | high |
| `complaint_or_anger` | Agente cuando detecta sentimiento muy negativo / palabras de queja | urgent |
| `out_of_scope` | Agente cuando la pregunta no es de venta (devoluciones, queja garantía, RRHH) | normal |
| `calendar_sync_fallback` | Tool `agendar` cuando Calendar falla pero WhatsApp OK | low |
| `policy_hard_rule_triggered` | Tool `consultar_stock` cuando policy_flag obliga (ej. COPE industrial — concepto del cliente) | high |
| `manual_unknown` | Fallback explícito; obliga al agente a poner `reason_detail` | normal |

---

## 10. Ajustes pendientes en specs previos

1. **`core/utils/config_loader.spec.md` §3:** añadir `policies.escalation: EscalationPolicy` tipado (campos: `notify` (NotifyConfig), `keywords: list[str]`, `sla_business_hours`, `sla_after_hours`, `hours` (BusinessHoursRef), `timezone`). Ver `core/prompts/system_template.spec.md` §11.1.
4. **Razón eliminada:** `discount_above_policy` ya no existe en el enum. La política de descuentos cambió a flow asíncrono (`core/flows/discount_authorization.spec.md`); la única ruta por la que un descuento llega a `escalar_humano` es el caso edge `discount_authorization_timeout` con `on_timeout="escalate"` configurado. Ver `core/tools/cotizar.spec.md` §5 y §10.6.
2. **`infra/supabase/migrations/000X_escalations_extras.sql`:** añadir columnas `priority text` y `notification_target text` a `escalations` (no bloqueante; pueden vivir en `raw_metadata` mientras).
3. **`docs/core_invariant.md` §5:** caso §5.15 — "El texto del ack al cliente en escalación es CORE compuesto; el cliente solo puede sustituir nombre del contacto y SLA. Espejo de la regla de composición de §5.11 (disclosure)."
