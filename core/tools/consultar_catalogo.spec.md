# Spec: tool `consultar_catalogo`

> **Owner técnico:** `core-architect`
> **Estado:** spec — interface YA materializada en SQL (migration `0003_match_products_require_tenant`); falta wrapper Python/orquestador.
> **Aplica a:** Sem 3 (POC ya la usa vía nodo Supabase Vector Store), Sem 4-5 (wrapper tipado).
> **Fuentes de verdad:** `core/tools/contracts.spec.md` · `infra/supabase/migrations/0002_langchain_compat.sql` + `0003_match_products_require_tenant.sql` · `docs/core_invariant.md` §5.10.

---

## 1. Propósito

Búsqueda semántica + filtros sobre el catálogo del tenant. Es el primer paso para casi cualquier turno donde el cliente menciona producto.

**No** verifica stock (eso es `consultar_stock`). **No** cotiza (eso es `cotizar`).

---

## 2. Descripción para el LLM

> "Busca productos en el catálogo por descripción libre, marca, categoría o presentación. Devuelve hasta N coincidencias ordenadas por relevancia semántica. Úsala SIEMPRE que el cliente mencione un producto antes de cotizar o de verificar stock. NO la uses para confirmar disponibilidad — eso es `consultar_stock`."

---

## 3. Input schema

```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 2,
      "maxLength": 500,
      "description": "Texto libre que describe el producto buscado (lo que dijo el cliente)."
    },
    "top_k": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20,
      "default": 5
    },
    "filter": {
      "type": "object",
      "description": "Filtros estructurales (subset de metadata).",
      "properties": {
        "brand":        { "type": "string" },
        "category":     { "type": "string" },
        "presentation": { "type": "string" },
        "sku":          { "type": "string" }
      },
      "additionalProperties": false
    },
    "min_similarity": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "default": 0.35,
      "description": "Threshold mínimo de similitud coseno. Hits debajo se descartan."
    }
  }
}
```

**`tenant_slug` NO está en el input schema** porque viene del `ToolContext` y es defensa: el LLM no puede sobreescribirlo.

---

## 4. Output schema (`data`)

```json
{
  "type": "object",
  "required": ["hits", "query_used"],
  "properties": {
    "hits": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["sku", "description", "similarity"],
        "properties": {
          "sku":          { "type": "string" },
          "description":  { "type": "string" },
          "brand":        { "type": "string" },
          "category":     { "type": "string" },
          "presentation": { "type": "string" },
          "unit_price":   { "type": ["number","null"], "description": "null cuando el SKU es de precio variable no resoluble en catálogo (D-48): el precio depende de un atributo que el cliente aún no eligió. En ese caso vienen price_range y requires_attribute." },
          "price_range":  {
            "type": ["object","null"],
            "description": "D-48: presente cuando el SKU lleva extra.price_variability y unit_price=null. Rango de precio del SKU según el atributo. El agente comunica 'desde {min}'; NO dicta un precio cerrado.",
            "properties": {
              "min":      { "type": "number" },
              "max":      { "type": "number" },
              "currency": { "type": "string" }
            }
          },
          "requires_attribute": { "type": ["string","null"], "description": "D-48: nombre del atributo que el cliente debe elegir para resolver el precio (ej. 'color', 'graduacion', 'concentracion', 'medida'). null cuando unit_price es fijo. El agente lo pide antes de cotizar." },
          "currency":     { "type": "string" },
          "similarity":   { "type": "number" },
          "attachments":  {
            "type": "array",
            "description": "Fichas técnicas, fotos, etc. que el agente puede adjuntar.",
            "items": { "$ref": "#/$defs/OutboundMedia" }
          }
        }
      }
    },
    "query_used": { "type": "string" },
    "total_matches_before_threshold": { "type": "integer" },
    "data_freshness": {
      "type": "object",
      "properties": {
        "catalog_ingested_at": { "type": "string", "format": "date-time" },
        "catalog_checksum":    { "type": "string" }
      }
    }
  }
}
```

