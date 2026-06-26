// parse_discount_reply — Parser determinista de la respuesta del autorizador
// (ej. el dueño) a una consulta de descuento, recibida por WhatsApp en texto libre.
// CORE genérico: NO referencia a ningún cliente concreto (R1). Sin efectos: pura
// función texto -> intención. La decisión de aplicar/declinar la toma la RPC de
// resolución; este parser solo INTERPRETA y declara su confianza.
//
// Salida: { outcome: 'authorized'|'declined'|'unclear', pct: number|null,
//           confidence: 'high'|'low', flags: string[] }
// - outcome 'unclear' o confidence 'low' => el orquestador NO debe auto-aplicar;
//   debe reconsultar al humano o dejar la cotización pendiente (fail-safe).
//
// Diseñado para correr tanto en Node (module.exports) como pegado en un Code node
// de n8n (la función es autocontenida).

function parseDiscountReply(text) {
  const flags = [];
  const raw = String(text == null ? '' : text);
  // normaliza: minúsculas + sin acentos
  const t = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (!t) return { outcome: 'unclear', pct: null, confidence: 'low', flags: ['empty'] };

  // --- porcentaje -----------------------------------------------------------
  // Captura "10%", "10 por ciento", "al 8", "el 5", "maximo 12", "hasta 7", "deja(lo) en 9".
  let pct = null;
  const pctPatterns = [
    /(\d{1,3}(?:[.,]\d{1,2})?)\s*%/,
    /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:por\s*ciento|porciento|pct)\b/,
    /\b(?:maximo|max|hasta|al|del?|en|deja(?:lo)?\s+en|dale\s+el|sube(?:lo)?\s+a)\s+(\d{1,3}(?:[.,]\d{1,2})?)\b/,
    // fallback: número suelto de 1-2 dígitos (en una respuesta corta de autorización
    // casi siempre es el porcentaje). Se ignora si >100.
    /\b(\d{1,2})\b/,
  ];
  for (const re of pctPatterns) {
    const m = t.match(re);
    if (m) { const n = parseFloat(m[1].replace(',', '.')); if (n >= 0 && n <= 100) { pct = n; break; } }
  }

  // --- intención ------------------------------------------------------------
  // Declinar: palabras específicas (no solo "no" suelto, que es ambiguo).
  const declineRe = /\b(no\s+se\s+puede|no\s+autoriz\w*|no\s+aplica|no\s+hay|rechaz\w*|deneg\w*|declin\w*|negativ\w*|imposible|para\s+nada|ni\s+modo|nel)\b/;
  // "no" al inicio como respuesta corta = declina.
  const leadingNo = /^(no|nop|nope|no\.|no,|no\s+gracias|no\s+por\s+ahora)\b/;
  // Autorizar: marcadores afirmativos.
  const authRe = /\b(si|sip|claro|dale|dele|ok|oka|okay|va|vale|sale|listo|autoriz\w*|aprob\w*|aprueb\w*|adelante|de\s+acuerdo|correcto|hecho|procede|concedid\w*|conced\w*|otorg\w*|esta\s+bien)\b/;

  const hasDecline = declineRe.test(t) || leadingNo.test(t);
  const hasAuth = authRe.test(t);
  // "maximo/hasta X" o "deja en X" implica autorizar hasta ese tope aunque falte "si".
  const capAuthorize = /\b(maximo|max|hasta|deja(?:lo)?\s+en)\b/.test(t) && pct != null;

  // riesgos que bajan la confianza (requieren ojo humano)
  if (/\b(solo|unicamente|nada\s+mas|excepto|salvo|pero\s+solo)\b/.test(t)) flags.push('parcial_o_condicional');
  if (/\b(sku|galon|cubeta|litro|cubetas|galones|articulo|producto|item)\b/.test(t)) flags.push('menciona_item_especifico');
  if (hasDecline && (hasAuth || capAuthorize)) flags.push('ambiguo_si_y_no');

  let outcome, confidence;
  if (hasDecline && !hasAuth && !capAuthorize) {
    outcome = 'declined';
    confidence = 'high';
  } else if (hasDecline && (hasAuth || capAuthorize)) {
    // contradicción ("no... dale") -> no auto-resolver
    outcome = 'unclear';
    confidence = 'low';
  } else if (hasAuth || capAuthorize) {
    outcome = 'authorized';
    // alta confianza si la intención es clara y (hay pct o no se requería monto);
    // baja si hay condiciones/per-item que el parser global no modela.
    const risky = flags.includes('parcial_o_condicional') || flags.includes('menciona_item_especifico');
    confidence = risky ? 'low' : 'high';
  } else {
    outcome = 'unclear';
    confidence = 'low';
    flags.push('sin_intencion_clara');
  }

  return { outcome, pct, confidence, flags };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseDiscountReply };
}
