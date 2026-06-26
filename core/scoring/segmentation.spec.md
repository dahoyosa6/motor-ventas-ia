# Spec: `core/scoring/segmentation` — clasificador de segmento del cliente en runtime

> **Owner técnico:** `core-architect` (frontera CORE/CONFIG) + `prompt-conversation-engineer` (capa LLM ligera).
> **Estado:** spec — pendiente de implementación (Sem 5, adelantado de pendiente 2026-05-24).
> **Aplica a:** Sem 5 (motor runtime). Lo consume `core/flows/discount_authorization.spec.md` §5.5.3 (resolución de segmento) y, vía `lead_state`, el resto de flows.
> **Fuentes de verdad:** `core/data_model/turn_envelope.spec.md` §2 (`lead_state`) · `core/tools/registrar_lead.spec.md` §3 (`customer_metadata.segment`), §4-5 (scoring BANT) · `core/flows/discount_authorization.spec.md` §5.5 (consumidor) · `core/utils/config_loader.spec.md` §3 (config del tenant) · `docs/core_invariant.md` §3 (tabla maestra, fila "Buyer personas / segmentos" = CONFIG) y §5.11.

---

## 1. Para qué existe este clasificador

Varios flows necesitan saber a qué **segmento** pertenece el cliente con el que se conversa (ej. `discount_authorization` §5.5 evalúa `segment_overrides` por segmento). El camino preferente es leer `customer.segment_id` ya persistido en la tabla `customers`. Pero ese campo **no siempre está poblado**: cliente nuevo, primer contacto, o cliente que cambió de comportamiento. Cuando no está, el motor necesita **inferir el segmento en runtime** a partir de las señales del turno y del historial.

Este componente es el paso 2 de la cadena de resolución de `discount_authorization.spec.md` §5.5.3:

```
1. customer.segment_id persistido        → usar directo
2. clasificador de segmento (ESTE spec)  → inferir con confidence
3. ninguno aplica                        → "indeterminado" → comportamiento conservador
```

**Por qué es CORE:** el *mecanismo* de tomar señales heterogéneas, puntuarlas contra un conjunto de segmentos definidos y devolver el más probable con una medida de confianza sirve a cualquier PyME comercial LATAM (una óptica clasifica "paciente recurrente vs primera consulta vs convenio empresarial"; una química industrial clasifica "comprador spot vs contrato marco"; una clínica dental clasifica "particular vs aseguradora"). Lo que cambia entre clientes —cuáles son los segmentos, qué señales los distinguen, qué umbral de confianza exigir— es **CONFIG del tenant**. El clasificador no conoce ningún segmento concreto; los recibe del config.

---

## 2. Input: señales disponibles

El clasificador opera sobre un `SegmentationContext` que el orquestador arma a partir del `TurnEnvelope` (no inventa datos; solo proyecta lo que ya viaja en el envelope):

```
SegmentationContext
├── tenant_slug: str                       # discriminador multi-tenant (D-42); obligatorio
├── inbound_text: str | None               # texto normalizado del turno actual (envelope.inbound.text)
├── context_history: list[ContextTurn]     # turnos previos (envelope.context_history, recortado)
├── lead_state: LeadState                  # snapshot BANT actual (envelope.lead_state)
│   └── usa: need.product_categories, budget.amount, authority.role, score, stage
├── product_categories_seen: list[str]     # categorías consultadas en la conversación (agregado de need + retrieval_hints)
├── monetary_signal: { amount: float | None, currency: str | None }
│                                           # monto consultado/cotizado más alto observado (lead_state.budget.amount)
├── channel: enum                          # envelope.channel ("whatsapp" | "webchat" | ...)
├── customer_history: CustomerHistory | None  # solo si customer_id resuelto
│   ├── total_purchases_12m: int | None
│   ├── avg_ticket: float | None
│   └── recency_days: int | None
└── candidate_segments: list[SegmentDef]   # CONFIG del tenant (ver §4); el set sobre el que se clasifica
```

**Invariantes del input:**
- `tenant_slug` obligatorio. Si falta → `SegmentationTenantMissing` (espejo de D-42 en esta capa). No se clasifica sin tenant.
- `candidate_segments` proviene **exclusivamente** del config del tenant (ver §4). Si viene vacío → resultado `indeterminado` directo (no hay contra qué clasificar). No es error.
- Todas las demás señales son opcionales; el clasificador degrada confianza ante ausencia, no falla.

---

## 3. Output: `SegmentationResult`

