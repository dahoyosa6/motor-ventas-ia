# motor-ventas-ia

Motor de un **agente de ventas conversacional por WhatsApp** para PyMEs
comerciales, diseñado como **multi-tenant**: un solo motor que atiende a varias
empresas, donde adaptar el agente a un negocio nuevo significa **cambiar
configuración, no reescribir código**.

El agente recibe mensajes de WhatsApp, entiende lo que pide el cliente, consulta
un catálogo real, cotiza, califica el lead (metodología BANT), agenda visitas y
escala a un humano cuando hace falta — todo con guardrails que evitan que
invente precios o prometa lo que no puede cumplir.

> **Estado:** prototipo / pre-piloto. No está en operación con tráfico real de
> usuarios finales. Este repositorio es una **versión pública y anonimizada**
> del motor: todos los datos de cualquier cliente real fueron removidos y
> sustituidos por un tenant de ejemplo 100% sintético (`clients/clinica_demo/`).

---

## La idea central: CORE vs CONFIG

La decisión de arquitectura más importante del proyecto es una frontera estricta
entre dos universos:

| | **CORE** (`core/`) | **CONFIG** (`clients/<tenant>/`) |
|---|---|---|
| Qué es | El motor: lógica genérica, igual para todos | Lo que cambia en cada empresa |
| Ejemplos | Cómo se cotiza, cómo se califica un lead, los guardrails, el modelo de datos, las herramientas | El catálogo, los precios, el tono de voz, las políticas de descuento, las FAQs |
| Regla | **Nunca** referencia a un cliente concreto | Vive aislado por tenant |

**La "Regla de Oro":** si para que el motor funcione con una empresa nueva tienes
que tocar algo de `core/`, es un **bug de arquitectura**. Adaptar a otro negocio
debería ser: crear `clients/<nuevo>/` con su catálogo, sus prompts y su
`config.yml`, y nada más.

Esta frontera está documentada en detalle en
[`docs/core_invariant.md`](docs/core_invariant.md) y se materializa en la
estructura de carpetas:

```
core/              # el motor — agnóstico al cliente
  data_model/      # esquemas de datos (Lead, Conversation, Quote, ...)
  flows/           # máquina de estados conversacional, escalamiento, descuentos
  prompts/         # plantillas de system prompt con placeholders {{...}}
  scoring/         # calificación BANT abstracta, calibrable por config
  tools/           # herramientas del agente (cotizar, agendar, validar ítems, ...)
  utils/           # helpers compartidos (config loader, schemas)

clients/
  clinica_demo/    # tenant de ejemplo SINTÉTICO (catálogo de 14 insumos médicos)

tests/evals/       # suite de evaluación del agente (ver abajo)
docs/              # visión, alcance y la frontera CORE/CONFIG
```

---

## La suite de evaluación (evals)

Un agente de IA solo es confiable si puedes **medir** su calidad de forma
reproducible. Esta es, para mí, la parte más valiosa del proyecto: el harness de
`tests/evals/` corre el agente contra casos de prueba y verifica su respuesta en
tres niveles.

1. **Retrieval** (`run_rag_eval.py`) — ¿la búsqueda semántica encuentra el
   producto correcto del catálogo? Métrica: recall@1/@3/@5.
2. **Agente completo** (`run_agent_eval.py`) — corre el agente end-to-end y
   evalúa la respuesta con **checks deterministas** (no inventar precio,
   disclosure obligatorio, escalar cuando toca, formato) más un **juez LLM**
   opcional para tono y pertinencia.
3. **Calificación BANT** (`run_bant_live_eval.py`) — compara la calificación del
   lead en vivo contra una etiqueta de referencia.

### Resultado, contado con honestidad

En el proyecto original, la versión evaluada del agente acertó en
**aproximadamente el 80% de un set de 84 conversaciones de prueba**. Es un
número de prototipo, medido antes de un piloto real, no una garantía de
producción. La extracción BANT, además, es no-determinista aun a temperatura 0,
así que se usa como **señal**, no como criterio binario.

> En este repositorio público los datasets son **sintéticos** (sobre el catálogo
> de la clínica demo), así que sirven para demostrar que la suite **corre**, no
> para reproducir esos números.

Detalle de cómo correr cada nivel en [`tests/evals/README.md`](tests/evals/README.md).

---

## Stack

- **Python** para el motor de herramientas, el config loader y la suite de evals.
- **JavaScript** para las herramientas puras del agente (`core/tools/*.js`).
- **Supabase** (Postgres + pgvector) como base de datos y motor de retrieval.
- **n8n** como orquestador del flujo conversacional.
- **API de Claude (Anthropic)** como modelo del agente y como juez en los evals;
  **OpenAI** para los embeddings del catálogo.
- **WhatsApp Cloud API** (Meta) como canal.

## Cómo empezar

```bash
# 1. Configurar el entorno
cp .env.example .env        # y rellenar las credenciales

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. Validar que la suite de evals corre (modo sin red)
.venv/bin/python3 tests/evals/run_agent_eval.py --dry-run
```

## Privacidad

Este repositorio fue **sanitizado** a partir de un proyecto con un cliente real:
se removieron su catálogo, precios, conversaciones, datos de contacto y todos los
secretos. El único tenant incluido (`clients/clinica_demo/`) es ficticio. Los
secretos se manejan exclusivamente por variables de entorno (`.env`, ignorado por
git); ver [`.env.example`](.env.example).

## Licencia

[MIT](LICENSE).
