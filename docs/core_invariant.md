# Core Invariant del Motor de Ventas IA

> **Versión:** 1.0 (Semana 2 — 2026-05-12)
> **Owner:** David Hoyos
> **Estado:** Aprobado para arrancar Sem 3
> **Documentos afectados:** 06 Arquitectura · 11 Manual de Adaptación · todo el código

---

## 1. Para qué existe este documento

Este documento define la **frontera inmutable** del producto: qué partes son **CORE** (el motor, igual para todo cliente) y qué partes son **CONFIGURACIÓN** (cambia 100% por cliente). Es la materialización de la **Regla de Oro** del proyecto: *antes de cualquier decisión técnica, ¿esto va al CORE o a la CONFIGURACIÓN?*

Antecede a las decisiones técnicas de orquestación porque sin esta frontera, la evaluación de plataformas se diseña mal: terminamos midiendo qué plataforma resuelve mejor *el caso de un cliente concreto* en lugar de *qué plataforma soporta mejor un motor adaptable*.

Es también el contrato con la H3: **"el motor se adapta a otra empresa cambiando solo configuración, no código"**. Sin Core Invariant explícito, H3 es indefinible y por tanto no validable.

---

## 2. Definición operacional

### 2.1. CORE — qué nunca cambia entre clientes

> Si para que el motor funcione con un cliente B tienes que tocar algo del CORE, **es bug arquitectónico**.

El CORE es el conjunto de elementos que cumplen las tres condiciones:

1. **Universalidad** — el elemento es válido para cualquier PyME comercial LATAM (ferretería, materiales, veterinaria, clínica dental, óptica, distribuidora química).
2. **Estabilidad** — su definición no depende de catálogo, política comercial, tono ni FAQs del cliente.
3. **Cohesión técnica** — pertenece a la capa "motor" del sistema (orquestación, datos, lógica conversacional genérica, observabilidad, guardrails).

### 2.2. CONFIGURACIÓN — qué cambia 100% entre clientes

> Si el elemento podría cambiar para un cliente B sin que el motor deje de funcionar, **va en `clients/<cliente>/`**.

La CONFIGURACIÓN es el conjunto de elementos que cumplen cualquiera de las dos condiciones:

1. **Especificidad** — el valor depende del cliente concreto (catálogo, precios, segmentos, branding).
2. **Calibrabilidad** — son thresholds, pesos o políticas que pueden ser ajustadas sin modificar lógica.

### 2.3. Test del cliente sintético (Sem 6)

La validación final de esta frontera: **¿podemos crear un cliente sintético (vertical lejano: clínica dental, distribuidora veterinaria, óptica) y ponerlo a operar el motor en menos de 1 día tocando solo `clients/<sintetico>/` y cero líneas de `core/`?**

Si sí → Core Invariant correcto y H3 válida.
Si no → la diferencia entre lo que tuvimos que tocar en `core/` y lo que debería haber sido configuración es la **deuda arquitectónica** a registrar en doc 11.

---

## 3. Tabla maestra Core vs Configuración

