// resumen_muestras_dia — Arma el texto del resumen diario de muestras agendadas
// que se envía por WhatsApp al dueño del negocio al cierre del día. CORE genérico:
// función pura, sin red, sin tokens, sin credenciales. El envío real lo hace la
// capa de integración (cron n8n → WhatsApp).
//
// Regla (metodología §5.3): si NO hay citas, NO se envía (evitar ruido).
// Formato WhatsApp plano: sin markdown, sin asteriscos.

// formatResumenDiario({citas, fecha, negocio}) → { enviar: bool, texto: string }
// negocio: nombre del comercio (CONFIG del tenant); default genérico.
// cita: {
//   cliente, telefono?, hora,            // hora: "HH:MM" o etiqueta legible
//   ubicacion?, vendedor?,               // vendedor null/undefined → "por asignar"
//   stage?, score?,                      // BANT
//   estado?                              // tentativa / confirmada / pendiente sync
// }
function formatResumenDiario(args) {
  const { citas, fecha, negocio } = args || {};
  const lista = Array.isArray(citas) ? citas.slice() : [];
  const nombreNegocio = negocio || 'el negocio';

  // 0 citas → no enviar, texto vacío.
  if (lista.length === 0) {
    return { enviar: false, texto: '' };
  }

  // Ordenar por hora (lexicográfico "HH:MM" funciona; entradas sin hora al final).
  lista.sort((a, b) => {
    const ha = (a && a.hora) || '';
    const hb = (b && b.hora) || '';
    if (ha === hb) return 0;
    if (!ha) return 1;
    if (!hb) return -1;
    return ha < hb ? -1 : 1;
  });

  const cabecera = `Muestras agendadas hoy - ${nombreNegocio} (${fecha || 'hoy'})`;
  const total = `Total: ${lista.length} visita(s) programada(s).`;

  const bloques = lista.map((c, i) => {
    const n = i + 1;
    const cliente = (c && c.cliente) || 'Cliente';
    const telefono = c && c.telefono ? ` - ${c.telefono}` : '';
    const ubicacion = (c && c.ubicacion) || 'ubicacion por confirmar';
    const hora = (c && c.hora) || 'hora por confirmar';
    const vendedor = c && c.vendedor ? c.vendedor : 'por asignar';
    const stage = (c && c.stage) || 'sin clasificar';
    const score = c && (c.score === 0 || c.score) ? ` (score ${c.score})` : '';
    const estado = (c && c.estado) || 'tentativa';
    return [
      `${n}) ${cliente}${telefono}`,
      `   Ubicacion: ${ubicacion}`,
      `   Hora: ${hora}  -  Vendedor: ${vendedor}`,
      `   Lead ${stage}${score}  -  Estado: ${estado}`,
    ].join('\n');
  });

  const pie = 'Recordatorio: contacta a cada cliente un dia antes para confirmar la visita.';

  const texto = [cabecera, '', total, '', bloques.join('\n\n'), '', pie].join('\n');
  return { enviar: true, texto };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatResumenDiario };
}
