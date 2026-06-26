# Suite de evaluación (evals) del agente

Esta carpeta contiene el **harness de evaluación** del agente de ventas: la
maquinaria que mide su calidad de forma reproducible, antes y después de cada
cambio. Tres niveles, de más barato a más caro:

| Nivel | Script | Qué mide |
|---|---|---|
| 1. Retrieval | `run_rag_eval.py` | ¿La búsqueda semántica encuentra el SKU correcto del catálogo? (recall@K) |
| 2. Agente completo | `run_agent_eval.py` | Corre el agente end-to-end y evalúa su respuesta con checks deterministas + un juez LLM opcional |
| 3. Extracción BANT | `run_bant_live_eval.py` | Compara la calificación BANT en vivo (budget/authority/need/timeline) contra una etiqueta de referencia |

> **Nota sobre los datos.** En este repositorio público los datasets son
> **100% sintéticos**: usan el catálogo demo de `clients/clinica_demo/`
> (14 SKUs ficticios `CD-001`…`CD-014`) y conversaciones inventadas. Sirven
> para demostrar que la suite corre, no para reproducir números de un cliente
> real. En el proyecto original los datasets se construyen sobre el catálogo y
> las conversaciones del tenant, y las etiquetas de referencia las valida un
> humano del negocio.

## Archivos

| Archivo | Qué es |
|---|---|
| `run_rag_eval.py` | Eval de recall del RAG: embebe cada query, hace retrieval vía `match_products`, calcula recall@1/@3/@5. |
| `run_agent_eval.py` | Eval conversacional: corre el agente sobre cada caso y aplica checks deterministas (`must_contain_any`, `must_not_match`, `price_grounded`, `expect_escalation`) + rúbrica LLM-as-judge. |
| `run_bant_live_eval.py` | Eval en vivo de la extracción BANT contra fixtures de referencia. |
| `run_eval_with_transcripts.py` | Envoltorio que corre `run_agent_eval` y emite un reporte con transcripciones legibles. |
| `aggregate_kpis.py` | Agrega varios resultados crudos en KPIs comparables entre corridas. |
| `agent_demo_cases.jsonl` | Casos conversacionales sintéticos (nivel 2). |
| `rag_groundtruth.jsonl` | Queries ground truth sintéticas (nivel 1). |
| `bant_demo_fixtures.jsonl` | Fixtures BANT sintéticos (nivel 3). |
| `schema/agent_eval_case.schema.json` | JSON Schema que valida cada caso conversacional. |
| `schema/rag_groundtruth.schema.json` | JSON Schema que valida cada query de retrieval. |

## Pre-requisitos

1. `.env` con `OPENAI_API_KEY` (embeddings), `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`, y `ANTHROPIC_API_KEY`
   (para el juez LLM del nivel 2). Ver `.env.example`.
2. Catálogo del tenant ingestado en Supabase (`products` + `product_embeddings`).
3. Función SQL `match_products` aplicada (retrieval con `filter_tenant`).
4. Para los niveles 2 y 3, una instancia local del orquestador (n8n en `:5678`).

## Correr

```bash
# Nivel 1 — retrieval (solo lectura, barato)
python3 tests/evals/run_rag_eval.py
python3 tests/evals/run_rag_eval.py --k 10     # top-K mayor
python3 tests/evals/run_rag_eval.py --json     # payload JSON crudo

# Nivel 2 — agente completo
python3 tests/evals/run_agent_eval.py                 # todo + reporte
python3 tests/evals/run_agent_eval.py --no-judge      # solo checks deterministas
python3 tests/evals/run_agent_eval.py --dry-run       # valida dataset + payloads, sin red

# Nivel 3 — extracción BANT en vivo
python3 tests/evals/run_bant_live_eval.py --dry-run
```

## Métricas

- **recall@K** (nivel 1, sobre las queries positivas): el SKU esperado
  (`expected_any_of`) aparece en el top-K recuperado. Se reporta @1, @3, @5.
- **Negativas** (nivel 1): se evalúa lo contrario — que NO aparezca un match
  espurio de alta similitud. Un score ≥ `SCORE_ALERT_THRESHOLD` (0.45) se marca
  como riesgo de falso positivo. Ese umbral es heurístico de reporte, no el
  umbral de producción.
- **pass rate** (nivel 2): un caso pasa solo si TODOS sus checks pasan. Los
  checks deterministas cubren los guardrails inviolables (no inventar precio,
  disclosure, escalamiento, formato); el juez LLM evalúa tono y pertinencia.
- **accuracy BANT** (nivel 3): coincidencia por dimensión contra la etiqueta de
  referencia. Se excluyen las dimensiones sin referencia confiable.

## Decisiones de diseño

- El retrieval usa la función SQL `match_products` vía RPC — la **misma**
  función que usan los nodos del orquestador. El eval prueba el camino real,
  no un atajo.
- `filter_tenant` se pasa **explícito** en cada RPC. La función lo exige como
  predicado SQL de primera clase; un filtro olvidado sería fuga de datos
  cross-tenant. Hay un caso de eval dedicado al aislamiento entre tenants.
- **Reproducibilidad:** mismo catálogo + mismo ground truth + mismo modelo de
  embeddings ⇒ mismos números (`hnsw.ef_search` fijado dentro de
  `match_products`). La extracción BANT (nivel 3) es no-determinista aun a
  temperatura 0, así que se usa como señal, no como gate estricto.