| Elemento | CORE | CONFIGURACIÓN | Por qué |
|---|:---:|:---:|---|
| **Arquitectura del motor** (orquestador, BD, observabilidad) | ✅ | | Mismo motor para todos los clientes |
| **Modelo de datos** (`Lead`, `Conversation`, `Message`, `Event`, `Quote`, `Customer`, `Product`) | ✅ | | Estructura genérica; los datos concretos son del cliente |
| **Lógica conversacional** (turnos, contexto, tool calling) | ✅ | | No depende del catálogo |
| **Máquina de fases conversacionales** (apertura → calificación → propuesta → cierre → seguimiento) | ✅ | | Universal en venta consultiva |
| **Algoritmo BANT** (cómo se calcula score) | ✅ | | Genérico |
| **Tools del agente** (las 6 finales — naming congelado por `core/tools/contracts.spec.md`): `consultar_catalogo`, `consultar_stock`, `cotizar`, `agendar`, `escalar_humano`, `registrar_lead` | ✅ | | Operaciones universales de una venta consultiva PyME LATAM. `consultar_stock` añadida por D-43 (lee export diario de inventario y degrada >24h/>48h). `cotizar` asume `policies/descuentos.yaml` (flujo asíncrono de autorización; ver `core/flows/discount_authorization.spec.md`). `agendar` requiere ack WhatsApp obligatorio incluso si Calendar falla. `escalar_humano` lleva 10 razones tipadas, idempotencia 10 min, lockout 48h. `registrar_lead` renombrado de `capturar_lead`. **`enviar_ficha_tecnica` deja de ser tool**: pasa a ser atributo `attachments[]` del output de otras tools (`ToolOutput.attachments` en `contracts.spec.md` §2.3). |
| **Guardrails estructurales** (no inventar precios, no prometer entregas, disclosure si pregunta directa) | ✅ | | Inviolables por todo cliente |
| **Integraciones genéricas** (WhatsApp Cloud API, Google Calendar, Supabase, pgvector, Langfuse) | ✅ | | Protocolo, no implementación específica |
| **Pipeline RAG** (chunking, embeddings, retrieval, re-ranking) | ✅ | | Procedimiento; lo que entra es config |
| **Marco de evaluación** (cómo se mide calidad, exactitud, tasa de finalización) | ✅ | | Métricas universales |
| **Logging estructurado** | ✅ | | Schema universal |
| **Sistema de placeholders** (`{{TONO}}`, `{{CATALOGO}}`, etc.) | ✅ | | Mecanismo |
| ─── | | | |
| **Catálogo de productos + precios** | | ✅ | El motor es ciego al catálogo concreto |
| **Bloque `{{TONO}}`** (formal / cercano / técnico) | | ✅ | Cliente decide |
| **Bloque `{{SOBRE_EMPRESA}}`** (historia, valores, USP) | | ✅ | Cliente decide |
| **Bloque `{{POLITICA_DESCUENTOS}}`** | | ✅ | Cliente decide |
| **Bloque `{{POLITICA_PAGOS}}`** (contado / crédito / plazos) | | ✅ | Cliente decide |
| **Bloque `{{POLITICA_ENTREGA}}`** | | ✅ | Cliente decide |
| **FAQs del negocio** | | ✅ | Cliente decide |
| **Objeciones reales + respuestas modelo** | | ✅ | Cliente decide |
| **Few-shots** (conversaciones reales del cliente) | | ✅ | Cliente decide |
| **Buyer personas / segmentos** | | ✅ | Cliente decide |
| **Thresholds BANT específicos** (qué es "hot" para este cliente) | | ✅ | Calibración |
| **Cuándo escalar a humano** | | ✅ | Cliente decide |
| **Disclaimer / disclosure de IA** | | ✅ | Cliente decide (dentro de los límites del guardrail estructural) |
| **Branding** (nombre del "vendedor", saludo, firma) | | ✅ | Cliente decide |
| **Idioma / variante regional** (es-MX, es-CO, es-AR) | | ✅ | Cliente decide |
| **Canales habilitados** (WhatsApp, web widget, email) | | ✅ | Cliente decide |
| **Credenciales del cliente** (número WhatsApp, IDs Meta, API keys) | | ✅ | Cliente decide |
| **Calendario** (horario de atención, días no laborables) | | ✅ | Cliente decide |
| **Datos del cliente** (clientes históricos, ventas pasadas, deudores) | | ✅ | Cliente decide |
| ─── | | | |
| **Schema SQL** (tabla `Lead`, columnas estándar) | ✅ | | Universal |
| **Campos custom del cliente** (ej. `tipo_obra` para constructoras) | | ✅ | Cliente decide vía extensión JSONB |
| **Reportes preconstruidos** (5 métricas estándar) | ✅ | | Universal |
| **Reportes específicos del cliente** | | ✅ | Cliente decide |

---

## 4. Reglas de uso (cómo decidir en runtime)

Cuando enfrentes una decisión técnica, aplica esta secuencia:

1. **¿La misma lógica sirve para una distribuidora veterinaria sin modificarse?**
   - Sí → CORE.
   - No → CONFIGURACIÓN.

2. **¿Esto es un mecanismo (cómo se hace algo) o un valor (qué cosa se usa)?**
   - Mecanismo → CORE.
   - Valor → CONFIGURACIÓN.

3. **¿Si cambia para un cliente, debería cambiar también para todos los demás clientes?**
   - Sí → CORE.
   - No → CONFIGURACIÓN.

4. **¿Lo puedo expresar como un placeholder `{{NOMBRE}}` o entrada en `config.yml`?**
   - Sí → es CONFIGURACIÓN. Va al cliente.
   - No → probablemente es CORE, o estás mezclando capas.

5. **Cuando la respuesta sigue siendo "depende"**, no codifiques. Es la señal de que hay una abstracción pendiente. Resolver primero la abstracción (qué es el mecanismo subyacente), luego decidir.

---

## 5. Casos límite documentados

> Estos son los casos donde la frontera no es obvia. Quedan congelados aquí para no debatirlos cada vez.

### 5.1. Política comercial (descuentos, créditos)

- **El motor de aplicar políticas** (validar reglas, escalar autorización) → CORE.
- **Los valores concretos** (descuentos hasta 10%, crédito hasta $50K con 30 días) → CONFIGURACIÓN, en `clients/<cliente>/policies/descuentos.json`.

### 5.2. Tools del agente

- **La definición genérica de `cotizar(producto, cantidad, cliente)`** → CORE.
- **Cómo una Ferretería calcula precios por presentación vs cómo una Veterinaria cobra por kg** → la diferencia se resuelve dentro del tool consultando el catálogo configurado. El tool es CORE; el catálogo es CONFIG.
- **Tools muy específicas que solo aplican a un cliente** (ej. "calcular_litros_para_metros2_de_pared") → primero intentar volverlas genéricas (`calcular_dosis(unidad_origen, unidad_destino, factor)`). Si no es posible, son **tools de cliente** en `clients/<cliente>/custom_tools/` (excepción explícita; queda registrada como deuda en doc 11).

### 5.3. Guardrails

