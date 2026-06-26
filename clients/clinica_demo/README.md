# clinica_demo — tenant de prueba (multi-tenant)

**No es un cliente real.** Este directorio existe únicamente para validar
**T1 — la Regla de Oro** de la arquitectura: demostrar que cambiar de
cliente se hace tocando solo `clients/<cliente>/`, sin modificar el motor
ni el workflow del orquestador.

## Contenido

| Archivo | Qué es |
|---|---|
| `config.yml` | Punto de entrada del tenant. Mismo esquema para todo cliente, valores distintos. |
| `prompts/tono.md` | Tono formal de clínica (de "usted") — distinto a propósito del de otros tenants. |
| `prompts/sobre_empresa.md` | Descripción ficticia de la clínica. |
| `catalog/catalogo_clinica_demo.csv` | Mini-catálogo: 14 insumos médicos ficticios (SKUs `CD-001`…`CD-014`). |

## Cómo se ingesta el catálogo

```bash
python3 scripts/ingest_catalog_to_pgvector.py \
  --tenant clinica_demo \
  --csv clients/clinica_demo/catalog/catalogo_clinica_demo.csv
```

El tenant se registra antes en la tabla `tenants`. Los 14 productos viven
en `products` + `product_embeddings` con `tenant_slug='clinica_demo'`,
aislados de los catálogos de cualquier otro tenant por el parámetro
`filter_tenant` de `match_products`.

## Cómo se prueba T1

```bash
curl -X POST http://localhost:5678/webhook-test/poc-agente \
  -H 'Content-Type: application/json' \
  -d '{"client_slug":"clinica_demo","message":"¿qué guantes tienen?","phone":"+5215555559999"}'
```

**Pasa si** la respuesta sale con el tono de la clínica y cita SKUs `CD-*`,
**sin tocar el JSON del workflow**. Falla si aparece cualquier rastro de
otro tenant.
