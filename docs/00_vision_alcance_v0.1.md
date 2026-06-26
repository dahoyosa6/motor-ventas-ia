# 00 — Visión y Alcance

> **Versión:** 0.1 (borrador inicial) | **Fecha:** 2026-05-07
> **Autor:** David Hoyos | **Revisado con:** _por validar con dueño del cliente piloto_
> **Documento padre:** [BITACORA_PROYECTO.md](./BITACORA_PROYECTO.md)

---

## 1. Problema

Las PyMEs de venta consultiva (materiales, insumos, distribución B2B en general) **no tienen un proceso comercial estandarizado**. En la práctica esto se traduce en tres patologías:

1. **Prospectadores que no cierran:** generan leads pero no logran convertirlos.
2. **Cerradores sin pipeline:** son hábiles negociando pero dependen de otros para alimentar el embudo.
3. **Leads que se enfrían o se pierden** entre etapas porque nadie hace seguimiento consistente.

El equipo comercial existe, pero el proceso vive en cabezas distintas y se ejecuta de forma inconsistente. Esto castiga directamente la **tasa de conversión lead → oportunidad cerrada**.

## 2. Visión

> **Un agente de IA que ejecuta el proceso comercial completo —prospectar, calificar, vender, hacer seguimiento, clasificar y reportar— de forma consistente, 24/7, y aprende de cada interacción para mejorar el siguiente ciclo.**

El agente no reemplaza al equipo humano: estandariza el proceso que hoy no existe y libera al humano para los momentos de alto valor (negociaciones complejas, cuentas estratégicas, decisiones de excepción).

A largo plazo, el mismo motor debe poder configurarse para distintas verticales sin reescribir su lógica.

## 3. Objetivos del MVP (8 semanas)

| # | Objetivo | Cómo se ve "hecho" |
|---|---|---|
| O1 | Tener un agente conversacional capaz de **calificar** leads con criterios consistentes | El agente clasifica un lead en hot/warm/cold con justificación, contra ground-truth humano en ≥80% de los casos |
| O2 | Tener un agente capaz de **vender productos estándar** (catálogo acotado) end-to-end por chat | Cotización + cierre simulado (orden lista para pago) en al menos 1 categoría de productos sin intervención humana |
| O3 | Tener un agente que **hace seguimiento** automatizado de leads tibios | Cadencias automáticas con triggers (no respondió en 48h, abrió cotización, etc.) |
| O4 | Tener un **dashboard de reportes** con estado de cada lead y métricas básicas | Lead board + 5 métricas clave actualizadas en vivo |
| O5 | Tener un **manual de adaptación** para replicarlo a otra empresa | Otro miembro del curso podría seguirlo y adaptar el agente a su vertical |
| O6 | Validar con un **piloto real** en el cliente piloto | Mínimo 20 conversaciones reales gestionadas por el agente con métricas medidas |

## 4. Alcance

### 4.1 Está adentro (IN)
- **Canales:** Chat únicamente — WhatsApp Business API + widget web.
- **Iniciativa:** Inbound (responder a leads que llegan) **y** Outbound (iniciar conversaciones con listas), construidos en paralelo pero con prompts y métricas separadas.
- **Funciones del agente:**
  - Calificar leads (segmentar: consumidor final, ferretero, contratista, constructor) con scoring justificado.
  - Vender productos estándar de catálogo acotado (definir en Semana 2).
  - Generar cotizaciones simples basadas en lista de precios.
  - Agendar visitas/llamadas con humano para casos fuera de scope.
  - Hacer seguimiento automatizado con cadencias por estado de lead.
  - Reportar a un dashboard: estado de cada lead, métricas, conversaciones revisables.
- **Cliente:** Una sola PyME comercial (anonimizada en esta versión pública).
- **Idioma:** Español (Colombia / LATAM).
- **Stack:** **n8n** como orquestador del agente (decisión D-32 cerrada 2026-05-27, supersede D-14 — ver `docs/decision_log/d-32-stack-orquestacion-poc.md` y `docs/decision_log/d14_decision.md`). Plataformas alternativas evaluadas y descartadas: Flowise (perdió por 19 puntos en rúbrica T1-T7), Botpress (plan B no activado — ambas finalistas pasaron T1). Razonamiento: Claude (default) o GPT-4 (swap de sub-nodo, no env var). Persistencia: Supabase Postgres + pgvector. Código custom solo donde sea estrictamente necesario (Sem 5+ motor Python complementario al workflow n8n).

### 4.2 Está afuera (OUT)
- **Voz / llamadas telefónicas.** No para el MVP. Roadmap post-curso.
- **Integración profunda con ERP/contabilidad** del cliente. El agente leerá un catálogo y precios, no consultará inventario en tiempo real (a menos que el cliente ya tenga API expuesta).
- **Cobros / procesamiento de pagos.** El agente puede generar la orden y enviar link de pago si existe; no maneja datos financieros.
- **Productos no estándar / proyectos a medida.** Esos siempre se escalan a humano.
- **Multi-cliente desde día uno.** El motor debe ser adaptable, pero el MVP corre con un solo cliente.
- **Aprendizaje en línea sofisticado** (fine-tuning, RLHF). El "aprendizaje" del MVP es: logging estructurado + revisión semanal + actualización de prompts/few-shots.