- **Guardrails estructurales** (no inventar precios, no prometer fechas que no salen del calendario configurado, disclosure obligatorio si lo pregunta directo) → CORE. Inviolables.
- **Guardrails de tono** (no decir "compa" en cliente formal) → CONFIGURACIÓN.
- **Guardrails legales por país** (LFPDPPP México vs Habeas Data Colombia vs LGPD Brasil) → CORE pero parametrizable: el motor sabe los tres regímenes; el cliente declara cuál aplica vía `country` en `config.yml`.

### 5.4. Idioma

- **El motor entiende español LATAM en general** → CORE.
- **Variante regional preferida** (es-MX vs es-CO vs es-AR) → CONFIGURACIÓN.
- **Modismos / coloquialismos del cliente** (jerga local de cada vertical) → CONFIGURACIÓN, no se enseñan al modelo: el catálogo y los few-shots los aportan.

### 5.5. Datos del cliente (clientes históricos, ventas pasadas)

- **Schema de las tablas que los albergan** → CORE.
- **Los datos** → CONFIGURACIÓN (cargados desde `processed_data/` del cliente activo).
- **Lógica de "qué hacer con clientes dormidos"** → CORE (genérica). Calibración de "dormido = sin compra hace > X meses" → CONFIGURACIÓN.

### 5.6. Reportes

- **5 reportes base** (conversiones por etapa, leads por origen, tiempo de respuesta, exactitud de calificación, cobertura de seguimiento) → CORE.
- **Reportes adicionales que un cliente pide** → CONFIGURACIÓN si se logran como queries sobre el modelo de datos universal. Si requieren columnas nuevas en CORE, se evalúa: ¿esta columna es útil para todos? Sí → CORE. No → JSONB extensible.

### 5.7. WhatsApp como canal

- **El conector a Meta Cloud API** → CORE.
- **El número, token, business ID del cliente** → CONFIGURACIÓN, en `clients/<cliente>/config.yml` + secrets fuera del repo.
- **Templates de mensajes aprobados por Meta** (HSM) → CONFIGURACIÓN (cada cliente registra los suyos).

### 5.8. Hipótesis vs configuración

- **Una hipótesis del proyecto** (H1, H2, H3) → no es código. Vive en docs.
- **El test que valida una hipótesis** → CORE (mecanismo de evaluación) + CONFIGURACIÓN (cuáles conversaciones se testean).

### 5.9. Variable de entorno `ACTIVE_CLIENT`

- **En runtime del agente (servidor que atiende webhooks):** el `client_slug` viene **siempre** del payload del request (ruteado por el nodo Set en n8n / handler del webhook en Python). `ACTIVE_CLIENT` se ignora.
- **En CLIs y scripts** (`scripts/ingest_catalog.py`, `scripts/run_eval.py`): `ACTIVE_CLIENT` es la fuente principal. Conveniencia para single-tenant offline.
- **En tests:** ninguna de las dos. Cada test pasa `client_slug` explícito al loader. Si un test depende de `ACTIVE_CLIENT`, es test mal escrito.

Razón: en multi-tenant simultáneo (Sem 6+), un proceso del motor sirve a varios clientes al mismo tiempo. Una env var global rompe ese modelo. Origen: spec del `config_loader` (`core/utils/config_loader.spec.md` §9).

### 5.10. Defaults en funciones SQL multi-tenant

Ninguna función del CORE puede tener un default hardcodeado a un `tenant_slug` concreto. El aislamiento multi-tenant debe ser **falla ruidosa**, no silenciosa: si el caller no pasa el tenant, la función debe rechazar la llamada con error explícito.

Razón: un default por cliente es config-en-el-core (viola R1) y además crea la clase de bug "T1 *parece* pasar pero el aislamiento está roto" — un caller que olvide el parámetro recibiría productos del cliente del default sin error. Origen: D-42 (`docs/decision_log/d-42-filter-tenant-required.md`) + migration `0003_match_products_require_tenant.sql`.

### 5.11. Excepciones por segmento en `discount_authorization`

- **Mecanismo `segment_overrides`** (saltarse la consulta puntual al responsable cuando el cliente actual cae en un segmento con decisión de descuento ya tomada) → CORE. El motor sabe ejecutar el override.
- **Qué segmentos disparan override, qué `action` ejecutar y qué mensaje enviar al cliente** → CONFIGURACIÓN, en `clients/<slug>/policies/descuentos.yaml` bajo `discount_authorization.segment_overrides`.
- **Comportamiento por defecto** (sin overrides declarados, o segmento del cliente indeterminado en runtime): consultar al responsable. NO se asume excepción sin certeza. Razón: la regla resta autoridad al humano; aplicarla sin segmento confirmado es peor que el ruido de una consulta extra.
- **Auditoría:** la cotización resuelta por override se persiste en `discount_authorizations` con `status='segment_blocked'` y `raw_metadata.segment_override.reason_for_audit` poblado desde el config del cliente. Trazabilidad completa para reportes.

Origen: respuesta del responsable del primer cliente el 2026-05-24 (un segmento de su cartera no recibe descuento por política comercial estable). Se autoriza codificar la regla en config para no depender de que el LLM acate la instrucción turn-a-turn. Especificación: `core/flows/discount_authorization.spec.md` §5.5; tipos: `core/utils/config_loader.spec.md` §3.1 `SegmentDiscountOverride`; schema: `core/utils/schema/client_config.schema.json` `$defs.SegmentDiscountOverride`.

