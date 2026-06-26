// calendar_payload — Builders puros del JSON que se enviaría a Google Calendar.
// CORE genérico: funciones puras, sin red, sin tokens, sin credenciales. NO llaman
// a la API; solo arman el cuerpo de la petición para que la capa de integración
// (n8n / HTTP) la ejecute. Así son testeables con `node` sin infraestructura.
//
// Se EXIGE timezone IANA (mitiga FMECA #5 / RPN 192): un offset suelto lanza error.

const { exigirTimezoneIana } = require('./disponibilidad');

// construirFreebusyQuery({calendarIds, timeMin, timeMax, timezone})
//   → cuerpo para POST https://www.googleapis.com/calendar/v3/freeBusy
function construirFreebusyQuery(args) {
  const { calendarIds, timeMin, timeMax, timezone } = args || {};
  const tz = exigirTimezoneIana(timezone);
  if (!Array.isArray(calendarIds) || calendarIds.length === 0) {
    throw new Error('CALENDAR_IDS_VACIO: se requiere al menos un calendarId');
  }
  if (!timeMin || !timeMax) {
    throw new Error('RANGO_INVALIDO: se requieren timeMin y timeMax (ISO-8601)');
  }
  return {
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    timeZone: tz,
    items: calendarIds.map((id) => ({ id })),
  };
}

// construirEventoInsert({appt, vendor, customer, timezone})
//   → cuerpo para POST .../calendars/{calendarId}/events?sendUpdates=all
// appt: { slot_start_iso, slot_end_iso, purpose, purpose_detail, location_hint }
// vendor: { nombre, email_calendar, calendar_id }
// customer: { nombre, telefono, email? }
function construirEventoInsert(args) {
  const { appt, vendor, customer, timezone } = args || {};
  const tz = exigirTimezoneIana(timezone);
  if (!appt || !appt.slot_start_iso || !appt.slot_end_iso) {
    throw new Error('APPT_INVALIDO: se requieren slot_start_iso y slot_end_iso');
  }
  const v = vendor || {};
  const c = customer || {};

  const nombreCliente = c.nombre || 'Cliente';
  const summary = `Muestra Saku — ${nombreCliente}`;
  const partesDescripcion = [];
  if (appt.purpose) partesDescripcion.push(`Propósito: ${appt.purpose}`);
  if (appt.purpose_detail) partesDescripcion.push(`Detalle: ${appt.purpose_detail}`);
  if (c.telefono) partesDescripcion.push(`Tel. cliente: ${c.telefono}`);
  if (v.nombre) partesDescripcion.push(`Vendedor: ${v.nombre}`);

  // Attendees: siempre el vendedor; el cliente solo si tiene email.
  const attendees = [];
  if (v.email_calendar) attendees.push({ email: v.email_calendar, responseStatus: 'accepted' });
  if (c.email) attendees.push({ email: c.email });

  return {
    // calendarId al que se inserta (el del vendedor elegido).
    calendarId: v.calendar_id || v.email_calendar || 'primary',
    sendUpdates: 'all',
    requestBody: {
      summary,
      location: appt.location_hint || '',
      description: partesDescripcion.join('\n'),
      start: { dateTime: new Date(appt.slot_start_iso).toISOString(), timeZone: tz },
      end: { dateTime: new Date(appt.slot_end_iso).toISOString(), timeZone: tz },
      attendees,
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { construirFreebusyQuery, construirEventoInsert };
}
