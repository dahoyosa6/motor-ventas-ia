// anti_abuso_agendamiento — Compuerta determinista que decide si Saku puede
// OFRECER una visita de vendedor (recurso escaso) ante una intención de muestra.
// CORE genérico: función pura, sin red, sin tokens, sin credenciales. Los umbrales
// y límites llegan como CONFIG (parámetro `limites`), no se hardcodean.
//
// Mitiga el modo de falla FMECA #1 (RPN 315): la reserva de vendedor NUNCA se
// dispara desde el prompt; aquí, si faltan los datos mínimos de obra, se devuelve
// NEED_DATA antes de ofrecer ningún slot. Y el principio anti-abuso: un lead frío
// (cold) o sin necesidad real JAMÁS reserva vendedor automático (ruta suave).
//
// Salida: { decision: 'OFFER_VISIT'|'NEED_DATA'|'SOFT_PATH'|'DENY_LIMIT', reason: string }
// - OFFER_VISIT  → el lead califica y tiene datos: el agente ofrece slots reales.
// - NEED_DATA    → califica pero falta ubicación y/o producto: pedir antes de ofrecer.
// - SOFT_PATH    → no califica (frío o sin need real / sin autoridad ni plazo): ruta
//                  suave, un humano califica. NO se reserva vendedor automático.
// - DENY_LIMIT   → ya alcanzó el tope de citas del día (cap duro, gana a todo).
//
// Diseñado para correr en Node (module.exports) o pegado en un Code node de n8n.

function decidirOfertaVisita(input) {
  const inp = input || {};
  const bant = inp.bant || {};
  const stage = bant.stage;
  const needExplicito = inp.need_explicito === true;
  const authority = inp.authority === true;
  const timeline = inp.timeline === true;
  const datosObra = inp.datos_obra; // {ubicacion, producto} | null
  const citasHoy = Number(inp.citas_cliente_hoy);
  const limites = inp.limites || {};
  const maxCitasDia = Number(limites.max_citas_dia);

  // 1. LÍMITE DE CITAS POR CLIENTE/DÍA (cap duro: gana a todo lo demás).
  //    Si el config no trae un máximo válido, no se aplica el cap (no se inventa).
  if (Number.isFinite(maxCitasDia) && Number.isFinite(citasHoy) && citasHoy >= maxCitasDia) {
    return {
      decision: 'DENY_LIMIT',
      reason: `el cliente ya tiene ${citasHoy} cita(s) hoy (máximo ${maxCitasDia}); se coordina por la cita existente`,
    };
  }

  // 2. DATOS MÍNIMOS DE OBRA (mitiga FMECA #1 / RPN 315): sin ubicación o producto
  //    no se ofrece ningún slot. Se piden primero.
  const tieneUbicacion = !!(datosObra && datosObra.ubicacion);
  const tieneProducto = !!(datosObra && datosObra.producto);
  if (!tieneUbicacion || !tieneProducto) {
    const faltan = [];
    if (!tieneUbicacion) faltan.push('ubicación');
    if (!tieneProducto) faltan.push('producto');
    return {
      decision: 'NEED_DATA',
      reason: `faltan datos mínimos de obra (${faltan.join(' y ')}) antes de ofrecer una visita`,
    };
  }

  // 3. FRÍO O SIN NEED REAL NUNCA RESERVA VENDEDOR AUTOMÁTICO (ruta suave).
  if (stage === 'cold' || !needExplicito) {
    return {
      decision: 'SOFT_PATH',
      reason: stage === 'cold'
        ? 'lead frío: no reserva vendedor automático, un humano califica primero'
        : 'sin necesidad real explícita: no se reserva vendedor automático',
    };
  }

  // 4. UMBRAL DE CALIFICACIÓN — Need real + (Authority O Timeline).
  if (needExplicito && (authority || timeline)) {
    return {
      decision: 'OFFER_VISIT',
      reason: 'lead califica (need real + autoridad o plazo) y tiene datos de obra: se ofrecen slots',
    };
  }

  // 5. RESTO: tiene necesidad pero le falta autoridad y plazo → ruta suave.
  return {
    decision: 'SOFT_PATH',
    reason: 'necesidad real pero sin autoridad ni plazo: un humano califica antes de comprometer al vendedor',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decidirOfertaVisita };
}
