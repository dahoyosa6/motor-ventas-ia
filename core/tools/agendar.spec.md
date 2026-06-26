# Spec: tool `agendar`

> **Owner técnico:** `core-architect`
> **Estado:** spec — pendiente de implementación (Sem 5).
> **Aplica a:** Sem 5 (motor runtime). NO entra al POC Sem 3.
> **Fuentes de verdad:** `core/tools/contracts.spec.md` · decisión de producto 2026-05-22 (WhatsApp ack obligatorio incluso si Calendar falla).

---

## 1. Propósito

Crea una cita / reunión en el calendario primario del cliente y **confirma al usuario por WhatsApp como side-effect obligatorio**. Si el calendario falla, la confirmación WhatsApp se envía igual y se registra fallback para que un humano cierre el ciclo.

---

## 2. Descripción para el LLM

> "Agenda una cita en el calendario del negocio para un cliente. Devuelve confirmación con fecha, hora y enlace si aplica. Si el calendario está caído, igual confirmamos al cliente por WhatsApp con la fecha tentativa y dejamos pendiente la sincronización. Llámala solo cuando el cliente haya aceptado un slot explícito (no propongas sin antes confirmar con él)."

---

## 3. Input schema

```json
{
  "type": "object",
  "required": ["slot_start_iso", "duration_min", "purpose"],
  "properties": {
    "slot_start_iso": {
      "type": "string",
      "format": "date-time",
      "description": "Inicio de la cita en ISO-8601 con timezone (tipicamente cfg.meta.timezone)."
    },
    "duration_min": {
      "type": "integer",
      "minimum": 15,
      "maximum": 240,
      "default": 30
    },
    "purpose": {
      "type": "string",
      "enum": ["muestra_fisica", "visita_obra", "valoracion", "demo", "asesoria", "otro"],
      "description": "Categoría del encuentro. Vocabulario CORE; mapea a tipos genéricos de cita."
    },
    "purpose_detail": { "type": "string", "maxLength": 500 },
    "location_hint": {
      "type": "string",
      "description": "Dirección, sucursal o 'remoto'. La tool no valida disponibilidad espacial."
    },
    "attendees_extra": {
      "type": "array",
      "items": { "type": "string", "format": "email" },
      "description": "Emails adicionales a invitar (asesor humano, supervisor)."
    },
    "related_quote_id": {
      "type": "string",
      "description": "uuid de quote relacionada, si la cita surgió de una cotización."
    }
  }
}
```

**El `customer` se infiere del `ToolContext.customer_id`** (no se acepta del LLM por seguridad — evita que el agente agende para otro cliente por confusión).

---

## 4. Output schema (`data`)

```json
{
  "type": "object",
  "required": ["appointment_id", "status", "slot"],
  "properties": {
    "appointment_id":     { "type": "string", "description": "uuid v4 del row en `appointments`" },
    "status":             { "enum": ["confirmed", "tentative_calendar_pending"] },
    "slot": {
      "type": "object",
      "properties": {
        "start_iso":  { "type": "string", "format": "date-time" },
        "end_iso":    { "type": "string", "format": "date-time" },
        "timezone":   { "type": "string" }
      }
    },
    "calendar_sync": {
      "type": "object",
      "properties": {
        "provider":         { "enum": ["google", "outlook", "none"] },
        "external_event_id":{ "type": ["string","null"] },
        "synced":           { "type": "boolean" },
        "sync_error":       { "type": ["string","null"] }
      }
    },
    "whatsapp_confirmation": {
      "type": "object",
      "properties": {
        "sent":             { "type": "boolean" },
        "wamid":            { "type": ["string","null"] },
        "template_used":    { "type": "string" },
        "send_error":       { "type": ["string","null"] }
      }
    },
    "fallback_required": {
      "type": "boolean",
      "description": "true si calendar_sync.synced=false. Humano debe sincronizar a mano."
    }
  }
}
```

**`summary`:**
- Caso feliz: `"Cita confirmada para {dia} {hora} con {customer}. Invitación enviada por WhatsApp."`
- Calendar caído: `"Cita confirmada al cliente por WhatsApp para {dia} {hora}. Pendiente sincronizar Calendar (humano)."`

---

## 5. Algoritmo (orden no negociable)