**`summary`:** `"Encontré N productos para '<query>': <top-3 descripciones>"`. Si `hits == []`: `"No encontré productos para '<query>' (catálogo de N SKUs)."`.

**Precio variable por atributo (D-48 — §5.21 Core Invariant).** Cuando un hit lleva `extra.price_variability` (key canónica; override raro vía `QuotePolicy.price_variability_attribute_key`), el motor devuelve `unit_price=null`, `price_range={min,max,currency}` y `requires_attribute=<atributo>`. El agente NO dicta un precio: comunica el rango ("desde {min}") y pide el atributo (color/graduación/concentración/medida). Sin `price_variability`, el hit trae `unit_price` fijo del export y `price_range=null`/`requires_attribute=null` (comportamiento legacy). Esto refuerza el guardrail estructural §3 "no inventar precios".

---

## 5. Implementación (mapping a `match_products`)

```python
def consultar_catalogo(input: ConsultarCatalogoInput, ctx: ToolContext) -> ToolOutput:
    embedding = embed(input.query)  # OpenAI text-embedding-3-small
    rows = supabase.rpc("match_products", {
        "query_embedding": embedding,
        "match_count":     input.top_k,
        "filter":          input.filter or {},
        "filter_tenant":   ctx.tenant_slug,   # OBLIGATORIO — sin default (D-42)
    })
    hits = [
        normalize(row) for row in rows
        if row["similarity"] >= input.min_similarity
    ]
    return ToolOutput(
        status="ok",
        data={
            "hits": hits,
            "query_used": input.query,
            "total_matches_before_threshold": len(rows),
            "data_freshness": get_catalog_freshness(ctx.tenant_slug),
        },
        summary=build_summary(hits, input.query),
    )
```

---

## 6. Errores específicos

| Código | Cuándo | Acción |
|---|---|---|
| `CATALOG_EMBEDDING_UNAVAILABLE` | OpenAI embeddings caído | Reintentar 1x; si falla, retornar `status=error` con sugerencia de búsqueda por SKU exacto |
| `CATALOG_TENANT_HAS_NO_PRODUCTS` | `match_products` retorna [] y `count(products WHERE tenant_slug=X) == 0` | `status=error` `code=CATALOG_EMPTY`; el agente NO inventa stock, ofrece escalar |
| `TOOL_TENANT_MISMATCH` | (genérico) | Abortar |

---

## 7. Idempotencia y caching

- **Idempotente:** misma query + tenant + filter → mismo resultado (mientras el catálogo no se re-ingiera).
- **Cache:** sha256(query + filter + tenant_slug) con TTL 5 min. Reduce costo de embeddings en turnos consecutivos.
- **Invalidación:** cualquier escritura a `products` o `product_embeddings` del tenant invalida el cache de ese tenant (Sem 5+ vía Supabase Realtime; Sem 3 acepta TTL puro).

---

## 8. Tenant scoping (test de cumplimiento)

Caso de prueba T1 obligatorio:
1. `ctx.tenant_slug = "clinica_demo"`, `input.query = "<query genérica de otro vertical>"` (un término que sólo existe en otro tenant `<tenant_slug_A>`).
2. Resultado esperado: `hits == []` (clinica_demo no tiene vinílicas).
3. Si retorna hits del tenant `<tenant_slug_A>` → bug crítico, falla T1.

---

## 9. Atajos y composiciones

- Si el cliente pregunta por SKU exacto (regex `[A-Z0-9]{3,12}`), llamar con `filter.sku=...` y `top_k=1` antes de hacer búsqueda semántica. Ahorra costo de embedding.
- Después de un hit con `similarity >= 0.85`, el agente puede encadenar directo a `consultar_stock(sku)` sin pedir confirmación al cliente.

---

## 10. Ajustes pendientes

- (ninguno bloqueante; el SQL ya existe y filter_tenant ya es requerido).
- Considerar añadir un campo `data_freshness.catalog_ingested_at` a `products` (timestamp del último upsert por tenant) — pendiente migration futura.
