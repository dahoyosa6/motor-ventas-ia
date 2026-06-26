// Guard del patron C: el LLM emite [[COTIZAR]] con un producto DISTINTO al que el
// cliente ya confirmo en la conversacion. El precio del sustituto es real de
// catalogo, por eso price_grounded no lo detecta (CONV072/073/077/084).
// Modulo PURO y generico (Regla de Oro): sin require, sin red, sin referencias a
// ningun tenant. Disenado para embeberse tal cual en el jsCode del nodo 11 del
// workflow n8n (funciones standalone, prefijo vic* para no colisionar con los
// helpers ya presentes en el nodo). Mantener en sync con la copia embebida.
//
// Exporta:
//   ultimoProductoConfirmado(turnos, intermediateSteps)
//     -> { sku: string|null, nombre: string, precio: number|null } | null
//   validarItemsCotizar(items, confirmado)
//     -> { ok: true } | { mismatch: true, sugerencia: {sku, nombre, precio} }
//   inferirSkuAfirmado(replyText, intermediateSteps, turnos)
//     -> string (SKU unico) | null (ambiguedad o cero señal: no se adivina)
//   productosEnMesa(turnos)  [fail-secure ante orden de cierre ambigua]
//     -> { productos: [{nombre, precio}] } | null
//   validarItemsContraMesa(items, mesa)
//     -> { ok: true } | { mismatch: true, huerfanos: [item, ...] }
//   vicEsCierreGenerico(msgUser) -> boolean
//   clienteQuiereDisponibilidad(msgUser) -> boolean  [gate del guard de stock, BUG#2]