### 5.12. Composición del disclosure es CORE estructural

- **Estructura del párrafo de disclosure de IA** (cuándo se emite, qué cláusulas contiene, en qué orden) → CORE inviolable. El motor lo compone.
- **Slots sustituibles por el cliente:** únicamente `agent_identity` (nombre del "vendedor" o asistente) y, si aplica, el SLA. Nada más.
- **Defensa del loader:** `disclosure.reveal_ai_on_direct_question` se fuerza a `true` aunque el YAML del cliente lo declare `false`; el loader emite warning `DisclosureGuardrailViolation` y sigue. Origen: `core/utils/config_loader.spec.md` §4 (auditoría del YAML actual, hallazgo crítico) y §3 (`DisclosurePolicy.reveal_ai_on_direct_question` marcado 🔒).

### 5.13. `tenant_slug` obligatorio en el `TurnEnvelope`

- El campo **nunca puede faltar** en un envelope que entra al motor. Un envelope sin `tenant_slug` es bug arquitectónico, no estado tolerado.
- Validación en frontera de aplicación: si llega null o no matchea `^[a-z][a-z0-9_]{2,63}$`, el orquestador aborta con `TenantSlugMissingError` antes de tocar `ClientConfig` o cualquier tool.
- Es la **réplica en la capa de aplicación** del guard SQL de §5.10 (sin defaults hardcodeados a tenant): aislamiento multi-tenant como falla ruidosa en ambos planos. Origen: `core/data_model/turn_envelope.spec.md` §2 (invariantes del envelope) y §8 (`TenantSlugMissingError`).

### 5.14. Umbrales de staleness del inventario son CORE

- `consultar_stock` degrada su comportamiento según la edad del último export diario de inventario: 24h–48h pasa a modo "consulto y te confirmo" (`stale=true`, `status_reason` lo verbaliza); >48h fuerza `status=desconocido` para todos los items y bloquea promesas, derivando a confirmación humana.
- Los umbrales 24h y 48h son **CORE inviolables**, no calibrables por cliente. Razón: la responsabilidad de "no prometer datos viejos" es estructural (alineado con §3 "no inventar precios, no prometer fechas") y un cliente con laxitud propia rompería el guardrail.
- Los **umbrales de stock-bajo** (min/max por SKU) sí son CONFIG. Origen: `core/tools/consultar_stock.spec.md` §7 + D-43 (un solo export diario garantizado).

### 5.15. WhatsApp ack en `agendar` sobrevive a Calendar caído

- Si Google Calendar falla al crear el evento, la tool `agendar` **DEBE** enviar el ack al cliente igualmente, con la cita en estado `tentative_calendar_pending` y `fallback_required=true`. Un humano sincroniza Calendar después.
- El ack no es decoración: es el contrato con el cliente. Un fallo en el envío de WhatsApp (paso 4 del algoritmo) sí es bloqueante; un fallo en Calendar (paso 3) no lo es.
- Origen: `core/tools/agendar.spec.md` §5 (algoritmo, orden no negociable) + decisión de producto 2026-05-22.

### 5.16. Texto del ack de escalación es CORE compuesto

- **Estructura del párrafo del ack** que se envía al cliente cuando el agente escala → CORE. Vive en `core/flows/i18n/escalation_ack_{lang}.txt`.
- **Slots sustituibles por el cliente:** únicamente `{{primary_contact_name}}` (nombre del responsable) y `{{sla}}` (resuelto por `render_sla()` CORE en función de business_hours y now). Nada más.
- Análogo a §5.12 (disclosure) pero para escalación: el cliente NO puede reescribir el cuerpo del mensaje (defensa contra ofuscar la transferencia humana al cliente). Origen: `core/flows/escalation.spec.md` §5.2 y §5.3.

### 5.17. Lockout post-escalación: 48h o resolución humana

- Tras escalar, `conversations.status='escalated'` y el agente **NO** genera respuestas en esa conversación hasta que: (a) un humano marque la escalación resuelta (`escalations.resolved_at` + `agent_can_resume=true`), o (b) pasen 48h sin resolución (auto-cierre con `resolved_by='auto_timeout'` y notificación al admin del tenant).
- El window de 48h es **CORE inviolable**, no calibrable por cliente. Razón: protege al cliente final de quedar atrapado en limbo conversacional y al operador del tenant de acumular escalaciones zombi. Es espejo del `lockout_h: int = 48` 🔒 en `EscalationPolicy` (`core/utils/config_loader.spec.md` §3.1).
- Mientras dura el lockout, los mensajes del cliente se persisten en `turns` pero no disparan respuesta; el humano on-call recibe pings rate-limited (1 por cada 3 mensajes). Origen: `core/flows/escalation.spec.md` §5.4 y §9.

### 5.18. Composición turn-aware del copy: apertura y cierre (D-45)

