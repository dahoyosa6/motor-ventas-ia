// disponibilidad — Cálculo determinista de slots libres a partir de un FreeBusy
// (formato Google) + asignación de vendedor (round-robin con zona y carga).
// CORE genérico: función pura, sin red, sin tokens, sin credenciales. La lectura
// real del calendario la hace la capa de integración y se INYECTA como dato.
//
// Mitiga FMECA #5 (RPN 192, timezone/DST): se EXIGE timezone IANA (ej.
// "America/Mexico_City"); un offset suelto ("-06:00", "+05:30") lanza error.
// Mitiga FMECA #6 (RPN 189): el agente solo puede ofrecer los slots que esta
// función devuelve; nunca inventa horas.
//
// businessHours: { 0..6: [{start:"HH:MM", end:"HH:MM"}, ...] | null }
//   índice 0 = domingo, 1 = lunes, ... 6 = sábado (igual que Date.getDay()).
//   null o [] = día cerrado.
// freebusy: lista de intervalos ocupados [{start:ISO, end:ISO}, ...] (formato
//   Google freebusy: cada item con `start`/`end` ISO-8601).

// --- utilidades de timezone IANA --------------------------------------------

// Valida que `tz` sea un identificador IANA real. Rechaza offsets sueltos
// ("-06:00", "UTC+5") y zonas inexistentes. Lanza si no es válido.
function exigirTimezoneIana(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') {
    throw new Error('TIMEZONE_INVALIDO: se requiere un timezone IANA (ej. "America/Mexico_City")');
  }
  // Un offset suelto o "UTC±X" no es una zona IANA: rechazar explícitamente.
  if (/^[+-]\d{1,2}(:?\d{2})?$/.test(tz.trim()) || /^UTC[+-]/i.test(tz.trim())) {
    throw new Error(`TIMEZONE_INVALIDO: "${tz}" es un offset suelto; se requiere timezone IANA (ej. "America/Mexico_City")`);
  }
  try {
    // Si la zona no existe, Intl lanza RangeError.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (e) {
    throw new Error(`TIMEZONE_INVALIDO: "${tz}" no es un timezone IANA válido`);
  }
  return tz;
}

// Devuelve los campos de pared (año, mes, día, hora, min, día de la semana) de un
// instante `date` proyectado en la zona `tz`. Maneja DST porque usa Intl.
function partesEnZona(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const partes = {};
  for (const p of fmt.formatToParts(date)) partes[p.type] = p.value;
  const diasSemana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hora = parseInt(partes.hour, 10);
  if (hora === 24) hora = 0; // algunos entornos devuelven 24 a medianoche
  return {
    year: parseInt(partes.year, 10),
    month: parseInt(partes.month, 10),
    day: parseInt(partes.day, 10),
    hour: hora,
    minute: parseInt(partes.minute, 10),
    weekday: diasSemana[partes.weekday],
    ymd: `${partes.year}-${partes.month}-${partes.day}`,
  };
}

// Construye el instante UTC (Date) que en la zona `tz` corresponde a la hora de
// pared dada. Resuelve el offset real de esa fecha (respeta DST) iterando.
function instanteDesdeParedEnZona(year, month, day, hour, minute, tz) {
  // Primer estimado: tratar la pared como si fuera UTC.
  let ts = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Ajustar por el offset real de la zona en esa fecha (dos pasadas cubren DST).
  for (let i = 0; i < 2; i++) {
    const p = partesEnZona(new Date(ts), tz);
    const paredObtenida = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const paredDeseada = Date.UTC(year, month - 1, day, hour, minute, 0);
    const diff = paredDeseada - paredObtenida;
    if (diff === 0) break;
    ts += diff;
  }
  return new Date(ts);
}

function parseHoraHHMM(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) throw new Error(`HORA_INVALIDA: "${hhmm}" debe ser "HH:MM"`);
  return { hora: parseInt(m[1], 10), min: parseInt(m[2], 10) };
}

