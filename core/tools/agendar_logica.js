// agendar_logica — Lógica determinista de la tool `agendar`: validación de slot,
// llave de idempotencia y decisión de status según el resultado de Calendar +
// WhatsApp. CORE genérico: funciones puras, sin red, sin tokens, sin credenciales.
// Reutiliza el algoritmo y los errores de `core/tools/agendar.spec.md`.
//
// Mitiga FMECA #2 (RPN 256, evento huérfano): si Calendar quedó OK pero WhatsApp
// falló, NO se deja un evento confirmado que el cliente nunca recibió: status=error,
// revertRequired=true y escalación URGENTE para borrar/revertir el evento.
// Mitiga FMECA #5 (timezone): validarSlot exige timezone IANA.

const crypto = require('crypto');
const { exigirTimezoneIana, partesEnZona } = require('./disponibilidad');

function parseHoraHHMM(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) throw new Error(`HORA_INVALIDA: "${hhmm}" debe ser "HH:MM"`);
  return { hora: parseInt(m[1], 10), min: parseInt(m[2], 10) };
}

// validarSlot({slotStartIso, durationMin, businessHours, now, timezone})
//   → { ok: true } | { ok: false, error: 'APPT_SLOT_IN_PAST'|'APPT_SLOT_OUT_OF_HOURS' }
// businessHours: { 0..6: [{start,end}] | null } (0=domingo … 6=sábado).
function validarSlot(args) {
  const { slotStartIso, durationMin, businessHours, now, timezone } = args || {};
  const tz = exigirTimezoneIana(timezone);
  const inicio = new Date(slotStartIso);
  if (isNaN(inicio.getTime())) {
    throw new Error('SLOT_INVALIDO: slotStartIso debe ser una fecha ISO-8601 válida');
  }
  const duracion = Number(durationMin);
  if (!Number.isFinite(duracion) || duracion <= 0) {
    throw new Error('DURATION_INVALIDA: durationMin debe ser un entero positivo de minutos');
  }
  const ahora = now instanceof Date ? now : new Date(now);
  if (isNaN(ahora.getTime())) throw new Error('NOW_INVALIDO: now debe ser una fecha válida');

  // 1. No en el pasado.
  if (inicio.getTime() < ahora.getTime()) {
    return { ok: false, error: 'APPT_SLOT_IN_PAST' };
  }

  // 2. Dentro de business_hours (en la zona local del cliente).
  const bh = businessHours || {};
  const pIni = partesEnZona(inicio, tz);
  const fin = new Date(inicio.getTime() + duracion * 60000);
  const franjas = bh[pIni.weekday];
  if (!Array.isArray(franjas) || franjas.length === 0) {
    return { ok: false, error: 'APPT_SLOT_OUT_OF_HOURS' }; // día cerrado
  }
  // Minutos de pared desde medianoche, para inicio y fin.
  const minIni = pIni.hour * 60 + pIni.minute;
  const pFin = partesEnZona(fin, tz);
  // El fin debe caer el mismo día para considerarse dentro de horario.
  let minFin = pFin.hour * 60 + pFin.minute;
  if (pFin.ymd !== pIni.ymd) minFin = 24 * 60 + minFin; // cruzó medianoche → fuera

  const dentro = franjas.some((f) => {
    const fi = parseHoraHHMM(f.start);
    const ff = parseHoraHHMM(f.end);
    const inicioFranja = fi.hora * 60 + fi.min;
    const finFranja = ff.hora * 60 + ff.min;
    return minIni >= inicioFranja && minFin <= finFranja;
  });
  if (!dentro) return { ok: false, error: 'APPT_SLOT_OUT_OF_HOURS' };

  return { ok: true };
}

// idempotencyKey({tenantSlug, customerId, slotStartIso}) → sha256 hex.
// Determinista: misma entrada ⇒ misma llave. Normaliza el ISO a su instante UTC
// para que "10:00-06:00" y su equivalente Z produzcan la misma llave.
function idempotencyKey(args) {
  const { tenantSlug, customerId, slotStartIso } = args || {};
  if (!tenantSlug || !customerId || !slotStartIso) {
    throw new Error('IDEMPOTENCY_INPUT_INVALIDO: se requieren tenantSlug, customerId y slotStartIso');
  }
  const d = new Date(slotStartIso);
  if (isNaN(d.getTime())) throw new Error('SLOT_INVALIDO: slotStartIso no es una fecha válida');
  const base = `${tenantSlug}|${customerId}|${d.toISOString()}`;
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

// decidirStatus({calendarOk, whatsappOk}) → estado final de la cita + acciones.
// Materializa el algoritmo de agendar.spec.md §5 + mitigación FMECA #2.
function decidirStatus(args) {
  const { calendarOk, whatsappOk } = args || {};
  const cal = calendarOk === true;
  const wa = whatsappOk === true;

  if (cal && wa) {
    // Caso feliz.
    return { status: 'confirmed', revertRequired: false, fallbackRequired: false };
  }
  if (!cal && wa) {
    // Calendar caído pero el cliente SÍ recibió el ack: la promesa se mantiene,
    // un humano sincroniza Calendar (escalación informativa, no urgente).
    return {
      status: 'tentative_calendar_pending',
      revertRequired: false,
      fallbackRequired: true,
      escalation: 'calendar_sync_fallback',
    };
  }
  if (cal && !wa) {
    // EVENTO HUÉRFANO (FMECA #2): hay evento en el calendario pero el cliente NUNCA
    // recibió confirmación. Hay que revertir el evento y escalar URGENTE.
    return {
      status: 'error',
      revertRequired: true,
      fallbackRequired: false,
      escalation: 'whatsapp_failed_revert_urgent',
    };
  }
  // Nada funcionó: error, sin evento que revertir.
  return {
    status: 'error',
    revertRequired: false,
    fallbackRequired: false,
    escalation: 'whatsapp_failed_revert_urgent',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validarSlot, idempotencyKey, decidirStatus };
}