```
SegmentationResult
├── segment_id: str | None        # clave de un SegmentDef del config, o null si indeterminado
├── confidence: float             # 0.0–1.0
├── runner_up: { segment_id: str, confidence: float } | None  # 2.º más probable (para auditar ambigüedad)
├── status: enum                  # "classified" | "indeterminate"
├── method: enum                  # "rules" | "rules+llm" | "history" — qué ruta resolvió (auditoría)
├── signals_used: list[str]       # ej. ["product_categories","monetary_signal","authority.role"]
└── rationale: str                # explicación breve (≤ 200 chars) para Langfuse / debugging
```

**Regla de fallback explícito (CORE inviolable):**

```
si confidence < cfg.segmentation.min_confidence (default CORE 0.6):
    status = "indeterminate"
    segment_id = null
```

`status == "indeterminate"` significa **comportamiento conservador**: el consumidor (ej. `discount_authorization` §5.5.3) NO asume excepción/descuento; cae al camino por defecto (consultar al humano). Esto es coherente con `core_invariant.md` §5.11: "aplicar la regla sin segmento confirmado es peor que el ruido de una consulta extra." El clasificador **nunca** fuerza un segment_id por debajo del umbral solo para evitar el "indeterminado".

`min_confidence` es **calibrable por tenant** (CONFIG), pero tiene un piso CORE: no puede bajar de `0.5` (defensa contra clientes que aflojen el umbral hasta volver el fallback inútil). El mecanismo del umbral y su piso son CORE.

---

## 4. Frontera CORE/CONFIG: el clasificador es CORE, los segmentos son del tenant

El clasificador **no conoce ningún segmento concreto**. Los recibe como datos del config del tenant. Los segmentos concretos viven en `clients/<slug>/segments/buyer_personas.json` y se exponen al motor vía el loader como `cfg.segmentation.candidate_segments`.

Forma esperada de cada `SegmentDef` (mecanismo CORE; valores por-cliente). El motor lee estos campos genéricos; el contenido lo aporta el tenant:

```
SegmentDef
├── id: str                       # clave estable del segmento (CONFIG)
├── match_signals:                # pistas declarativas para el matcher por reglas (todas opcionales)
│   ├── product_categories: list[str]      # categorías típicas de ese segmento
│   ├── ticket_range: { min: float, max: float } | None
│   ├── authority_roles: list[str]         # roles que suelen mapear a este segmento
│   ├── timeline_horizons: list[str]       # horizontes BANT típicos
│   └── keyword_hints: list[str]           # frases/tokens característicos (matcheo laxo, ignora acentos/caso)
└── llm_description: str | None   # descripción en prosa para la ruta LLM ligera (§5)
```

**Auditoría de frontera:** este spec define la *forma* `SegmentDef`. El `buyer_personas.json` del primer cliente ya trae `calibracion_bant` (budget/authority/timeline) y `frases_tipicas` por persona; un adaptador en `config_loader` proyecta esos campos del tenant al `match_signals` genérico. Ese mapeo concreto (qué campo del JSON del cliente alimenta qué `match_signal`) es responsabilidad del loader y se documenta en `core/utils/config_loader.spec.md`, no aquí — y nunca con literales del cliente en `core/`.

El motor NUNCA importa de `clients/` (R2); todo llega vía `cfg`. El motor NUNCA menciona un id de segmento concreto (R1); los ids viajan como strings opacos en `candidate_segments`.

---

## 5. Algoritmo: reglas primero, LLM ligero como desempate (deuda/trade-offs)

Decisión de diseño Sem 5: **híbrido reglas + LLM ligero**, con reglas como capa primaria.

### 5.1. Ruta A — matcher por reglas (CORE, determinista, barato)

Para cada `SegmentDef` se computa un score de afinidad ponderado sobre las señales presentes:

```
afinidad(seg) = Σ_signal  w_signal * match(signal, seg.match_signals) / Σ_signal w_signal_presente
```

donde `match()` ∈ [0,1]:
- `product_categories`: solapamiento Jaccard entre `ctx.product_categories_seen` y `seg.match_signals.product_categories`.
- `ticket_range`: 1.0 si `monetary_signal.amount` cae dentro del rango; decae linealmente fuera.
- `authority_roles`: 1.0 si `lead_state.authority.role` ∈ lista; 0 si no; señal omitida si role es null.
- `timeline_horizons`: 1.0 si `lead_state.timeline.horizon` ∈ lista.
- `keyword_hints`: fracción de hints presentes en `inbound_text` + `context_history` (match laxo, ignora acentos/caso, igual que `discount_authorization` §5.2).

