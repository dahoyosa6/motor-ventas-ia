# core/ — Motor del agente

> Esta carpeta contiene el **CORE** del agente: lógica genérica, agnóstica al cliente, que se ejecuta igual para una ferretería, una distribuidora veterinaria, una óptica o una clínica dental.

## Regla de Oro aplicada a este directorio

> **NADA aquí dentro puede referenciar un cliente concreto.**

Concretamente, en cualquier archivo de `core/`:

- ❌ Prohibido cualquier nombre de empresa, marca, ciudad o persona de un cliente real.
- ❌ Prohibido leer rutas como `clients/<un_cliente>/...` hardcodeadas.
- ❌ Prohibido tomar el precio de un producto específico, o reglas de descuento concretas.
- ❌ Prohibido decir "el rango de ticket promedio es $2,500 MXN".
- ✅ Permitido referenciar `{{NOMBRE_EMPRESA}}`, `{{TICKET_PROMEDIO_MXN}}`, `{{TONO}}`, `{{CATALOGO}}` como placeholders.
- ✅ Permitido leer la ruta `clients/{cliente_activo}/...` donde `cliente_activo` viene de una variable de entorno o argumento.

Si tienes la duda **"¿esto va al core o a la config?"**, lee [`docs/core_invariant.md`](../docs/core_invariant.md). Si la duda persiste, hay un problema arquitectónico que resolver antes de codear.

## Subcarpetas

| Carpeta | Qué vive aquí | Qué NO vive aquí |
|---|---|---|
| `prompts/` | Plantillas de prompt con placeholders `{{...}}` | Texto literal de FAQs del cliente, nombres de productos |
| `flows/` | Lógica de turnos, fases, máquina de estados conversacional | Flujos de venta específicos a una categoría |
| `scoring/` | Algoritmo BANT abstracto, thresholds calibrables vía config | Reglas tipo "si pide la presentación chica, calificar warm" |
| `tools/` | Tools genéricas (`cotizar`, `agendar`, `escalar`, `capturar_lead`) | Lógica de cómo una Ferretería cotiza vs cómo una Veterinaria cotiza |
| `guardrails/` | Restricciones universales: no inventar precios, no prometer entregas, disclosure obligatorio | Restricciones específicas de un cliente concreto |
| `data_model/` | Schemas SQL: `Lead`, `Conversation`, `Message`, `Event`, `Quote`, `Customer` | Columnas custom del cliente |
| `evaluation/` | Marco de evals, métricas, generación de reportes de calidad | Casos de prueba específicos a un cliente (esos van en `tests/evals/clients/...`) |
| `integrations/` | Conectores genéricos: WhatsApp Cloud API, Google Calendar, Supabase, Langfuse | Tokens, IDs de cliente |
| `utils/` | Helpers compartidos (chunking, embeddings, parsing, logging) | Lógica de negocio |

## Cómo el core consume la configuración del cliente

El core **nunca importa de `clients/`**. La configuración del cliente se inyecta:

1. Variable de entorno `ACTIVE_CLIENT=clinica_demo`.
2. Loader genérico (`core/utils/config_loader.py` — pendiente) lee `clients/$ACTIVE_CLIENT/config.yml`.
3. Ese YAML referencia las otras rutas (`./catalog/catalogo.json`, `./prompts/tono.md`, etc.).
4. El core recibe el objeto de configuración en runtime y lo usa para rellenar placeholders.

Test mental: si borras un tenant y dejas `clients/clinica_demo/` con una configuración análoga, el motor debe arrancar y funcionar sin que tengas que tocar `core/`.

## Estado actual

> Sem 2 (2026-05-14 → 05-20): esta carpeta está vacía a propósito. Sem 3 comienza a poblarla tras el POC comparativo (n8n vs Flowise) y la decisión final de stack (D-14).