### 4.3 Supuestos
- El dueño del cliente piloto está disponible para validación semanal (acceso cercano y frecuente).
- Existe (o se podrá construir rápidamente) una lista de precios y catálogo digitalizable.
- WhatsApp Business API o equivalente puede contratarse en las primeras 4 semanas.
- El equipo comercial humano del cliente acepta participar como ground-truth para validar calificaciones del agente.

## 5. Métricas de éxito

### 5.1 Métrica norte
**Tasa de conversión lead → oportunidad cerrada** (oportunidad = lead que pasa a humano para cierre o cierra solo, según segmento).

> **Nota honesta:** esta métrica solo es creíble después del piloto (Semana 7-8). En el ciclo de venta consultiva B2B raramente se cierra en días. Por eso medimos también indicadores adelantados durante las semanas 1-6.

### 5.2 Indicadores adelantados (medibles desde Semana 5)
| Indicador | Meta MVP | Por qué importa |
|---|---|---|
| Exactitud de calificación vs. humano | ≥ 80% | Si el agente clasifica mal, todo lo demás es ruido |
| Tasa de finalización de conversación | ≥ 60% | Mide si la conversación llega a un outcome (no se abandona) |
| Tiempo de respuesta promedio | < 5s en chat | Velocidad es ventaja competitiva real |
| Cobertura de seguimiento | 100% de leads con cadencia activa | Resuelve el "lead frío olvidado" del problema |

### 5.3 Indicadores de negocio (medibles en Semana 7-8)
| Indicador | Meta piloto | Notas |
|---|---|---|
| Conversión lead → oportunidad | _Definir baseline con dueño en Sem. 2_ | Necesitamos número actual para fijar meta realista |
| Horas comerciales liberadas / semana | ≥ 5h | Reportadas por el equipo humano |
| Satisfacción del cliente piloto | ≥ 4/5 | Encuesta post-piloto al dueño y a 1-2 vendedores |

## 6. Tres hipótesis a validar durante el curso

| # | Hipótesis | Cómo se valida |
|---|---|---|
| H1 | Un agente con instrucciones claras puede calificar leads tan bien como un vendedor junior. | Comparación contra ground-truth humano en Semana 5-7 |
| H2 | Los leads aceptan comprar productos estándar end-to-end por chat (sin humano) si la experiencia es buena. | Tasa de cierre en categoría acotada durante el piloto |
| H3 | El motor diseñado para el primer cliente se puede adaptar a otra empresa cambiando solo configuración (catálogo + prompts), no código. | Ejercicio de adaptación en Semana 8 con un caso ficticio o de otro estudiante |

## 7. Riesgos críticos identificados

| # | Riesgo | Severidad | Mitigación |
|---|---|---|---|
| R1 | "Vender end-to-end" + "poco código" puede chocar en escenarios complejos | Alta | Acotar categoría de productos donde el agente cierra; resto va a humano |
| R2 | Métrica norte (conversión) solo es medible al final → riesgo de "demo sin números" | Alta | Definir baseline en Semana 2 e instrumentar indicadores adelantados desde Semana 5 |
| R3 | Plataformas no-code limitan ciertas integraciones o flujos | Media | Validar viabilidad técnica de WhatsApp + GPT en Semana 3 con POC |
| R4 | El dueño del cliente cambia prioridades o se distrae | Media | Acceso cercano: cadencia diaria informal + reunión semanal formal |
| R5 | Outbound puede chocar con regulación (habeas data Colombia, anti-spam) | Media | Outbound solo a listas con consentimiento; revisar con dueño en Semana 2 |

## 8. Lo que NO es este proyecto (anti-visión)

- **No** es un chatbot de FAQs. Es un agente con autonomía para llevar una conversación comercial.
- **No** es una plataforma SaaS multi-tenant. Es un MVP para un cliente, con la disciplina arquitectónica de poder convertirse en plataforma después.
- **No** es un reemplazo del equipo comercial. Es una capa de proceso estandarizado encima del equipo.
- **No** es un proyecto académico. Al final de las 8 semanas debe ser usable por el cliente piloto.

## 9. Decisiones que quedan abiertas para Semana 1-2

- [ ] Nombre formal del cliente piloto y firma de acuerdo (informal está bien) de participación
- [ ] Categoría(s) de producto en las que el agente cerrará end-to-end
- [ ] Baseline numérico actual de conversión (para fijar meta realista)
- [x] Selección final de plataforma de orquestación — **n8n** (D-32 cerrada 2026-05-27, supersede D-14). Botpress/Voiceflow/Flowise descartadas con rúbrica documentada.
- [ ] Acceso a WhatsApp Business API: cuenta propia o usar la del cliente

## 10. Aprobaciones

| Rol | Nombre | Fecha | Firma |
|---|---|---|---|
| Owner del proyecto | David Hoyos | | |
| Cliente piloto | _por nombrar_ | | |
| Mentor del curso | _por confirmar_ | | |
