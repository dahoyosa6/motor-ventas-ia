// core/tools/sanear_folio_prosa.js — Saneo determinista del "folio en prosa".
// =============================================================================
// CONTEXTO (BUG#3, Lote B — CONV049/CONV051): el camino de cierre/apartado a
// veces NO emite el marcador [[COTIZAR]]/[[EMITIR_COTIZACION]] (cuyo total lo
// calcula el sistema contra catalogo) y el LLM escribe un pseudo-folio EN PROSA
// con su propia aritmetica, que sale MAL:
//   CONV049: "3 x SUPERIOR — $4,608.00 / Total: $4,608.00" y luego "$3,858".
//   CONV051: "3 x BROCHA — $236.64 / Total: $236.64" y luego "$3,602.64".
//
// El arreglo de FONDO es de prompt (forzar [[COTIZAR]] en el cierre; ver nodo 4).
// Este modulo es la DEFENSA EN PROFUNDIDAD determinista: cuando NINGUN marcador
// manejo el turno y el reply trae un pseudo-folio en prosa, recalcula la linea
// "Total:" como la SUMA EXACTA de los importes de las propias lineas de ítem que
// el texto ya muestra. Asi el total que ve el cliente SIEMPRE es coherente con
// las lineas impresas (cae el patron "Total != suma de lineas" y se estabiliza
// entre turnos). NO inventa precios ni toca el folio real con marcador.
//
// REGLA DE ORO: generico, sin vocabulario de tenant. Solo reconoce la FORMA
// "<qty> x <texto> — $<importe>" y una linea "Total: $<x>"; el contenido del
// item es opaco. core/ no importa de clients/.
// =============================================================================

// Parsea un numero monetario en formato es-MX/en-US: "$4,608.00" -> 4608.00,
// "1.286,50" (es) -> 1286.50. Heuristica: si hay coma Y punto, el ultimo
// separador es el decimal. Si solo hay uno y deja <=2 digitos a la derecha al
// final, se trata como decimal; si no, como separador de miles.
function parseMonto(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let dec = -1;
  if (lastComma !== -1 && lastDot !== -1) {
    dec = Math.max(lastComma, lastDot);
  } else if (lastComma !== -1) {
    // solo comas: decimal si quedan exactamente 1-2 digitos despues
    dec = (s.length - lastComma - 1) <= 2 && (s.length - lastComma - 1) >= 1 ? lastComma : -1;
  } else if (lastDot !== -1) {
    dec = (s.length - lastDot - 1) <= 2 && (s.length - lastDot - 1) >= 1 ? lastDot : -1;
  }
  let intPart, fracPart;
  if (dec !== -1) {
    intPart = s.slice(0, dec).replace(/[.,]/g, '');
    fracPart = s.slice(dec + 1).replace(/[.,]/g, '');
  } else {
    intPart = s.replace(/[.,]/g, '');
    fracPart = '';
  }
  const n = Number(intPart + (fracPart ? '.' + fracPart : ''));
  return Number.isFinite(n) ? n : null;
}

// Formato de salida es-MX con 2 decimales (igual que el folio del nodo 11).
function nf2(n) {
  try {
    return Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch (e) { return String(n); }
}

// Lineas de ítem del pseudo-folio: "<qty> x <desc> — $<importe>" (separador em
// dash, en dash o guion). Devuelve el importe (line_total) de cada una.
// Tolerante a "MXN"/moneda tras el numero. NO captura la linea "Total:".
const RE_LINEA_ITEM = /^\s*\d+\s*[x×]\s+.+?[—–-]\s*\$\s*([\d.,]+)/i;
// Linea de total: "Total: $X", "*Total: $X*", "Total $X".
const RE_LINEA_TOTAL = /(^|\n)(\s*\*?\s*total\s*:?\s*\$\s*)([\d.,]+)(\s*[A-Za-z]{0,4})/i;

// ¿El texto parece un pseudo-folio en prosa? (>=1 linea de ítem con importe Y
// una linea de Total). Se usa para decidir si vale la pena sanear.
function pareceFolioProsa(texto) {
  if (!texto) return false;
  const t = String(texto);
  if (!RE_LINEA_TOTAL.test(t)) return false;
  return t.split('\n').some((ln) => RE_LINEA_ITEM.test(ln));
}

// API PRINCIPAL. Recalcula la linea "Total:" como la suma de los importes de las
// lineas de ítem presentes en el texto. Solo actua si:
//   (a) markerHandled === false  (un marcador SI maneja el total contra catalogo;
//       en ese caso este saneo NO debe tocar nada), y
//   (b) el texto parece folio en prosa, y
//   (c) hay >=1 linea de ítem con importe parseable, y
//   (d) el total escrito difiere de la suma (tolerancia 1 centavo).
// Devuelve { changed, reply, sumaLineas, totalPrevio }.
function sanearFolioProsa(reply, opts) {
  const o = opts || {};
  const markerHandled = !!o.markerHandled;
  const out = { changed: false, reply: reply, sumaLineas: null, totalPrevio: null };
  if (markerHandled) return out;                 // el folio real (marcador) manda
  if (!reply || !pareceFolioProsa(reply)) return out;

  const lineas = String(reply).split('\n');
  let suma = 0, nItems = 0;
  for (const ln of lineas) {
    const m = ln.match(RE_LINEA_ITEM);
    if (m) {
      const v = parseMonto(m[1]);
      if (v != null && Number.isFinite(v)) { suma += v; nItems += 1; }
    }
  }
  if (nItems === 0) return out;                  // sin importes confiables: no tocar
  out.sumaLineas = Math.round(suma * 100) / 100;

  const mt = String(reply).match(RE_LINEA_TOTAL);
  if (!mt) return out;
  const totalPrevio = parseMonto(mt[3]);
  out.totalPrevio = totalPrevio;
  // Coherente ya (o sin total parseable): no reescribir.
  if (totalPrevio != null && Math.abs(totalPrevio - out.sumaLineas) <= 0.01) return out;

  // Reescribe SOLO el numero de la primera linea "Total:", conservando prefijo
  // (incl. asterisco) y la moneda que venia (p.ej. " MXN").
  const reReplace = new RegExp(RE_LINEA_TOTAL.source, 'i');
  out.reply = String(reply).replace(reReplace, (full, pre, lbl, num, cur) =>
    pre + lbl + nf2(out.sumaLineas) + (cur || ''));
  out.changed = out.reply !== reply;
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sanearFolioProsa, pareceFolioProsa, parseMonto, nf2 };
}