Pesos por defecto CORE iguales por señal; **calibrables** vía `cfg.segmentation.weights` (mismo patrón que `bant_thresholds.weights` en `registrar_lead.spec.md` §5). Señales ausentes se excluyen del denominador (no penalizan, solo reducen evidencia → menor confianza final).

`confidence` de la ruta de reglas = afinidad del ganador, atenuada por **cobertura de evidencia** (fracción de señales con datos): poca evidencia → confianza tope más baja aunque la afinidad sea alta. Esto empuja a "indeterminado" cuando hay poco que observar (cliente nuevo, primer turno), que es exactamente el caso conservador deseado.

### 5.2. Ruta B — LLM ligero (desempate acotado)

Se invoca **solo** cuando la ruta de reglas es ambigua: ganador y `runner_up` dentro de un margen `cfg.segmentation.llm_tiebreak_margin` (default CORE 0.15) **y** ambos por encima de un piso mínimo. NO se llama al LLM en el caso de baja evidencia (ahí la respuesta correcta es "indeterminado", no gastar tokens).

El LLM recibe: `inbound_text` + resumen del `context_history` + las `llm_description` de los 2-3 candidatos top. Devuelve `{segment_id, confidence, rationale}`. El `segment_id` devuelto **debe** pertenecer a los candidatos pasados; si alucina uno fuera del set → se descarta y se retorna `indeterminate` (defensa CORE). El resultado se combina con el de reglas (promedio ponderado, reglas pesan más) — `method = "rules+llm"`.

### 5.3. Trade-offs registrados

- **Reglas-first** porque son auditables, deterministas, sin costo por turno y suficientes para los segmentos de alto contraste (B2B alto ticket vs mostrador chico). Riesgo: rigidez ante segmentos solapados.
- **LLM solo en empate** acota costo (no se paga por turno) y latencia, manteniendo la decisión final dentro del set cerrado del config. Riesgo: dependencia del prompt; mitigado por el guard de "segment_id debe ∈ candidatos".
- **Deuda Sem 7+:** clasificador entrenado/embeddings sobre historial real del tenant una vez haya volumen de conversaciones etiquetadas. Hoy no hay datos de conversación suficientes; sería sobre-ingeniería. Registrado como deuda, no se implementa ahora.
- **No persistencia automática:** un resultado en runtime con confidence alta NO escribe `customers.segment_id` por sí solo. La promoción de un segmento inferido a segmento persistido pasa por `registrar_lead` (§6), que es el único side-effect autorizado sobre `customers`. Razón: separar inferencia (read-only) de escritura de estado.

---

## 6. Integración con `registrar_lead` y el envelope (`lead_state`)

El clasificador es **read-only sobre el estado**; no muta `customers` ni `conversations`. Su salida se integra así:

1. **Lectura del estado vigente:** el `SegmentationContext` se arma del `TurnEnvelope.lead_state` (snapshot BANT) más las categorías/montos observados. El clasificador no lee la base directamente; consume lo que el orquestador ya cargó en el envelope.

2. **Escritura del segmento (vía `registrar_lead`, no directa):** cuando el agente, en un turno, decide consolidar el segmento inferido, lo pasa por `registrar_lead` en `customer_metadata.segment` (`registrar_lead.spec.md` §3 ya tiene el campo `segment: string`). Ese es el **único** camino que persiste `customers.segment` (side-effect §7.2 de `registrar_lead`). El clasificador NUNCA escribe directo.

3. **Relación con `lead_state`:** el segmento NO es un campo del `lead_state` del envelope (que es estrictamente BANT: budget/authority/need/timeline/score/stage). El segmento es un atributo de `customer`, no del estado conversacional BANT. Por tanto:
   - Entrada al clasificador: `lead_state` (BANT) es una **señal** (§2), no el output.
   - El resultado del clasificador alimenta `customer_metadata.segment` vía `registrar_lead`, que lo escribe en `customers`, desde donde futuros turnos lo leerán como `customer.segment_id` (camino 1, sin reclasificar).
   - **Propuesta de ajuste** (ver §8): exponer `customer.segment_id` en el bloque `customer` del `TurnEnvelope` para que el camino 1 de `discount_authorization` §5.5.3 lo encuentre sin query extra. Hoy el envelope §2 tiene `customer.customer_id` pero no `segment_id`.

4. **Auditoría del turno:** el `SegmentationResult` se adjunta al span Langfuse del turno (`rationale`, `method`, `confidence`, `signals_used`). Si `status == "indeterminate"`, el span se etiqueta `segment = "indeterminate"` para medir cobertura del clasificador en producción.