```
1. Validar slot (no en pasado, dentro de business_hours del cliente).
2. Persistir row en `appointments` con status='tentative'.
3. Intentar Google Calendar create_event:
   3a. Si OK → status='confirmed', external_event_id guardado.
   3b. Si FAIL → status='tentative_calendar_pending', sync_error guardado.
4. Enviar WhatsApp confirmation usando template HSM aprobado:
   4a. Si OK → whatsapp_confirmation.sent=true.
   4b. Si FAIL → loguear; status final = 'error' (este sí es bloqueante).
5. Si calendar falló y whatsapp OK → fallback_required=true, además
   crear row en `escalations` con reason='calendar_sync_fallback' (informativo,
   no urgente — el humano lo procesa en horario).
6. Retornar.
```

**Decisión de producto (2026-05-22):** el paso 4 (WhatsApp ack) **es obligatorio incluso si el paso 3 falla**. Razón: la promesa al cliente vale más que la sincronización interna. Un cliente que recibe "te confirmo la cita el martes 10:00" tiene certeza; si Calendar luego no aparece, lo arregla un humano sin romper la promesa.

Esto se materializa en código como: **un fallo en el paso 3 NO aborta el paso 4**. Solo un fallo en el paso 4 retorna `status=error` global.

---

## 6. Persistencia

```sql
appointments (
  id uuid pk,
  tenant_slug text not null,
  conversation_id uuid references conversations(id),
  customer_id uuid references customers(id),
  status enum('tentative','confirmed','tentative_calendar_pending','cancelled','no_show','completed'),
  slot_start_iso timestamptz not null,
  slot_end_iso   timestamptz not null,
  timezone text not null,
  purpose text not null,
  purpose_detail text,
  location_hint text,
  calendar_provider text,
  external_event_id text,
  calendar_sync_error text,
  whatsapp_wamid text,
  whatsapp_template text,
  whatsapp_send_error text,
  fallback_required boolean default false,
  related_quote_id uuid,
  idempotency_key text unique,
  raw_metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
```

---

## 7. Errores específicos

| Código | Cuándo | Acción |
|---|---|---|
| `APPT_SLOT_IN_PAST` | `slot_start_iso` < now | `status=error`; reformular |
| `APPT_SLOT_OUT_OF_HOURS` | Fuera de `cfg.business_hours` | `status=error`; agente propone otro slot |
| `APPT_CALENDAR_UNAVAILABLE` | Google Calendar timeout/5xx | NO aborta — sigue al paso 4; output con `fallback_required=true` |
| `APPT_WHATSAPP_FAILED` | Send WhatsApp falla | `status=error`; el agente debe escalar para que un humano contacte |
| `APPT_TEMPLATE_NOT_APPROVED` | El template HSM no existe en `cfg.channels.whatsapp.templates` | `status=error`; bug de configuración del cliente, escalar |
| `TOOL_TENANT_MISMATCH` | (genérico) | Abortar |

---

## 8. Idempotencia

`idempotency_key = sha256(tenant_slug + customer_id + slot_start_iso)`. Una segunda llamada con la misma key retorna el row existente sin reescribir Calendar ni WhatsApp.

---

## 9. Templates de WhatsApp

El template usado es **CONFIG del cliente** (cada tenant registra sus HSM en Meta). El motor invoca por **nombre lógico**, p.ej. `appointment_confirmation_v1`, y el conector lo resuelve a su template ID via `cfg.channels.whatsapp.templates`.

Mecanismo (resolución del template lógico → ID Meta) es CORE. El catálogo de templates es CONFIG.

**Ajuste pendiente §10.2:** añadir `cfg.channels.whatsapp.templates: dict[str, str]` (logical_name → meta_template_id) al `ClientConfig`.

---

## 10. Ajustes pendientes en specs previos

1. **`infra/supabase/migrations/000X_quotes_appointments.sql`:** crear tabla `appointments` (DDL en §6).
2. **`core/utils/config_loader.spec.md` §3:** añadir `channels.whatsapp.templates: dict[str, str]` y `business_hours: BusinessHours` (parseado de `clients/<slug>/policies/business_hours.yaml`).
3. **`core/utils/schema/client_config.schema.json`:** añadir `paths.policies.business_hours` (opcional, ruta relativa) y la sub-clave de templates.
4. **`docs/core_invariant.md` §5:** caso §5.15 nuevo — "WhatsApp ack en `agendar` es obligatorio incluso si Calendar falla. Decisión de producto 2026-05-22."