- **El mecanismo "el motor sabe que existe un slot `opening_block` (antes del cuerpo del LLM en el turno de apertura) y un slot `closing_block` (después del cuerpo del LLM en el turno de cierre), con disparadores configurables y orden estructural no negociable" → CORE inviolable.**
- **El contenido de ambos bloques → CONFIGURACIÓN**, en `clients/<slug>/policies/opening_closing.yaml`, parseado por el loader al sub-bundle `OpeningClosingCopy` (ver `core/utils/config_loader.spec.md` §3.1).
- **Los disparadores de escalación (keywords) → CONFIGURACIÓN** pero con **fuente única**: `cfg.policies.escalation.keywords`. El `closing_template` los referencia vía placeholders `{{escalation_keyword}}` / `{{escalation_keywords_join}}`. PROHIBIDO duplicar la lista en `opening_closing_copy` (rechazado por schema con `additionalProperties=false`).
- **Defensa del orden:** si el cliente intenta invertir (cierre antes del cuerpo, apertura después), el orquestador ignora la inversión y aplica el orden canónico. Apertura arriba, despedida abajo es lectura natural en mensajería y no es negociable.
- **Defensa Meta TOS / disclosure:** §5.18 NO reemplaza ni debilita §5.12 (disclosure reactivo CORE compuesto). El `opening_template` del cliente NO contiene el disclosure de IA: ese sigue siendo CORE inviolable y se compone aparte. Si el `opening_template` omite mención de IA, el guardrail de §5.12 cubre el caso cuando llega pregunta directa.
- **Fallback CORE i18n:** si `opening_template` o `closing_template` son null/ausentes, el orquestador lee `core/prompts/i18n/{opening,closing}_block_fallback_{lang}.txt`. Mismo patrón que §5.16 (ack de escalación CORE i18n).
- **Patrón establecido como regla, no excepción.** Este es el tercer caso (§5.12, §5.16, §5.18) que aplica el mismo principio "CORE compuesto + slots del cliente + fallback i18n CORE". Tres aplicaciones confirman el patrón como mecanismo estándar del motor para insertar texto del cliente en posiciones estructurales fijas. Cualquier cuarto momento estructurado del copy (ej. mensaje proactivo post-72h sin respuesta) debe generalizar a un `CopyPlan` con N entries, NO añadir slot N+1 ad hoc.

Origen: D-45 (`docs/decision_log/d-45-copy-structure-saludo-cierre.md`), 2026-05-27. Disparado por petición del responsable del primer cliente de partir el copy en dos turnos. Especificación: `core/prompts/system_template.spec.md` §12; tipos: `core/utils/config_loader.spec.md` §3.1 `OpeningClosingCopy`; schema: `core/utils/schema/client_config.schema.json` `$defs.OpeningClosingCopy`.

### 5.19. Pickup en proveedor: atributo per-SKU ortogonal al estado de stock (D-46)

- **El mecanismo "un SKU puede ser vendible aunque `EXIST<=0` cuando lleva el atributo `extra.supplier_pickup_available=true`; el motor lee el flag post-clasificación de estado y lo expone al LLM como campo estructural" → CORE.**
- **El valor del flag por SKU → CONFIGURACIÓN del catálogo del tenant** (`clients/<slug>/catalog/`). El motor no decide qué SKUs son pickeables; lo decide el responsable del tenant.
- **La key se llama `supplier_pickup_available` por convención CORE.** Override per-cliente vía `StockPolicy.supplier_pickup_attribute_key` existe pero es raro (justificado solo por catálogo legacy heredado; se registra como deuda en doc 11 si se usa).
- **Default ausente ⇒ `false` ⇒ comportamiento idéntico al modelo legacy de 4 estados.** R3 (test de adaptabilidad Sem 6) pasa con clientes que no usan el flag — no hay regresión.
- **NO debilita §4.1 (reglas duras categóricas).** Las reglas duras del cliente (ej. "COPE industrial siempre escala") se evalúan ANTES del lookup del flag. El flag NO las override. La regla dura es el caso categorial; el flag per-SKU es el caso granular.
- **El copy diferenciado al cliente final es responsabilidad del LLM con los prompts del cliente**, NO del motor. El motor expone `(state, supplier_pickup_available)` estructurado; el cliente decide cómo expresarlo en `clients/<slug>/prompts/politica_comercial.md`.
- **Generaliza el patrón "estado de inventario vs capacidad logística son dimensiones ortogonales".** Cualquier cuarto atributo per-SKU ortogonal que aparezca en el futuro (ej. `requires_temperature_control`, `requires_handling_license`) debe generalizarse a un mecanismo `extra_stock_attributes: list[str]` declarado en `StockPolicy`, NO añadirse como campo CORE ad hoc.

Origen: D-46 (`docs/decision_log/d-46-pickup-en-proveedor-stock.md`), 2026-05-27. Disparado por hallazgo del responsable del primer cliente (reunión Sem 3 cierre): la tienda vende SKUs con `EXIST=0` cuando el proveedor surte same-day desde su planta. Especificación: `core/tools/consultar_stock.spec.md` (pendiente Sem 5); tipos: `core/utils/config_loader.spec.md` §3.1 `StockPolicy` (+`supplier_pickup_attribute_key`); schema: `core/utils/schema/client_config.schema.json` `$defs.StockPolicy.supplier_pickup_attribute_key`.