---

## 7. Errores específicos

| Código | Cuándo | Acción |
|---|---|---|
| `SegmentationTenantMissing` | `tenant_slug` null/vacío en el contexto | Abortar; no clasificar (espejo D-42). Alerta a observabilidad. |
| `SegmentationNoCandidates` | `candidate_segments` vacío | NO es error: retorna `status="indeterminate"`, `method="rules"`. Warning a logs (config sin segmentos declarados). |
| `SegmentationLLMOutOfSet` | La ruta B devuelve un `segment_id` fuera de los candidatos | Descartar respuesta LLM; retornar `indeterminate`. Loguear texto para mejora del prompt. |
| `SegmentationLLMTimeout` | El LLM ligero excede su timeout | Degradar al resultado de la ruta de reglas; `method="rules"`. No bloquear el turno. |
| `SegmentationConfigInvalid` | `cfg.segmentation.min_confidence < 0.5` (piso CORE) o pesos malformados | Usar defaults CORE; warning. El config no puede romper el piso. |

---

## 8. Ajustes pendientes en specs previos

> **NO se editan aquí.** Se listan para que el `core-architect` los proponga al PM como spec/migration/config updates separados.

1. **`core/utils/config_loader.spec.md` §3:** añadir `segmentation: SegmentationPolicy | None` con campos `min_confidence: float (default 0.6, piso 0.5)`, `weights: dict[str,float] | None`, `llm_tiebreak_margin: float (default 0.15)`, `candidate_segments: list[SegmentDef]`. Documentar el adaptador que proyecta `buyer_personas.json` del cliente (`calibracion_bant`, `frases_tipicas`, `product` hints) a `SegmentDef.match_signals` genérico. Default `None` → clasificador siempre retorna `indeterminate` (comportamiento conservador, sin romper).
2. **`core/utils/schema/client_config.schema.json`:** añadir `$defs.SegmentationPolicy` y `$defs.SegmentDef` con las validaciones (`min_confidence` ≥ 0.5 && ≤ 1.0; `ticket_range.min` ≤ `ticket_range.max`).
3. **`core/data_model/turn_envelope.spec.md` §2:** añadir `customer.segment_id: str | None` al bloque `customer` (hoy solo hay `customer_id`). Necesario para el camino 1 de `discount_authorization` §5.5.3 sin query extra. Espejo en §6 (persistencia) → `customers.segment`.
4. **`core/flows/discount_authorization.spec.md` §5.5.3:** actualizar la referencia "(ver `core/scoring/segmentation.spec.md` cuando exista)" — ya existe; este spec materializa el paso 2 de su cadena de resolución.
5. **`core/tools/registrar_lead.spec.md` §3:** sin cambio de shape (`customer_metadata.segment` ya existe). Añadir nota: es el único camino de escritura de `customers.segment`; el clasificador es read-only.
6. **`docs/core_invariant.md` §5 (caso nuevo §5.22 propuesto):** "Clasificador de segmento en runtime: el MECANISMO de scoring (reglas + LLM ligero de desempate, umbral de confianza con piso CORE 0.5, fallback explícito a `indeterminate` → comportamiento conservador) es CORE. Los segmentos concretos, sus señales y el `min_confidence` calibrado son CONFIG del tenant (`buyer_personas.json` proyectado a `candidate_segments`). El clasificador es read-only; la persistencia del segmento pasa solo por `registrar_lead`." Lo registra el PM; no se hace en este sprint.
7. **`core/scoring/i18n/` (nuevo subdir, deuda implementación):** si los `keyword_hints` del matcher se internacionalizan, viven aquí por idioma. Hoy el matcheo laxo opera sobre los hints del config del tenant; no requiere i18n CORE inmediato.

---

## 9. Auditoría R1/R2 sobre este spec

- **R1 (sin literales de un cliente concreto):** ningún nombre de empresa, marca, ciudad o persona de un cliente real aparece en este archivo. Los segmentos concretos (los ids del `buyer_personas.json` del tenant) NO se nombran; viajan como strings opacos en `candidate_segments`. Los ejemplos de verticales (óptica, química industrial, clínica dental) son sustantivos del dominio "PyME comercial LATAM", no clientes del proyecto. Cumple.
- **R2 (no `import` desde `clients/`):** el clasificador consume su universo de segmentos exclusivamente vía `cfg.segmentation.candidate_segments`, provisto por `core/utils/config_loader.spec.md`. Cero rutas hardcodeadas a `clients/`. Cumple.