// --- Helpers de texto (replican el criterio de __deaccent/__tokens del nodo 11) --
function vicDeaccent(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
// Stopwords gramaticales (genericas, sin vocabulario de dominio).
const VIC_STOP = new Set(['de', 'la', 'el', 'en', 'y', 'con', 'para', 'los', 'las', 'del', 'por', 'un', 'una', 'que', 'mas', 'al', 'es', 'su', 'lo', 'te', 'me', 'se', 'le']);
function vicTokens(s, minLen) {
  const min = minLen || 2;
  return vicDeaccent(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((t) => t && t.length >= min && !VIC_STOP.has(t));
}
// Singulariza plurales simples (galones->galon); igual que __singular del nodo 11.
function vicSingular(t) {
  const s = String(t || '');
  if (s.length > 5 && s.endsWith('es')) return s.slice(0, -2);
  if (s.length > 3 && s.endsWith('s')) return s.slice(0, -1);
  return s;
}
// Raiz tolerante a genero (blanco/blanca -> blanc) para match por substring.
function vicRaiz(t) {
  let s = vicSingular(String(t || ''));
  if (s.length > 4 && /[ao]$/.test(s)) s = s.slice(0, -1);
  return s;
}
// Tokens que son PRESENTACION/envase (van en `presentacion`, NUNCA en `descripcion`:
// la resolucion por familia matchea descripcion contra la columna `description` del
// catalogo, que NO incluye el envase; "galon" en descripcion -> 0 match -> falla).
const VIC_PRES_TOK = new Set(['galon', 'galones', 'litro', 'litros', 'cubeta', 'cubetas', 'pieza', 'piezas']);
// Presentacion canonica detectada en un texto libre ('' = no reconocida).
function vicPresDe(texto) {
  const s = vicDeaccent(texto);
  if (!s) return '';
  if (/cubeta|19\s*l\b|5\s*gal/.test(s)) return 'cubeta';
  if (/galon|\b4\s*l\b/.test(s)) return 'galon';
  if (/litro|\b1\s*l\b/.test(s)) return 'litro';
  return '';
}
// "1,286.00" -> 1286 (formato es-MX: coma como millar). Tolera punto final de
// oracion pegado al precio ("$385.00." -> 385).
function vicParsePrecio(txt) {
  const n = Number(String(txt || '').replace(/,/g, '').replace(/\.(?!\d)/g, ''));
  return Number.isFinite(n) ? n : null;
}

// --- Propuestas producto+precio en un mensaje del agente ------------------------
// Una propuesta = linea con precio ($) y al menos un sustantivo. Se ignoran lineas
// de total/vigencia/envio/anticipo/descuento. nombre = texto de la linea sin el
// precio ni el prefijo de cantidad ("4 x ").
const VIC_RE_PRECIO = /\$\s?(\d[\d.,]*)/;
function vicPropuestas(content) {
  const out = [];
  for (const linea of String(content || '').split(/\n+/)) {
    const m = VIC_RE_PRECIO.exec(linea);
    if (!m) continue;
    const low = vicDeaccent(linea);
    if (/\btotal\b|\bvigencia\b|\banticipo\b|\benvio\b|\bdescuento\b/.test(low)) continue;
    const precio = vicParsePrecio(m[1]);
    let nombre = linea.slice(0, m.index)
      .replace(/^\s*[-*•]?\s*\d+\s*x\s*/i, '')
      .replace(/[—–:,(\-]+\s*$/, '')
      .trim();
    if (!nombre) nombre = linea.replace(VIC_RE_PRECIO, ' ').trim();
    if (vicTokens(nombre, 3).length < 1) continue;
    out.push({ nombre: nombre, precio: precio });
  }
  return out;
}

// --- Afirmacion del cliente ------------------------------------------------------
// Sobre texto sin acentos. Lista acordada en el plan del patron C.
const VIC_RE_AFIRMA = /(^|\b)(si|esa|ese|dale|la quiero|el de|cotiza(me)?|perfecto|va|de acuerdo|ok)\b/;
// Negacion o cambio de opinion: invalida la confirmacion vigente.
const VIC_RE_NIEGA = /(^|\b)no\b|\bcambi/;
// Muletillas y acciones genericas de compra: NO cuentan como "producto nuevo".
const VIC_ACCION = new Set(['quiero', 'quiere', 'aparta', 'apartame', 'apartas', 'apartalo', 'apartala', 'manda', 'mandame', 'mandala', 'mandalo', 'envia', 'enviame', 'cotiza', 'cotizame', 'cotizacion', 'confirmo', 'confirma', 'perfecto', 'entonces', 'tambien', 'porfa', 'favor', 'gracias', 'dale', 'acuerdo', 'listo', 'sale', 'bueno', 'okey', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'seria', 'serian', 'queda', 'quedan', 'final', 'todo', 'toda', 'pues', 'pago', 'pagar', 'pagarte', 'transferencia', 'efectivo', 'tarjeta', 'deposito', 'manana', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'nombre', 'recojo', 'paso', 'tienda', 'sucursal', 'llevar', 'llevo', 'pedido', 'total', 'esta', 'bien', 'mejor', 'precio', 'factura', 'como', 'cuando', 'donde', 'espera', 'ahora', 'claro', 'vale', 'hora', 'aparto']);
// Confirmacion "limpia": los tokens sustantivos (>=4) del mensaje, fuera de
// muletillas/acciones, deben aparecer en la propuesta (substring, tolera plural).
function vicConfirmacionLimpia(msgUser, textoPropuesta) {
  const have = vicDeaccent(textoPropuesta);
  const toks = vicTokens(msgUser, 4).filter((t) => !VIC_ACCION.has(t));
  return toks.every((t) => have.includes(vicSingular(t)));
}
// Orden de cierre GENERICA: el cliente pide "la cotizacion final/total" SIN nombrar
// ningun producto (todos sus tokens >=4 son muletillas/acciones). Es el caso donde
// ultimoProductoConfirmado se degrada a null con varias propuestas en mesa
// (CONV072: "ok mandame la cotizacion final con todo"). Generico: solo lenguaje de
// cierre, sin vocabulario de tenant.
function vicEsCierreGenerico(msgUser) {
  const m = vicDeaccent(msgUser);
  if (!VIC_RE_AFIRMA.test(m) || VIC_RE_NIEGA.test(m)) return false;
  const toks = vicTokens(msgUser, 4).filter((t) => !VIC_ACCION.has(t));
  return toks.length === 0; // ningun sustantivo de producto -> orden de cierre pura
}

// --- Resolucion nombre -> SKU contra observations de tools -----------------------
// Extrae filas {sku, description, presentation, unit_price} de las observations de
// intermediateSteps (ahi vienen los SKUs y precios reales del turno). Camina JSON
// anidado (strings JSON incluidos) con tope de profundidad.
function vicRowsDeSteps(intermediateSteps) {
  const rows = [];
  const walk = (v, depth) => {
    if (v == null || depth > 6) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') {
      const sku = (v.sku != null) ? v.sku : ((v.SKU != null) ? v.SKU : null);
      const desc = v.description || v.descripcion || v.DESCRIPCION || '';
      if (sku != null && desc) {
        const p = (v.unit_price != null) ? v.unit_price : ((v.precio != null) ? v.precio : ((v.price != null) ? v.price : null));
        rows.push({
          sku: String(sku), description: String(desc),
          presentation: String(v.presentation || v.presentacion || v.PRESENTACION || ''),
          unit_price: (p != null && Number.isFinite(Number(p))) ? Number(p) : null,
        });
      }
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
      return;
    }
    if (typeof v === 'string' && (v.indexOf('{') >= 0 || v.indexOf('[') >= 0)) {
      try { walk(JSON.parse(v), depth + 1); } catch (e) { /* texto plano */ }
    }
  };
  for (const p of (Array.isArray(intermediateSteps) ? intermediateSteps : [])) {
    if (p) walk(p.observation, 0);
  }
  return rows;
}
// Resuelve {nombre, precio} a un SKU unico. Señales en orden: precio exacto (±1%)
// con >=1 token compartido; fallback por tokens (mejor numero de hits, criterio de
// __resolverItems: si 0 o ambiguo NO se adivina -> null).
function vicResolverSku(nombre, precio, rows) {
  const want = vicTokens(nombre, 3).map(vicRaiz);
  if (!Array.isArray(rows) || !rows.length || !want.length) return null;
  const scored = [];
  for (const r of rows) {
    const desc = vicDeaccent(String(r.description || '') + ' ' + String(r.presentation || ''));
    const hits = want.filter((t) => desc.includes(t)).length;
    const priceOk = (precio != null && r.unit_price != null)
      ? Math.abs(r.unit_price - precio) <= Math.max(1, precio * 0.01) : false;
    if (hits >= 1) scored.push({ r: r, hits: hits, priceOk: priceOk });
  }
  let pool = scored.filter((s) => s.priceOk);
  if (!pool.length) {
    const maxHits = scored.length ? Math.max.apply(null, scored.map((s) => s.hits)) : 0;
    if (maxHits < 2) return null; // 1 token suelto no identifica producto
    pool = scored.filter((s) => s.hits === maxHits);
  }
  const skus = [];
  for (const s of pool) { if (skus.indexOf(String(s.r.sku)) < 0) skus.push(String(s.r.sku)); }
  if (skus.length !== 1) return null; // 0 o ambiguo -> no se adivina
  return skus[0];
}

// --- API: ultimo producto confirmado ----------------------------------------------
// Recorre los turnos de atras hacia adelante: busca la ULTIMA afirmacion del
// cliente y, antes de ella, la ultima propuesta del agente con producto+precio.
// Si la afirmacion menciona producto nuevo, hay negacion/cambio, o la propuesta
// es ambigua (varias lineas sin desambiguar) -> null (cero-daño aguas abajo).
function ultimoProductoConfirmado(turnos, intermediateSteps) {
  const ts = (Array.isArray(turnos) ? turnos.slice() : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content);
  // Tolera orden descendente (la RPC entrega ascendente).
  if (ts.length > 1 && ts[0].created_at && ts[ts.length - 1].created_at
      && String(ts[0].created_at) > String(ts[ts.length - 1].created_at)) ts.reverse();
  for (let i = ts.length - 1; i >= 1; i--) {
    if (ts[i].role !== 'user') continue;
    const msg = vicDeaccent(ts[i].content);
    if (!VIC_RE_AFIRMA.test(msg)) continue;
    if (VIC_RE_NIEGA.test(msg)) return null; // negacion/cambio: confirmacion no vigente
    for (let j = i - 1; j >= 0; j--) {
      if (ts[j].role !== 'assistant') continue;
      const cands = vicPropuestas(ts[j].content);
      if (!cands.length) continue; // assistant sin precio: seguir hacia atras
      if (!vicConfirmacionLimpia(ts[i].content, ts[j].content)) return null;
      let pool = cands;
      if (cands.length > 1) {
        // Desambiguar con los tokens de la afirmacion ("la de cubeta", "el galon").
        const utoks = vicTokens(ts[i].content, 3).filter((t) => !VIC_ACCION.has(t)).map(vicRaiz);
        const hit = cands.filter((c) => { const d = vicDeaccent(c.nombre); return utoks.some((t) => d.includes(t)); });
        if (hit.length) pool = hit;
      }
      if (pool.length !== 1) return null; // ambiguo: no se adivina
      const prop = pool[0];
      const sku = vicResolverSku(prop.nombre, prop.precio, vicRowsDeSteps(intermediateSteps));
      return { sku: sku, nombre: prop.nombre, precio: prop.precio };
    }
    return null; // afirmacion sin propuesta previa con precio
  }
  return null; // sin afirmacion detectable
}

// --- API: validar items del marcador contra lo confirmado --------------------------
// Un item "es" el producto {sku?, nombre, precio} si: (a) SKU exacto cuando ambos
// lados lo tienen; o (b) >=2 raices compartidas (familia/descripcion/presentacion vs
// nombre) + presentacion compatible + precio dentro de ±20% (si ambos existen) +
// cross-family: comparten al menos UNA raiz "de tipo" (>=6 chars; los tipos de producto
// —vinilica/esmalte/barniz/sellador/primario...— son palabras largas, los adjetivos
// —mate/gris/base/std— son cortos). Sin raiz larga compartida, compartir solo
// adjetivos (mate/blanco) NO basta: son familias distintas (BUG#1, CONV083). Generico:
// no enumera familias, solo usa longitud de token. Si ninguno de los dos lados tiene
// raiz larga, se omite el cross-family (retrocompat).
function vicItemEsProducto(it, prod) {
  if (!it || !prod) return false;
  if (it.sku && prod.sku && String(it.sku) === String(prod.sku)) return true;
  const raices = vicTokens(prod.nombre, 3).map(vicRaiz);
  const presP = vicPresDe(prod.nombre);
  const itTxt = vicDeaccent([it.descripcion, it.familia, it.presentacion].filter(Boolean).join(' '));
  if (!itTxt) return false;
  const comunes = raices.filter((t) => itTxt.includes(t)).length;
  const need = Math.min(2, raices.length);
  if (comunes < need) return false; // texto distinto
  // Cross-family: el "tipo" de producto es una raiz larga (>=6). Si el confirmado tiene
  // alguna, el item debe compartir AL MENOS una raiz larga; si no, son familias
  // distintas que solo coinciden en adjetivos cortos (mate/blanco) -> NO empata.
  const raicesLargas = raices.filter((t) => t.length >= 6);
  if (raicesLargas.length && !raicesLargas.some((t) => itTxt.includes(t))) return false;
  const presIt = vicPresDe(itTxt);
  if (presIt && presP && presIt !== presP) return false; // otra presentacion
  const pu = (it.unit_price != null && Number.isFinite(Number(it.unit_price))) ? Number(it.unit_price) : null;
  if (pu != null && prod.precio != null && prod.precio > 0
      && Math.abs(pu - prod.precio) / prod.precio > 0.20) return false; // otra variante
  return true;
}
// Si NINGUN item es el confirmado -> mismatch con sugerencia (el confirmado).
function validarItemsCotizar(items, confirmado) {
  if (!confirmado || !Array.isArray(items) || !items.length) return { ok: true };
  for (const it of items) {
    if (vicItemEsProducto(it, confirmado)) return { ok: true };
  }
  return { mismatch: true, sugerencia: { sku: confirmado.sku || null, nombre: confirmado.nombre, precio: confirmado.precio } };
}

// --- API: normalizar la `familia` polucionada del marcador (LOTE C, swap en resolucion)
// El LLM mete el NOMBRE COMPLETO en el campo `familia` ("VINILICA MATE COPE BLANCO.")
// en vez del TIPO ("VINILICA"). consultar_familia con esa cadena larga hace match difuso
// y devuelve ~150 filas de OTRAS familias (ACRILICA/ESMALTE), nunca la vinilica -> la
// resolucion cae en un ESMALTE/EPOXICO (swap CONV083/CONV084). FIX: consultar la familia
// SOLO por su TIPO (el primer token largo: vinilic/esmalte/epoxic...) y mover los tokens
// EXTRA de la familia ("cope", "superior") a la descripcion, donde SI desambiguan la
// variante correcta. Generico: usa longitud/posicion de token, sin enumerar familias.
//   -> { tipo: string, extra: [tokens] }  (tipo='' si no hay token util)
function familiaTipoYExtra(familia) {
  const toks = vicTokens(familia, 3);
  if (!toks.length) return { tipo: '', extra: [] };
  // El TIPO es el primer token largo (>=6): vinilic/esmalte/epoxic/sellad/primari/barniz...
  // (los adjetivos mate/gris/cope/blanc son cortos y van como extra para desambiguar).
  let idx = toks.findIndex((t) => vicRaiz(t).length >= 6);
  if (idx < 0) idx = 0; // sin token largo: usa el primero como tipo
  const tipo = toks[idx];
  const extra = toks.filter((_, i) => i !== idx).filter((t) => !VIC_PRES_TOK.has(vicSingular(t)));
  return { tipo: tipo, extra: extra };
}

// --- API: anclar el item al producto confirmado (LOTE C, raiz del swap real) --------
// Causa raiz verificada (CONV084, exec n8n 3644): el LLM SI emite [[COTIZAR]] con el
// producto correcto, PERO mete el nombre completo en `familia` ("VINILICA MATE BLANCO
// SUPERIOR.") y un token suelto en `descripcion` ("blanco"). Aguas abajo, __resolverItems
// llama consultar_familia con esa familia larga -> match difuso de ~150 filas; el filtro
// por el token "blanco" (presente en muchas) cae en EPOXICO FENOLICO BLANCO. El swap NO
// lo hace el LLM ni se ve en el marcador: ocurre en la RESOLUCION. El guard anti-swap
// (pre-resolucion) valida el marcador y lo da por bueno -> no corrige.
// FIX: cuando hay UN solo item y un producto CONFIRMADO en la conversacion, se reemplaza
// el descriptor del item por el del confirmado (SKU si existe; si no, nombre limpio via
// confirmadoAItem) ANTES de resolver. Asi la resolucion se ancla al producto que el
// cliente acepto y NO re-resuelve el texto vago. Generico: sin vocabulario de tenant.
//   -> { items } (lista nueva anclada) | null (no aplica: no hay conf util o multi-item)
function anclarItemConfirmado(items, confirmado) {
  if (!confirmado || !Array.isArray(items) || items.length !== 1) return null;
  const qty = items[0] && items[0].quantity;
  if (confirmado.sku) {
    return { items: [{ sku: String(confirmado.sku), descripcion: confirmado.nombre, quantity: qty }] };
  }
  const it = confirmadoAItem(confirmado);
  if (!it || !it.familia) return null;
  return { items: [Object.assign({ quantity: qty }, it)] };
}

// --- API: productos "en mesa" (fail-secure ante orden de cierre ambigua) ------------
// Cuando ultimoProductoConfirmado se degrada a null (CONV072: orden de cierre generica
// "mandame la cotizacion final con todo" con VARIAS propuestas vigentes), no se puede
// elegir UN producto. En vez de fallar abierto, se devuelve el CONJUNTO de productos
// que el agente propuso por ultima vez (las propuestas con precio de los turnos del
// agente, hasta toparse con una negacion/cambio del cliente que las invalide). El
// caller exige que cada item del marcador empate con ALGUNA de ellas. Generico: solo
// detecta propuestas (linea con $ + sustantivo), sin vocabulario de tenant.
//   -> { productos: [{nombre, precio}] } | null  (null = sin propuestas en mesa)
function productosEnMesa(turnos) {
  const ts = (Array.isArray(turnos) ? turnos.slice() : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content);
  if (ts.length > 1 && ts[0].created_at && ts[ts.length - 1].created_at
      && String(ts[0].created_at) > String(ts[ts.length - 1].created_at)) ts.reverse();
  const productos = [];
  const vistos = new Set();
  // De atras hacia adelante: junta propuestas de los turnos del agente; corta al
  // encontrar una negacion/cambio del cliente (las propuestas previas ya no rigen).
  for (let i = ts.length - 1; i >= 0; i--) {
    if (ts[i].role === 'user' && VIC_RE_NIEGA.test(vicDeaccent(ts[i].content))) break;
    if (ts[i].role !== 'assistant') continue;
    for (const p of vicPropuestas(ts[i].content)) {
      const k = vicDeaccent(p.nombre) + '|' + String(p.precio);
      if (!vistos.has(k)) { vistos.add(k); productos.push(p); }
    }
  }
  return productos.length ? { productos: productos } : null;
}
// Cada item del marcador debe empatar con ALGUNA propuesta en mesa. Si algun item no
// empata con ninguna (producto que no estaba en mesa: el swap del LLM) -> mismatch con
// los items huerfanos (el caller degrada a pregunta de confirmacion).
//   -> { ok: true } | { mismatch: true, huerfanos: [item, ...] }
function validarItemsContraMesa(items, mesa) {
  const prods = mesa && Array.isArray(mesa.productos) ? mesa.productos : [];
  if (!prods.length || !Array.isArray(items) || !items.length) return { ok: true };
  const huerfanos = [];
  for (const it of items) {
    if (!it) continue;
    if (!prods.some((p) => vicItemEsProducto(it, p))) huerfanos.push(it);
  }
  return huerfanos.length ? { mismatch: true, huerfanos: huerfanos } : { ok: true };
}

// --- API: inferir el SKU del producto cuyo stock se esta afirmando ----------------
// Para el guard anti-afirmacion de stock (nodo 11, Fase 2): dado el texto del reply
// que AFIRMA existencia/apartado, identifica el SKU del producto afirmado. Funcion
// PURA: decide el SKU; la llamada a la RPC de stock queda en el caller (jsCode).
// Orden de señales:
//   1) Observations de tools del turno (rows con sku+descripcion+precio reales):
//      a) propuestas producto+precio en el propio reply -> vicResolverSku (precio
//         ±1% + tokens). Varias propuestas que resuelven a SKUs DISTINTOS = ambiguo;
//      b) sin propuesta con precio: tokens del reply completo contra los rows
//         (criterio vicResolverSku: >=2 raices compartidas y SKU unico).
//   2) Ultimo producto confirmado en los turnos (flujo del patron C; el SKU sale
//      de las mismas observations, asi que sin rows tampoco adivina).
// Ambiguedad o cero señal -> null (el caller mantiene su fallback condicional).
function inferirSkuAfirmado(replyText, intermediateSteps, turnos) {
  const rows = vicRowsDeSteps(intermediateSteps);
  if (rows.length) {
    const skus = [];
    for (const p of vicPropuestas(replyText)) {
      const s = vicResolverSku(p.nombre, p.precio, rows);
      if (s && skus.indexOf(s) < 0) skus.push(s);
    }
    if (skus.length === 1) return skus[0];
    if (skus.length > 1) return null; // afirma varios productos a la vez: ambiguo
    const s2 = vicResolverSku(replyText, null, rows);
    if (s2) return s2;
  }
  const conf = ultimoProductoConfirmado(turnos, intermediateSteps);
  return (conf && conf.sku) ? conf.sku : null;
}

// --- Deteccion de AFIRMACION/NEGACION de stock (guard anti-afirmacion, nodo 11) ---
// El reply afirma existencia o apartado SIN tool-call de stock. Sobre texto sin
// acentos en minusculas. Generico (sin vocabulario de tenant): solo lenguaje de
// existencia/apartado. MANTENER EN SYNC con la copia embebida en el nodo 11.
// Cubre (CONV039): verbo 1a persona "tengo/me quedan N ... disponible" y apartado en
// periphrasis "te la puedo apartar / dejar apartada", ademas del fraseo previo.
const STOCK_RE_AFIRMA = [
  // "Si, la X viene en ... disponible / en existencia / en stock"
  /\bsi,?\s+(la|lo|las|los|el|tenemos|hay)\b[\s\S]{0,160}?(viene en|disponible|en existencia|en stock)/,
  // "tenemos/hay (en) existencia/stock"
  /\b(tenemos|hay)\s+(en\s+)?(existencia|stock)\b/,
  // 1a persona / existencia concreta: "tengo|tenemos|hay|me quedan N ... disponible(s)|en existencia|en stock"
  /\b(tengo|tenemos|hay|me\s+queda(n)?|quedan?)\s+\d*\s*[a-z]*\s*(disponibles?|en\s+existencia|en\s+stock)\b/,
  // numero concreto + ... + disponible(s) (el patron mas peligroso: "Tengo 1 cubeta disponible")
  /\b(tengo|tenemos|hay)\s+\d+\b[\s\S]{0,40}?\bdisponibles?\b/,
  // apartado presente 1a persona: "te la aparto"
  /\bte\s+(la|lo|las|los)\s+aparto\b/,
  // apartado en periphrasis: "te la puedo/podemos apartar / dejar apartada"
  /\bte\s+(la|lo|las|los)\s+(puedo|podemos)\s+(apartar|dejar\s+apartad[ao]s?)\b/,
  /\bcuant[ao]s?\s+te\s+aparto\b/,
  /\bqueda(n)?\s+apartad[ao]s?\b/,
];
const STOCK_RE_NIEGA = /\b(no\s+(la|lo|las|los)?\s*(tenemos|hay|queda|manejamos)|sin\s+(existencia|stock)|agotad[ao]|sobre\s+pedido|dejame\s+confirmar|en\s+cuanto\s+confirme|permiteme\s+confirmar)\b/;
// Helper de prueba: ¿el texto AFIRMA stock (y NO lo niega)? (la del nodo es inline).
function afirmaStockSinNegar(texto) {
  const s = vicDeaccent(texto);
  return STOCK_RE_AFIRMA.some((re) => re.test(s)) && !STOCK_RE_NIEGA.test(s);
}

// --- Intencion de DISPONIBILIDAD del cliente (BUG#2, CONV036/083) ------------------
// El guard de stock NO debe anunciar "no hay" proactivamente ante una peticion normal
// de producto/precio: su trabajo es impedir AFIRMAR stock sin tool-call, no negar
// existencia que el cliente no pregunto. Solo cuando el cliente pregunta por
// disponibilidad/existencia/urgencia (o pide apartar/comprometer) tiene sentido
// resolver el stock real y, si no hay, decirlo. Generico: solo lenguaje de
// disponibilidad/urgencia/compromiso, sin vocabulario de tenant.
const RE_DISPONIBILIDAD = [
  // pregunta por existencia/disponibilidad
  /\b(tien(es|en)|hay|cuent(as|an)\s+con|manej(as|an)|disponib|existenci|en\s+stock|inventario|surtid)/,
  // urgencia / fecha de uso ("lo ocupo el lunes", "lo necesito para manana", "es para hoy")
  /\b(lo\s+(ocupo|necesito|requiero)|para\s+(hoy|manana|el\s+lunes|el\s+martes|el\s+miercoles|el\s+jueves|el\s+viernes|el\s+sabado|el\s+domingo|ya|cuanto\s+antes|urgente)|urge|me\s+urge)/,
  // compromiso: apartar / reservar / comprar
  /\b(apart|reserv|separ|me\s+lo\s+llevo|lo\s+quiero|comprar|comprarl|cerrar\s+el\s+pedido)/,
];
function clienteQuiereDisponibilidad(msgUser) {
  const s = vicDeaccent(msgUser);
  if (!s) return false;
  return RE_DISPONIBILIDAD.some((re) => re.test(s));
}

// --- Anclaje del turno de cierre ACTUAL (LOTE C, raiz de CONV084) -------------------
// El guard corre en el nodo 11 ANTES de que el turno actual (user + reply) se persista
// (lo escribe el nodo 12, despues). Por eso poc_get_recent_turns devuelve solo los
// turnos PREVIOS: el ultimo "user" en la BD es la penultima frase, NO el cierre seco
// ("va, si lo quiero") con el que el cliente ACEPTA la propuesta. Sin ese turno,
// ultimoProductoConfirmado mira la afirmacion equivocada y se degrada a null -> el
// guard "falla abierto" y el swap pasa. Este helper agrega el mensaje de usuario ACTUAL
// como ultimo turno (idempotente: no duplica si ya esta) para que el guard evalue la
// confirmacion REAL contra la ultima propuesta del agente. Generico: solo manipula la
// secuencia de turnos, sin vocabulario de tenant. Devuelve un ARRAY NUEVO (no muta).
function anclarTurnoActual(turnos, userMsgActual) {
  const base = Array.isArray(turnos) ? turnos.slice() : [];
  const msg = String(userMsgActual || '').trim();
  if (!msg) return base;
  // Si el ultimo turno user ya es este mensaje, no se duplica (idempotente).
  for (let i = base.length - 1; i >= 0; i--) {
    if (!base[i] || base[i].role !== 'user') continue;
    if (String(base[i].content || '').trim() === msg) return base;
    break; // el ultimo user es OTRO -> hay que anclar
  }
  base.push({ role: 'user', content: msg, created_at: '9999-12-31T23:59:59Z' });
  return base;
}

// --- Confirmado -> item resoluble (LOTE C, swap por NOMBRE sin SKU) -----------------
// En un cierre seco ("va, si lo quiero") no hay tool-call en ESE turno, asi que
// ultimoProductoConfirmado resuelve nombre+precio pero NO el SKU (las observations son
// del turno actual, vacias). Para EMITIR el producto CONFIRMADO (no solo preguntar), el
// guard re-resuelve el NOMBRE confirmado contra catalogo via __resolverItems. Este
// helper convierte el confirmado {sku?, nombre, precio} en un item {sku?, familia,
// descripcion, presentacion} ANCLADO al producto que el cliente acepto — nunca al texto
// vago de la conversacion ni al swap del LLM. La descripcion son los tokens sustantivos
// del nombre confirmado; la familia es la primera raiz "de tipo" (>=6 chars). Generico:
// solo longitud/forma de token, sin enumerar familias. Devuelve null si no hay nombre util.
// Tokens que son PRESENTACION/envase, no parte de la descripcion del catalogo: van en
// el campo `presentacion`, NO en `descripcion` (la resolucion por familia matchea los
// tokens de descripcion contra la columna `description` del catalogo, que NO incluye el
// envase; si "galon" va en descripcion, ningun row la trae y la resolucion falla).
function confirmadoAItem(conf) {
  if (!conf) return null;
  const toks = vicTokens(conf.nombre, 3).filter((t) => !VIC_ACCION.has(t));
  // La descripcion son los tokens del producto SIN los de envase (esos van en presentacion).
  const descToks = toks.filter((t) => !VIC_PRES_TOK.has(vicSingular(t)));
  if (!descToks.length) return null;
  // La familia (tipo de producto) es la primera raiz larga (>=6): vinilic/esmalte/...
  const tipo = descToks.map(vicRaiz).find((t) => t.length >= 6) || '';
  const item = {
    descripcion: descToks.join(' '),
    presentacion: vicPresDe(conf.nombre),
  };
  if (conf.sku) item.sku = String(conf.sku);
  if (tipo) item.familia = tipo;
  return item;
}

// ============================================================================
// ANCLAJE DETERMINISTA POR SKU (migration 0044) — la SELECCION es estado explicito
// ============================================================================
// Raiz del swap: hoy la seleccion se reconstruye por TEXTO cada turno y al emitir se
// re-resuelve el nombre difusamente contra las 1600 SKUs. Aqui la seleccion se FIJA al
// SKU EXACTO surfaceado y se re-fija matcheando la eleccion del cliente contra el conjunto
// CHICO surfaceado (<=20 filas de poc_get_surfaced), nunca contra el catalogo completo.
// Funciones PURAS (sin red), embebibles en el nodo 11. MANTENER EN SYNC con la copia.

// Conectores ADITIVOS (suma, no reemplaza): "los dos", "ambos", "tambien", "y agrega".
const VIC_RE_ADITIVO = /\b(los\s+dos|las\s+dos|ambos|ambas|tambien|adem[aá]s|agrega|agregame|suma|sumale|y\s+el|y\s+la|y\s+tambien)\b/;
// "todo/todos" como orden de cierre amplia ("cotiza todo", "mandame todo").
const VIC_RE_TODO = /\b(todo|todos|todas|toda)\b/;

// Familia (tipo) de una fila surfaceada: la primera raiz larga (>=6) de description+familia.
// Generico: solo longitud de token, sin enumerar familias.
function vicFamiliaDeRow(row) {
  const txt = String((row && row.familia) || '') + ' ' + String((row && row.description) || '');
  const raices = vicTokens(txt, 3).map(vicRaiz).filter((t) => t.length >= 6);
  return raices.length ? raices[0] : '';
}
// ¿La fila surfaceada empata con el mensaje del cliente? Match por raices del mensaje
// (fuera de muletillas) contra description+presentation+familia, mas presentacion
// compatible si el cliente la nombro. Dominio = el conjunto CHICO surfaceado.
function vicRowMatchMsg(row, msgToks, msgPres) {
  const hay = vicDeaccent(
    String((row && row.description) || '') + ' ' +
    String((row && row.presentation) || '') + ' ' +
    String((row && row.familia) || ''));
  if (!hay) return false;
  // presentacion: si el cliente pidio una y la fila trae otra distinta -> no empata.
  const rowPres = vicPresDe(String((row && row.presentation) || ''));
  if (msgPres && rowPres && msgPres !== rowPres) return false;
  // Si el cliente SOLO nombro presentacion (msgToks sin sustantivos), basta la presentacion.
  const sust = msgToks.filter((t) => !VIC_PRES_TOK.has(vicSingular(t)));
  if (!sust.length) return !!(msgPres && rowPres && msgPres === rowPres);
  // Al menos una raiz sustantiva del mensaje debe aparecer en la fila.
  return sust.some((t) => hay.includes(t));
}

// Puntua una fila surfaceada por cuantos tokens de PREFERENCIA (acumulados de los mensajes
// recientes del cliente: "caoba", "la cubeta"...) aparecen en su descripcion/presentacion.
// Generico: solo tokens del cliente, sin enumerar familias. Empata presentacion preferida.
function vicScorePref(row, prefToks, prefPres) {
  const hay = vicDeaccent(
    String((row && row.description) || '') + ' ' +
    String((row && row.presentation) || '') + ' ' +
    String((row && row.familia) || ''));
  let score = 0;
  for (const t of (prefToks || [])) { if (t && hay.includes(t)) score++; }
  const rowPres = vicPresDe(String((row && row.presentation) || ''));
  if (prefPres && rowPres && prefPres === rowPres) score += 2;   // presentacion pedida pesa
  return score;
}

// actualizarSeleccion(surfaced, msgUser, seleccionActual, prefsTexto?)
//   surfaced       = [{sku, description, presentation, unit_price, familia}] (conjunto chico)
//   msgUser        = mensaje del cliente en este turno
//   seleccionActual= [{sku, quantity}] vigente
//   prefsTexto     = (opcional) concatenado de los mensajes RECIENTES del cliente, para
//                    desambiguar la VARIANTE por familia en "los dos" (caoba/cubeta/...).
//                    Default = msgUser (retrocompat).
//   -> { action: 'replace'|'add'|'keep'|'ask', selection: [{sku, quantity}], candidatos?: [...] }
// Reglas 1-4 del diseno §2.2. El cliente MANDA: la seleccion siempre apunta al ULTIMO
// producto querido. Ambiguedad real -> 'ask' (nunca asume el primero).
function actualizarSeleccion(surfaced, msgUser, seleccionActual, prefsTexto) {
  const surf = Array.isArray(surfaced) ? surfaced.filter((r) => r && r.sku) : [];
  const sel = Array.isArray(seleccionActual) ? seleccionActual.filter((s) => s && s.sku) : [];
  const keep = () => ({ action: 'keep', selection: sel.slice() });
  if (!surf.length) return keep();
  const m = vicDeaccent(msgUser);
  const aditivo = VIC_RE_ADITIVO.test(m);
  const msgToks = vicTokens(msgUser, 3).filter((t) => !VIC_ACCION.has(t)).map(vicRaiz);
  const msgPres = vicPresDe(msgUser);
  // Tokens/presentacion de PREFERENCIA acumulados (mensajes recientes del cliente).
  const prefStr = (prefsTexto != null && String(prefsTexto)) ? String(prefsTexto) : String(msgUser);
  const prefToks = vicTokens(prefStr, 3).filter((t) => !VIC_ACCION.has(t)).map(vicRaiz);
  const prefPres = vicPresDe(prefStr);

  // SKUs surfaceados que empatan con el mensaje del cliente (conjunto chico).
  const matched = [];
  const seenM = new Set();
  for (const r of surf) {
    if (vicRowMatchMsg(r, msgToks, msgPres) && !seenM.has(String(r.sku))) {
      seenM.add(String(r.sku)); matched.push(r);
    }
  }

  // "los dos"/"ambos"/"cotiza todo": el cliente quiere TODAS las familias en juego.
  // CLAVE (fix multi-item 2026-06-13): NO rehacer la seleccion desde cero — eso pierde
  // la VARIANTE que el cliente ya fijo. Se PRESERVA la seleccion vigente y solo se AGREGA
  // un representante de cada familia surfaceada aun NO cubierta. El representante por familia
  // es el que MAS empata con las preferencias acumuladas del cliente (caoba/cubeta), no el
  // primero arbitrario — asi "los dos" = barniz CAOBA + vinilica COPE cubeta, no ROBLE/Superior.
  const quiereTodo = aditivo && (/\b(los\s+dos|las\s+dos|ambos|ambas)\b/.test(m) || VIC_RE_TODO.test(m));
  if (quiereTodo) {
    // Por familia, el representante = max score de preferencia (tie -> orden surfaceado).
    const filasPorFam = new Map();   // familia -> [filas]
    for (const r of surf) {
      const f = vicFamiliaDeRow(r) || String(r.sku);
      if (!filasPorFam.has(f)) filasPorFam.set(f, []);
      filasPorFam.get(f).push(r);
    }
    const repPorFam = new Map();
    for (const [f, filas] of filasPorFam.entries()) {
      // Orden DETERMINISTA: mayor score de preferencia primero; empate -> SKU asc (estable
      // entre corridas, no depende del orden en que la tool surfaceo). Asi la variante
      // elegida es la misma 10/10 aunque el LLM cambie el orden de las tool-calls.
      const ord = filas.slice().sort((a, b) => {
        const sa = vicScorePref(a, prefToks, prefPres);
        const sb = vicScorePref(b, prefToks, prefPres);
        if (sb !== sa) return sb - sa;
        return String(a.sku) < String(b.sku) ? -1 : (String(a.sku) > String(b.sku) ? 1 : 0);
      });
      repPorFam.set(f, ord[0]);
    }
    const skuToFam = new Map();
    for (const r of surf) skuToFam.set(String(r.sku), vicFamiliaDeRow(r) || String(r.sku));
    const out = sel.slice();                                  // preserva variantes ya fijadas
    const famsCubiertas = new Set(out.map((s) => skuToFam.get(String(s.sku)) || String(s.sku)));
    const haveSku = new Set(out.map((s) => String(s.sku)));
    for (const [f, r] of repPorFam.entries()) {
      if (famsCubiertas.has(f)) continue;                    // esa familia ya tiene su variante
      if (haveSku.has(String(r.sku))) continue;
      famsCubiertas.add(f); haveSku.add(String(r.sku));
      out.push({ sku: String(r.sku), quantity: 1 });
    }
    return { action: 'add', selection: out };
  }

  // Sin match contra el conjunto surfaceado.
  if (!matched.length) {
    // "cotiza todo" / orden amplia con varias familias en mesa -> PREGUNTA (regla 4).
    if (VIC_RE_TODO.test(m)) {
      const fams = new Set(surf.map((r) => vicFamiliaDeRow(r) || String(r.sku)));
      if (fams.size > 1) {
        return { action: 'ask', selection: sel.slice(), candidatos: surf.slice() };
      }
      // Una sola familia surfaceada + "todo" -> esa es la seleccion (no hay ambiguedad).
      return { action: 'replace', selection: [{ sku: String(surf[0].sku), quantity: 1 }] };
    }
    // Cierre seco sin nombrar producto -> mantiene la seleccion vigente (regla 4b).
    return keep();
  }

  // Aditivo con producto nombrado: SUMA a la seleccion (regla 2).
  if (aditivo) {
    const out = sel.slice();
    const have = new Set(out.map((s) => String(s.sku)));
    for (const r of matched) {
      if (!have.has(String(r.sku))) { have.add(String(r.sku)); out.push({ sku: String(r.sku), quantity: 1 }); }
    }
    return { action: 'add', selection: out };
  }

  // Match unico, sin aditivo -> REEMPLAZA (cambio de opinion cross-familia O re-fija
  // dentro de la misma familia: en ambos casos la nueva seleccion es ese SKU) (reglas 1 y 3).
  if (matched.length === 1) {
    return { action: 'replace', selection: [{ sku: String(matched[0].sku), quantity: 1 }] };
  }

  // >1 match sin conector aditivo -> ambiguo: PREGUNTA enumerando (regla 4).
  return { action: 'ask', selection: sel.slice(), candidatos: matched };
}

// seleccionAItems(seleccion): [{sku, quantity}] -> items normalizados {sku, quantity>=1}.
// quantity invalida o ausente -> 1 (nunca 0/negativa). Filtra entradas sin sku.
function seleccionAItems(seleccion) {
  const sel = Array.isArray(seleccion) ? seleccion : [];
  const out = [];
  for (const s of sel) {
    if (!s || !s.sku) continue;
    const q = Math.trunc(Number(s.quantity));
    out.push({ sku: String(s.sku), quantity: (q > 0 ? q : 1) });
  }
  return out;
}

// filtrarSurfaceadoPorTexto(rows, textoAsistente)
//   rows           = filas crudas de la(s) tool(s) del turno [{sku, description, presentation, unit_price, familia}]
//   textoAsistente = la PROSA que el agente le mostro al cliente en este turno (su respuesta)
//   -> subconjunto de rows que el agente realmente NOMBRO/MOSTRO en su prosa.
//
// RAIZ DEL SWAP: las tools (sobre todo consultar_familia) devuelven TODA la familia
// (~150 filas) pero el agente solo MUESTRA 2-5. Persistir las 150 envenena el conjunto
// surfaceado y actualizarSeleccion matchea contra el pajar -> pega un SKU de otra familia.
// Aqui intersectamos las filas con la prosa: se queda solo lo que el agente mencionó.
//
// Criterio de mencion (cualquiera basta):
//   (a) el SKU EXACTO aparece como token en la prosa, O
//   (b) el PRECIO de la fila aparece en la prosa Y al menos un token DISTINTIVO de su
//       descripcion (sustantivo >=4, no presentacion/stopword) aparece en la prosa.
// (b) es la señal robusta: el agente casi nunca imprime el SKU crudo, pero SI imprime
//     "$2,252" + "VINILICA COPE". Precio + token distintivo evita falsos positivos
//     (dos familias rara vez comparten precio EXACTO y token).
// Generico (Regla de Oro): solo numeros/tokens, sin enumerar familias ni vocabulario.
// Fail-open: si la prosa esta vacia o NO se reconoce ningun precio en ella (el agente no
//   imprimio precios), NO se filtra (devuelve rows tal cual) para no perder señal valida.
// Stopwords de descripcion para el filtro: acabados/marcas/colores/usos GENERICOS que
// aparecen en MUCHAS familias (no distinguen producto). Sin enumerar familias (Regla de Oro):
// son adjetivos/marcas/usos transversales, no tipos de producto.
const VIC_DESC_STOP = new Set([
  'mate', 'satin', 'satinado', 'brillante', 'brill', 'base', 'para', 'con', 'sin',
  'parte', 'clasico', 'std', 'std.',
  'blanco', 'blanca', 'negro', 'gris', 'verde', 'oro', 'plata', 'bronce',
  'interior', 'exterior', 'interiores', 'exteriores', 'alto', 'alta', 'bajo',
  'solidos', 'transparente', 'transp', 'pastel', 'medio', 'media', 'deep', 'neutral', 'accent',
]);
// Tope de filas surfaceadas que se PERSISTEN por turno: ningun turno debe envenenar el
// carrito con un pajar de familia (D-anclaje). El agente realmente muestra <= ~8.
const VIC_SURFACED_CAP = 12;
// Extrae los numeros tipo-precio presentes en un texto: '$2,252' / '263.32' / '1,286.00'.
// Devuelve un Set de valores numericos (coma=millar, punto=decimal). Tolera el punto de
// fin de oracion pegado ('$577.' -> 577).
function vicPreciosEnTexto(texto) {
  const set = new Set();
  const s = String(texto || '');
  const re = /(\d[\d.,]*\d|\d)/g;
  let mm;
  while ((mm = re.exec(s)) !== null) {
    const raw = mm[1];
    // coma siempre como separador de millar; punto decimal solo si va seguido de 1-2 digitos.
    const norm = raw.replace(/,/g, '').replace(/\.(?!\d{1,2}(\D|$))/g, '');
    const n = Number(norm);
    if (Number.isFinite(n) && n >= 10) { set.add(Math.round(n * 100) / 100); }
  }
  return set;
}
// Tokens distintivos de una descripcion (deaccent, >=4, fuera de stopwords de presentacion/
// genericos). Singulariza para tolerar plural/genero leve.
function vicTokensDistintivos(desc) {
  return vicTokens(desc, 4)
    .map((t) => vicSingular(t))
    .filter((t) => t.length >= 4 && !VIC_PRES_TOK.has(t) && !VIC_DESC_STOP.has(t));
}
function filtrarSurfaceadoPorTexto(rows, textoAsistente) {
  const all = Array.isArray(rows) ? rows.filter((r) => r && r.sku) : [];
  if (!all.length) return [];
  const prosa = vicDeaccent(textoAsistente);
  // Fail-open ACOTADO: si no hay prosa o no hay precios reconocibles (p.ej. turno de COTIZAR
  // donde el LLM solo dice "te preparo la cotizacion" sin imprimir precios — esos los pone el
  // sistema, no el LLM), NO podemos intersectar. Devolvemos las filas SOLO si son pocas
  // (<= cap): nunca dumpear un pajar de familia. Las filas mostradas YA se capturaron en los
  // turnos anteriores (append-only); un turno de cierre no debe envenenar el carrito.
  if (!prosa) return all.length <= VIC_SURFACED_CAP ? all : [];
  const preciosProsa = vicPreciosEnTexto(textoAsistente);
  if (!preciosProsa.size) return all.length <= VIC_SURFACED_CAP ? all : [];
  // Acumula candidatos con un SCORE de fuerza de match para (1) decidir inclusion y (2) si
  // hay que recortar por el cap, conservar los mas fuertes (mas tokens distintivos en prosa).
  const cand = [];
  const seen = new Set();
  for (const r of all) {
    const sku = String(r.sku);
    if (seen.has(sku)) continue;
    // (a) SKU exacto en la prosa (token word-boundary, case/acentos ya normalizados) -> match fuerte.
    const skuLow = vicDeaccent(sku);
    const skuHit = skuLow.length >= 3 &&
      new RegExp('(^|[^a-z0-9])' + skuLow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(prosa);
    if (skuHit) { seen.add(sku); cand.push({ r: r, score: 100 }); continue; }
    // (b) precio EXACTO de la fila en la prosa + tokens DISTINTIVOS de su descripcion en la
    // prosa. EXIGENCIA: si la descripcion tiene >=2 tokens distintivos, hay que ver >=2 en la
    // prosa (un solo token generico residual no basta — eso filtra el pajar de familia donde
    // solo coinciden color/uso). Si la descripcion tiene 1 token distintivo, basta ese.
    const precio = (r.unit_price != null && Number.isFinite(Number(r.unit_price)))
      ? Math.round(Number(r.unit_price) * 100) / 100 : null;
    if (precio == null || !preciosProsa.has(precio)) continue;
    const toks = vicTokensDistintivos(r.description);
    if (!toks.length) continue;
    const hits = toks.filter((t) => prosa.includes(t)).length;
    const need = toks.length >= 2 ? 2 : 1;
    if (hits >= need) { seen.add(sku); cand.push({ r: r, score: hits }); }
  }
  // Cap de seguridad: si un turno (p.ej. un dump del LLM) hace pasar demasiadas filas,
  // conserva solo las VIC_SURFACED_CAP mas fuertes (mas tokens distintivos). Estable: score
  // desc, luego SKU asc. Asi ningun turno envenena el carrito con un pajar.
  cand.sort((a, b) => (b.score - a.score) || (String(a.r.sku) < String(b.r.sku) ? -1 : 1));
  let out = cand.map((c) => c.r);
  if (out.length > VIC_SURFACED_CAP) out = out.slice(0, VIC_SURFACED_CAP);
  // Si el filtro dejo el conjunto VACIO pero habia filas y precios, es probable que el
  // agente cerro sin re-mostrar precios o uso nombres muy distintos: fail-open al crudo
  // SOLO si el crudo es pequeño (<=8). Si el crudo es grande (pajar de familia), preferimos
  // el vacio antes que envenenar (el turno previo ya surfaceo lo bueno; append-only).
  if (!out.length && all.length <= 8) return all;
  return out;
}

// Export solo en Node (al embeberse en el nodo 11 de n8n no hay module).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ultimoProductoConfirmado, validarItemsCotizar, inferirSkuAfirmado,
    productosEnMesa, validarItemsContraMesa, vicEsCierreGenerico,
    STOCK_RE_AFIRMA, STOCK_RE_NIEGA, afirmaStockSinNegar,
    RE_DISPONIBILIDAD, clienteQuiereDisponibilidad, vicItemEsProducto,
    anclarTurnoActual, confirmadoAItem, anclarItemConfirmado, familiaTipoYExtra,
    actualizarSeleccion, seleccionAItems, filtrarSurfaceadoPorTexto,
  };
}
