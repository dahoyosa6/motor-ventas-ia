# Spec: tool `consultar_stock`

> **Owner técnico:** `core-architect`
> **Estado:** spec — pendiente de implementación (Sem 4-5)
> **Aplica a:** Sem 3 (POC: stub que retorna "verde" — el inventario real entra Sem 4), Sem 4-5 (lectura real del export diario)
> **Fuentes de verdad:** `core/tools/contracts.spec.md` · documento de umbrales de stock del tenant de referencia (`clients/<tenant_slug>/policies/`) como inspiración conceptual — el spec NO importa de `clients/` · D-43 (un solo export diario).

---

## 1. Propósito

Determina el estado de disponibilidad de uno o varios SKUs **en este momento**, según el último export diario de inventario ingestado.

Es la tool más sensible al "fresh data": si el export tiene más de 24h, la respuesta se degrada explícitamente.

---

## 2. Descripción para el LLM

> "Verifica disponibilidad actual de uno o varios productos por SKU. Devuelve un estado por SKU: `disponible`, `bajo` (vende con disclaimer), `agotado`, o `sobre_pedido` (no se promete stock). Si los datos están desactualizados (>24h), lo dice explícitamente y debes aclarárselo al cliente con `'lo confirmo y te aviso'`. Úsala SIEMPRE antes de prometer una venta. NO la uses para responder preguntas de catálogo — eso es `consultar_catalogo`."

---

## 3. Input schema

```json
{
  "type": "object",
  "required": ["items"],
  "properties": {
    "items": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "required": ["sku"],
        "properties": {
          "sku":      { "type": "string" },
          "quantity": { "type": "number", "minimum": 0.001, "default": 1 }
        }
      }
    }
  }
}
```

---

## 4. Output schema (`data`)

```json
{
  "type": "object",
  "required": ["items", "snapshot"],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["sku", "status"],
        "properties": {
          "sku":            { "type": "string" },
          "status":         { "enum": ["disponible","bajo","agotado","sobre_pedido","desconocido"] },
          "available_qty":  { "type": ["number","null"] },
          "requested_qty":  { "type": "number" },
          "status_reason":  { "type": "string", "description": "Frase humana corta — el agente puede citarla literal" },
          "policy_flags":   {
            "type": "array",
            "description": "Reglas duras adicionales aplicables (ej. 'siempre_escala_humano', 'minimo_de_venta_20L'). Vienen del bundle de políticas del cliente.",
            "items": { "type": "string" }
          }
        }
      }
    },
    "snapshot": {
      "type": "object",
      "required": ["ingested_at", "age_hours", "source"],
      "properties": {
        "ingested_at": { "type": "string", "format": "date-time" },
        "age_hours":   { "type": "number" },
        "source":      { "type": "string", "description": "ej. 'export_inventario_diario' — vocabulario CORE, no nombra el ERP" },
        "stale":       { "type": "boolean", "description": "true si age_hours > 24" }
      }
    }
  }
}
```

**`summary` examples:**
- `"Verde para SKU X (15 unid disponibles, dato de hoy)."`
- `"Amarillo para SKU X (3 unid, debajo del mínimo). Vende con aviso."`
- `"Rojo para SKU X (agotado). Ofrece alternativa o escala."`
- `"Sobre pedido SKU X (no se promete fecha)."`
- `"Datos antiguos (35h). Confirmo y aviso."`

---

## 5. Estados — semántica CORE

Los **estados** son CORE (mecanismo); los **umbrales** son CONFIG.

| Estado | Significado universal | Decisión del agente |
|---|---|---|
| `disponible` | Existencia ≥ mínimo configurado y ≥ cantidad pedida | Vende normal |
| `bajo` | Existencia > 0 pero debajo del mínimo (vendible) | Vende con disclaimer al cliente; persistir flag para reorder humano |
| `agotado` | Existencia ≤ 0 o < cantidad pedida | NO promete; ofrece alternativa o escala |
| `sobre_pedido` | Producto sin stock objetivo (min=0, max=0) — no se mantiene | NO promete; confirma con humano antes |
| `desconocido` | SKU no está en el snapshot (o no tiene umbrales) | NO promete; escala o llama `consultar_catalogo` |

Las **condiciones** que mapean datos crudos a estos estados están en el bundle de políticas del cliente (ej. `policies.stock_thresholds`). La tool aplica el bundle, no las redefine.