### 5.20. Branch de visita física para cotizaciones grandes (D-47)

- **El mecanismo "cuando `cotizar.grand_total > cfg.policies.quote.visit_required_above_amount`, la tool NO cierra autónomamente: devuelve `status='pending_visit'`, dispara `agendar(technical_visit)` con `primary_contact`, y comunica al cliente que se agenda visita técnica" → CORE.**
- **El valor del umbral, el copy del aviso al cliente, y la decisión de habilitarlo (`None` = nunca dispara) → CONFIGURACIÓN**, en `clients/<slug>/policies/quote_policy.yaml` (sub-bundle `QuotePolicy`).
- **`pending_visit` NO es escalación ni lockout 48h.** La conversación sigue activa; el cliente queda esperando confirmación de cita. Distinguir del `pending_discount_authorization` y del lockout post-escalación (§5.17).
- **Prevalencia sobre `pending_discount_authorization`:** si ambas condiciones aplican en la misma llamada, gana `pending_visit`. Razón: el responsable resuelve descuento + cierre en la visita; multiplicar canales (consulta asíncrona + visita) confunde al cliente y al responsable.
- **Defensa de Calendar caído:** si `agendar()` falla, la tool persiste la quote como `pending_visit` igualmente, envía el aviso al cliente, y notifica al `primary_contact` por WhatsApp con instrucción de llamar al cliente manualmente. Espejo del §5.15 (WhatsApp ack sobrevive a Calendar caído).
- **Universalidad del mecanismo.** Pregunta canónica: ¿este patrón sirve para clínica dental, veterinaria, óptica y distribuidora química? Sí: clínica dental con presupuesto ortodoncia >$X requiere consulta presencial; distribuidora química con pedido >$Y necesita visita comercial para SDS + condiciones de pago; óptica con armazón premium >$Z requiere ajuste personal. El patrón es invariante; el umbral y el copy son específicos.
- **Default ausente ⇒ `visit_required_above_amount=None` ⇒ branch nunca se activa.** R3 (test de adaptabilidad) pasa: cliente que no declara `quote_policy.yaml` tiene comportamiento idéntico al actual de `cotizar`.

Origen: D-47 (a documentar — cierre en bitácora 2026-05-27 si no se materializa decision log separada). Disparado por confirmación del responsable del primer cliente en reunión Sem 3 cierre: cotizaciones >$100k (MXN) él las cierra con visita física personal. Especificación: `core/tools/cotizar.spec.md` §11; tipos: `core/utils/config_loader.spec.md` §3.1 `QuotePolicy`; schema: `core/utils/schema/client_config.schema.json` `$defs.QuotePolicy`.

### 5.21. Precio variable por atributo per-SKU (color/graduación/concentración/medida) (D-48)

- **El mecanismo "un SKU puede no tener un `unit_price` único resoluble en catálogo; el motor lee `extra.price_variability`, devuelve `unit_price=null` + `price_range{min,max}` + `requires_attribute=<atributo>` y pide el atributo al cliente en vez de inventar un número" → CORE.**
- **Qué SKUs son de precio variable, qué atributo determina el precio y en qué rango → CONFIGURACIÓN del catálogo del tenant** (`products.extra.price_variability`). El motor no decide qué productos varían.
- **La key se llama `price_variability` por convención CORE** y su objeto tiene shape fijo `{attribute, min, max, currency?, resolvable_by_attribute?}`. Override per-cliente del nombre de la key vía `QuotePolicy.price_variability_attribute_key` (default `"price_variability"`); raro, justificado solo por catálogo legacy heredado; se registra como deuda en doc 11 si se usa. Mismo tratamiento que `StockPolicy.supplier_pickup_attribute_key` (§5.19).
- **Default ausente ⇒ el SKU usa el `unit_price` fijo del export (legacy).** R3 (test de adaptabilidad Sem 6) pasa: cliente sin `price_variability` tiene comportamiento idéntico al actual de precio fijo.
- **Refuerza el guardrail estructural §3 "no inventar precios", NO lo debilita.** Ante variabilidad el motor expone rango + pide el atributo ("precio desde X / depende del color"); jamás dicta un número que no corresponde a lo que el cliente pagará.
- **`QUOTE_PRICE_UNAVAILABLE` (`cotizar` §7, escalación) se reserva para "el SKU no tiene ni precio fijo ni `price_variability`".** El caso "precio variable resoluble pidiendo un atributo" NO escala: devuelve `requires_attribute`. El branch de `cotizar` NO computa subtotal de un item de precio variable no resuelto.
- **Segunda instancia del patrón "atributo per-SKU ortogonal en `extra` JSONB" (§5.19).** Si aparece un tercer atributo ortogonal (ej. tiers de volumen), se generaliza a un registro `extra_sku_attributes` declarado en config, NO se añade objeto CORE ad hoc por atributo.