// ¿Se solapan [aStart,aEnd) y [bStart,bEnd)? (ms epoch).
function seSolapan(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// --- cálculo de slots -------------------------------------------------------

// calcularSlots({freebusy, businessHours, now, timezone, durationMin, dias, opts})
//   → [{ start_iso, end_iso, timezone, esManana }] ordenados con la MAÑANA primero.
// opts.stepMin: granularidad de inicio de slot (default = durationMin).
// opts.cutoffManana: hora local que separa mañana/tarde (default 12).
function calcularSlots(args) {
  const { freebusy, businessHours, now, timezone, durationMin, dias, opts } = args || {};
  const tz = exigirTimezoneIana(timezone);
  const duracion = Number(durationMin);
  if (!Number.isFinite(duracion) || duracion <= 0) {
    throw new Error('DURATION_INVALIDA: durationMin debe ser un entero positivo de minutos');
  }
  const ventanaDias = Number.isFinite(Number(dias)) ? Number(dias) : 7;
  const ahora = now instanceof Date ? now : new Date(now);
  if (isNaN(ahora.getTime())) throw new Error('NOW_INVALIDO: now debe ser una fecha válida');
  const o = opts || {};
  const stepMin = Number.isFinite(Number(o.stepMin)) && Number(o.stepMin) > 0 ? Number(o.stepMin) : duracion;
  const cutoffManana = Number.isFinite(Number(o.cutoffManana)) ? Number(o.cutoffManana) : 12;
  const bh = businessHours || {};

  // Ocupados → ms epoch para comparar.
  const ocupados = (Array.isArray(freebusy) ? freebusy : []).map((iv) => ({
    start: new Date(iv.start).getTime(),
    end: new Date(iv.end).getTime(),
  })).filter((iv) => !isNaN(iv.start) && !isNaN(iv.end));

  const partesAhora = partesEnZona(ahora, tz);
  const slots = [];

  for (let d = 0; d < ventanaDias; d++) {
    // Día calendario `d` contado desde hoy, en la zona local.
    const baseDia = instanteDesdeParedEnZona(
      partesAhora.year, partesAhora.month, partesAhora.day + d, 0, 0, tz,
    );
    const pDia = partesEnZona(baseDia, tz);
    const franjas = bh[pDia.weekday];
    if (!Array.isArray(franjas) || franjas.length === 0) continue; // día cerrado

    for (const franja of franjas) {
      const ini = parseHoraHHMM(franja.start);
      const fin = parseHoraHHMM(franja.end);
      const inicioFranja = instanteDesdeParedEnZona(pDia.year, pDia.month, pDia.day, ini.hora, ini.min, tz).getTime();
      const finFranja = instanteDesdeParedEnZona(pDia.year, pDia.month, pDia.day, fin.hora, fin.min, tz).getTime();

      for (let s = inicioFranja; s + duracion * 60000 <= finFranja; s += stepMin * 60000) {
        const slotStart = s;
        const slotEnd = s + duracion * 60000;
        if (slotStart < ahora.getTime()) continue; // pasado: excluir
        const choca = ocupados.some((iv) => seSolapan(slotStart, slotEnd, iv.start, iv.end));
        if (choca) continue;
        const pSlot = partesEnZona(new Date(slotStart), tz);
        slots.push({
          start_iso: new Date(slotStart).toISOString(),
          end_iso: new Date(slotEnd).toISOString(),
          timezone: tz,
          esManana: pSlot.hour < cutoffManana,
          _epoch: slotStart,
        });
      }
    }
  }

  // Orden: MAÑANA antes que tarde (prioriza mañana, FMECA #6 / plan §3);
  // dentro de cada grupo, cronológico.
  slots.sort((a, b) => {
    if (a.esManana !== b.esManana) return a.esManana ? -1 : 1;
    return a._epoch - b._epoch;
  });
  return slots.map(({ _epoch, ...rest }) => rest);
}

// --- asignación de vendedor -------------------------------------------------

// asignarVendedor({vendors, freebusyPorVendedor, zona, estrategia})
//   → vendedor elegido | null.
// - Ignora vendedores con activo:false.
// - Filtra por `zona` si se especifica (vendedores de esa zona).
// - estrategia 'round_robin' (default): desempata por menor carga_actual; si hay
//   empate, el primero por orden estable.
// - freebusyPorVendedor: opcional { [vendorId]: 'libre'|'ocupado' }; si un
//   vendedor está marcado 'ocupado' se descarta.
function asignarVendedor(args) {
  const { vendors, freebusyPorVendedor, zona } = args || {};
  if (!Array.isArray(vendors) || vendors.length === 0) return null;
  const ocupacion = freebusyPorVendedor || {};

  let candidatos = vendors.filter((v) => v && v.activo !== false);
  if (zona != null && zona !== '') {
    candidatos = candidatos.filter((v) => v.zona === zona);
  }
  // Descartar los marcados como ocupados.
  candidatos = candidatos.filter((v) => ocupacion[v.id] !== 'ocupado');
  if (candidatos.length === 0) return null;

  // Round-robin con desempate por carga: menor carga_actual gana; estable.
  candidatos = candidatos.slice().sort((a, b) => {
    const ca = Number.isFinite(Number(a.carga_actual)) ? Number(a.carga_actual) : 0;
    const cb = Number.isFinite(Number(b.carga_actual)) ? Number(b.carga_actual) : 0;
    return ca - cb;
  });
  return candidatos[0];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calcularSlots,
    asignarVendedor,
    exigirTimezoneIana, // exportado para tests
    partesEnZona,
  };
}