---

## 6. Fuente de datos (D-43 alineado)

Lee del **último export diario de inventario** ingestado en `processed_data/<tenant>/inventory/snapshot_latest.csv` (o ruta declarada en `cfg.paths.inventory_snapshot`).

**Importante:** según D-43 (2026-05-23), el único export diario garantizado del ERP es el de Artículos (inventario + precios + catálogo). Cotizaciones / Clientes / Proveedores son snapshots ad-hoc → **`consultar_stock` NO depende de ellos**.

Mecanismo de lectura:
1. `cfg.paths.inventory_snapshot` (lazy path desde `ClientConfig`) → CSV con columnas `sku, qty_on_hand, inv_min, inv_max, last_movement`.
2. La tool lee el CSV una vez y cachea en memoria por (tenant, mtime) durante 5 min.
3. Si el archivo no existe o `now - mtime > 24h`, el `snapshot.stale = true` y todos los items vienen con `status_reason` mencionándolo.

**Por qué CSV y no DB:** el export del ERP es un archivo. Mantener una tabla `inventory` en Supabase requiere ETL adicional Sem 5+. Para Sem 4 el CSV es suficiente y trazable (lo deja el cron del ingestor).

**Ajuste pendiente:** añadir `paths.inventory_snapshot` al schema del `config.yml` y al `ClientConfig` (§10).

---

## 7. Stale data — política

| `age_hours` | Comportamiento |
|---|---|
| 0 – 24 | Operación normal. `snapshot.stale = false` |
| 24 – 48 | `stale = true`. Cada item lleva `status_reason` con "según info de ayer". El agente debe verbalizarlo. |
| > 48 | `stale = true` + `status_reason` "datos con más de 2 días"; **`status` se degrada** a `desconocido` para todos los items independientemente del valor crudo. Razón: a partir de 48h el motor no puede prometer nada responsablemente. |
| Sin snapshot | `status = desconocido` para todos los items; `summary` indica "no tengo info actualizada de inventario, déjame consultar con un asesor". |

**Decisión CORE:** los umbrales 24h y 48h son CORE (no calibrables por cliente). Razón: la responsabilidad de "no prometer datos viejos" es estructural (Core Invariant §3 "no inventar precios, no prometer fechas"). Si un cliente quisiera permitir más laxitud, sería bug.

---

## 8. Errores específicos

| Código | Cuándo | Acción |
|---|---|---|
| `STOCK_SNAPSHOT_MISSING` | No hay snapshot para este tenant | `status=partial`, devolver `desconocido` para todos los items, NO abortar |
| `STOCK_SKU_NOT_IN_SNAPSHOT` | SKU específico no aparece en CSV | item.status = `desconocido` (no error global) |
| `STOCK_POLICY_HARD_RULE` | El SKU dispara una regla dura del cliente (ej. "siempre escala") | item.policy_flags incluye la regla; el agente debe respetarla aunque haya stock |
| `TOOL_DATA_STALE` | age_hours > 48 | (genérico) `status=partial`; degrade total a `desconocido` |
| `TOOL_TENANT_MISMATCH` | (genérico) | Abortar |

---

## 9. Idempotencia

Trivialmente idempotente (read-only). Cache: sha256(`tenant_slug` + `sorted(skus)` + `snapshot.mtime`) con TTL 60s.

---

## 10. Ajustes pendientes en specs previos

1. **`core/utils/config_loader.spec.md` §3:** añadir al `ClientConfig`:
   ```
   inventory_snapshot_path: Path | None    # lazy, ruta resuelta
   stock_policy: StockPolicy | None        # parseado del archivo de umbrales del cliente
   ```
   `StockPolicy` contiene los estados (sobre_pedido, critico, bajo, normal) con sus condiciones (lookup_field, comparators) y las reglas duras (`hard_rules: list[{name, accion}]`). El parseo es CORE; el contenido es CONFIG.

2. **`docs/core_invariant.md` §5:** caso §5.14 nuevo — "Umbrales de stale para inventario (24h/48h) son CORE inviolables. Los umbrales de stock-bajo son CONFIG."

3. **`core/utils/schema/client_config.schema.json`:** añadir clave opcional `paths.inventory_snapshot` (string ruta relativa).