Origen: D-48 (`docs/decision_log/d-48-precio-variable-por-atributo.md`), 2026-05-28. Disparado por una clase de SKUs cuyo precio del export es localmente falso (bases entonables por color, armazones por graduación, fármacos por concentración, cable por medida). Especificación: `core/tools/consultar_catalogo.spec.md` §4 (semántica `price_range`/`requires_attribute`), `core/tools/cotizar.spec.md` §3/§4/§5/§7 (branch `requires_attribute`); schema: `core/utils/schema/client_config.schema.json` `$defs.QuotePolicy.price_variability_attribute_key`.

### 5.22. Clasificador de segmento del cliente en runtime (§5.22)

- **El MECANISMO de clasificación de segmento → CORE.** El motor sabe tomar señales heterogéneas del turno (categorías consultadas, monto observado, rol/authority BANT, horizonte, keyword hints) y del historial, puntuarlas contra un conjunto de segmentos definidos, y devolver el más probable con una medida de `confidence`. La cadena de resolución (1. `customer.segment_id` persistido → 2. clasificador runtime → 3. `indeterminado`), el algoritmo híbrido (reglas-first deterministas + LLM ligero solo como desempate acotado al set de candidatos), el **umbral de confianza** y su **piso CORE de 0.5** son CORE inviolables.
- **Los segmentos concretos, sus señales distintivas y el `min_confidence` calibrado → CONFIGURACIÓN del tenant.** Viven en `clients/<slug>/segments/buyer_personas.json` y se proyectan al motor como `cfg.segmentation.candidate_segments` vía el loader. El clasificador NO conoce ningún `segment_id` concreto; los recibe como strings opacos. `min_confidence` es calibrable por tenant pero el loader rechaza valores < 0.5 (piso CORE; `SegmentationConfigInvalid` → usa default CORE 0.6 + warning).
- **Fallback conservador inviolable.** Si `confidence < cfg.segmentation.min_confidence` → `status="indeterminate"`, `segment_id=null`. El clasificador NUNCA fuerza un segment_id por debajo del umbral para evitar el "indeterminado". Indeterminado significa **comportamiento conservador**: el consumidor cae a su camino por defecto (ej. `discount_authorization` §5.5.3 → consultar al responsable, NO asumir override). Espejo de §5.11: aplicar una regla sin segmento confirmado es peor que el ruido de una consulta extra.
- **Read-only sobre el estado.** El clasificador NO muta `customers` ni `conversations`. La persistencia del segmento inferido pasa **solo** por `registrar_lead` (`customer_metadata.segment`), único side-effect autorizado sobre `customers`. Separar inferencia (read-only) de escritura de estado.
- **El `segment_id` es atributo del `customer`, NO del `lead_state` BANT.** Se expone en el bloque `customer` del `TurnEnvelope` (`customer.segment_id`, `customer.segment_confidence`), no en `lead_state` (que es estrictamente budget/authority/need/timeline/score/stage). El `lead_state` BANT es una *señal* de entrada al clasificador, no su salida.
- **🔒 GUARDRAIL INVIOLABLE — `segment_id` NO es palanca de descuento.** La clasificación de segmento existe para **calibrar persona/tono/ruteo/BANT y para resolver el routing de `segment_overrides`**. NUNCA es, por sí misma, una autorización de descuento. La clasificación de segmento **NO autoriza, NO sugiere y NO modifica** ningún porcentaje de descuento. `autonomy_pct=0` (🔒 CORE, `DiscountAuthorizationPolicy`) prevalece por encima de cualquier resultado de segmentación: ningún `segment_id`, por alta que sea su confianza, habilita al agente a aplicar o mencionar un número de descuento por iniciativa propia. El único efecto de un segmento sobre descuentos es vía `segment_overrides` (§5.11), cuyo **único `action` soportado es `decline_no_consultation`** (declinar, NO conceder) — es decir, la segmentación sobre el eje de descuento solo puede RESTAR descuento (declinar sin consultar), nunca SUMARLO. Las reglas de decline por segmento prevalecen sobre la segmentación, no al revés. Un segmento mal clasificado no puede, en ninguna ruta, terminar en un descuento concedido autónomamente.
- **Universalidad del mecanismo.** Pregunta canónica: ¿sirve a clínica dental, veterinaria, óptica y química industrial sin modificarse? Sí: óptica clasifica "recurrente vs primera consulta vs convenio"; química industrial "comprador spot vs contrato marco"; clínica dental "particular vs aseguradora". El mecanismo es invariante; los segmentos, señales y umbral son del tenant.
- **Default ausente ⇒ `indeterminado`.** Si `cfg.segmentation` es `None` o `candidate_segments` viene vacío, el clasificador retorna siempre `indeterminate` (comportamiento conservador, sin romper). R3 (test de adaptabilidad Sem 6) pasa: cliente sin segmentos declarados opera con comportamiento por defecto en todos los flows.

Origen: spec `core/scoring/segmentation.spec.md` (Sem 5, adelantado de pendiente 2026-05-24; materializa el paso 2 de la cadena de resolución de `discount_authorization.spec.md` §5.5.3). Restricción de descuento confirmada por David 2026-05-29: "el agente NO tiene permitido dar descuento en NINGÚN producto". Tipos: `core/utils/config_loader.spec.md` §3.1 `SegmentationPolicy`/`SegmentDef`; schema: `core/utils/schema/client_config.schema.json` `$defs.SegmentationPolicy`; envelope: `core/data_model/turn_envelope.spec.md` §2 (`customer.segment_id`).


---

---

## 6. Lo que NO se debe configurar (NO va a `clients/`)

> Aunque alguien pida hacerlo configurable, estas decisiones quedan congeladas en CORE.

| Decisión | Razón |
|---|---|
| Estructura del modelo de datos | Si fuera configurable, romperíamos las queries genéricas y reportes |
| Política base de habeas data / privacidad | Riesgo legal global |
| Disclaimer "estás hablando con IA" cuando el cliente pregunta directamente | TOS Meta y normativa LATAM emergente; inviolable |
| Logging estructurado de cada turno | Necesario para evaluación y auditoría |
| Formato de prompts (placeholders `{{...}}`) | Si cada cliente tuviera su sintaxis, no habría motor común |
| Stack tecnológico (LLM, BD, orquestador) | Cliente no tiene capacidad para decidirlo; el motor lo decide |
| Convención de nombres de archivos en `clients/<cliente>/` | El loader genérico depende de ella |

---

## 7. Implementación física en el repositorio

La frontera Core/Config se hace visible en la **estructura de carpetas**, no solo en documentación.

```
core/         ← UNIVERSO CORE — referenciar un cliente concreto aquí es bug
clients/      ← UNIVERSO CONFIGURACIÓN — todo cliente vive aislado
```

Reglas de cumplimiento (auditables vía `grep` o lints futuros):

- **R1.** Buscar los identificadores del cliente real (nombre de empresa, marcas, ciudad, persona) en `core/` debe arrojar **cero matches**. Si arroja, registrar deuda en doc 11.
- **R2.** Buscar `import.*from.*clients\.` en `core/` debe arrojar **cero matches**. El CORE no importa de clientes.
- **R3.** `clients/<cliente>/` debe poder eliminarse del repo y reemplazarse por `clients/<otro_cliente>/` (con la misma estructura) sin romper el build.
- **R4.** El test de adaptabilidad de Sem 6 ejecuta R1, R2 y R3 automáticamente. Si falla, no avanzamos al piloto.

---

## 8. Deuda arquitectónica esperada (y aceptada)

Algunos casos donde sabemos que la pureza Core/Config se romperá, y aceptamos la deuda con plan de pago:

| Deuda | Cuándo aparece | Plan de pago |
|---|---|---|
| Few-shots del primer cliente en `core/prompts/` durante prototipado rápido | Al validar prompts antes de tener `clients/<cliente>/few_shots/` cargado | Movilizar a `clients/<cliente>/few_shots/` antes de cerrar la fase |
| Lógica de "calcular litros por m²" si el cliente la necesita y no es genérica | Si surge en el caso ferretería | Intentar generalizar a `calcular_dosis()`; si no, declarar `custom_tools/` con justificación |
| Mensajes de error con tono cercano hardcodeados | Sem 5 al construir tools | Mover a placeholder `{{ERROR_TONO}}` antes de Sem 6 |
| Copia embebida de `core/tools/validar_item_confirmado.js` en el jsCode del nodo 11 del workflow n8n (sync MANUAL; el Code node no importa módulos del repo) | 2026-06-10, guards [[COTIZAR]] y stock fase 2 | Generación automatizada del jsCode desde `core/tools/` (script de build) o salida de n8n; mientras tanto, todo cambio al canónico replica a mano y se verifica byte-idéntico |
| Matches R1 en `.md` explicativos de `core/` (autodeclaraciones de la regla y ejemplos) | Desde redacción de los specs | Parafrasear los sustantivos a placeholders genéricos; evaluar acotar R1 a archivos ejecutables |

Todas las deudas se registran en la sección "Deuda técnica acumulada" del doc 11.

---

## 9. Cómo evoluciona este documento

- **Sem 2 (hoy):** v1.0 — frontera establecida basada en análisis del primer cliente, referentes IA y plan de 8 semanas.
- **Sem 3:** posibles refinamientos tras POC (descubriremos limitaciones del orquestador que muevan la frontera).
- **Sem 4-5:** ajustes específicos a medida que se materializan los `core/prompts/` y `core/tools/`.
- **Sem 6:** **validación dura** con cliente sintético. Si falla, esta tabla se reescribe.
- **Sem 8:** v2.0 — frontera cerrada del MVP, lista para `clients/` adicionales.

---

## 10. Referencias

- [00 — Visión y Alcance](https://www.notion.so/35c5a37bd7538199944bfd03196b8dca) — hipótesis H3 que este documento materializa.
- [06 — Arquitectura Técnica](https://www.notion.so/35c5a37bd75381c59ba9d29d009bd268) — diseño que se deriva de esta frontera.
- [11 — Manual de Adaptación](https://www.notion.so/35c5a37bd753818e9b2df6a56d605a13) — documento vivo donde se registra cualquier desvío.
- [Decision Log D-12](https://www.notion.so/35d5a37bd7538131a2aef0d69a17b891) — Regla de Oro desde Sem 1.
- [Decision Log D-14 (preliminar)](https://www.notion.so/35d5a37bd7538131a2aef0d69a17b891) — stack candidato alineado con esta frontera.
