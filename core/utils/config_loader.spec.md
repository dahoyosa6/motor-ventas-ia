# Spec: `core/utils/config_loader`

> **Owner técnico:** `core-architect`
> **Estado:** spec aprobada — pendiente de implementación
> **Aplica a:** Sem 3 (POC n8n, implementación JS en nodo Code 4), Sem 4-5 (motor runtime, implementación Python u otra)
> **Fuentes de verdad:** `docs/core_invariant.md` §3 (fila "Sistema de placeholders" y "Pipeline RAG"), `core/README.md` ("Cómo el core consume la configuración del cliente"), `docs/sem3_n8n_build_map.md` §3a y §4.

---

## 1. Para qué existe este loader

Único componente del CORE autorizado a tocar `clients/<slug>/`. Centraliza la traducción `slug → objeto runtime tipado`. Sin él, cada nodo/módulo del motor termina reimplementando rutas, parseos y validaciones, y la frontera Core/Config se diluye (el motor empieza a "saber" cosas del cliente).

Su existencia es lo que hace falsable la R3 del Core Invariant ("`clients/<cliente>/` debe poder eliminarse y reemplazarse sin tocar `core/`"). Cualquier acceso a `clients/` que no pase por aquí es bug arquitectónico.

---

## 2. Firma pública

```python
load_client_config(
    client_slug: str,
    *,
    clients_root: Path | None = None,
    strict: bool = True,
) -> ClientConfig
```

- **`client_slug`** — string, obligatorio. Coincide con el nombre de carpeta bajo `clients/`. Validado contra regex `^[a-z][a-z0-9_]{2,63}$` antes de tocar disco (defensa anti path traversal: ningún `..`, `/`, `\`, ni espacios admitidos).
- **`clients_root`** — opcional. Path absoluto al directorio raíz de clientes. Default: resolver desde la env var `CLIENTS_ROOT`, y si no existe, anclar a `<repo_root>/clients/`. El loader nunca toma `clients_root` desde `client_slug`.
- **`strict`** — `True` en producción/CI: cualquier referencia a archivo inexistente lanza error. `False` solo para herramientas de inspección/debug que toleran configs parciales (lista los huecos en `ClientConfig.warnings`).
- **Retorno** — instancia inmutable de `ClientConfig` (dataclass / Pydantic frozen). Inmutable porque varios threads del motor leen del mismo objeto cacheado.

### Auxiliar

```python
load_active_client() -> ClientConfig
```

Conveniencia para CLIs y scripts. Lee `ACTIVE_CLIENT` de env y delega en `load_client_config(slug)`. **Prohibido usar desde dentro del motor en runtime.** Ver §9.

---

## 3. Shape del `ClientConfig`

**Decisión:** el loader NO devuelve el dict crudo del YAML. Devuelve un objeto tipado que ya tiene los archivos referenciados leídos y parseados. Razón: si el motor recibe el dict crudo, el motor termina haciendo I/O y resolución de rutas, y eso lo obliga a "saber" la convención de carpetas del cliente — exactamente lo que esta spec evita.

```
ClientConfig
├── slug: str                              # validado contra el del YAML
├── meta: ClientMeta                       # bloque `client:` del YAML
│   ├── display_name, legal_name, vertical
│   ├── country: ISO-3166-2 ("MX", "CO", ...)
│   ├── city, language (BCP-47), timezone (IANA), currency (ISO-4217)
│   └── primary_contact: { name, phone_e164, channel }
├── mvp_focus: { primary, secondary, tertiary }   # cada uno {label, metrics_target?}
├── baseline: BaselineMetrics              # opaco para el motor (solo lo usan reportes/evals)
├── prompts: PromptBlocks                  # YA LEÍDOS, no rutas
│   ├── tono: str                          # contenido de prompts/tono.md
│   ├── sobre_empresa: str
│   ├── politica_comercial: str | None
│   └── extras: dict[str, str]             # cualquier .md adicional declarado en paths.prompts.*
├── policies: PolicyBundle                 # YA PARSEADOS Y TIPADOS — ver §3.1
│   ├── escalation: EscalationPolicy | None
│   ├── discount_authorization: DiscountAuthorizationPolicy | None
│   ├── stock: StockPolicy | None
│   ├── business_hours: BusinessHours | None
│   ├── tax_rate: float | None             # opcional; null → motor no aplica impuesto
│   ├── opening_closing_copy: OpeningClosingCopy | None   # D-45: copy turn-aware (apertura + cierre)
│   └── raw_paths: dict[str, Path]         # para auditoría y para tools que necesitan repath
├── catalog: CatalogRef                    # NO carga el catálogo entero
│   ├── path: Path                         # absoluto, ya resuelto
│   ├── format: Literal["json", "csv", "jsonl"]   # inferido del sufijo + validado
│   └── checksum: str | None               # sha256 del archivo (para invalidar cache de RAG)
├── faqs_path: Path | None
├── few_shots_dir: Path | None
├── segments: dict | None                  # buyer_personas.json parseado crudo, o None
├── segmentation: SegmentationPolicy | None # política del clasificador de segmento (§5.22). candidate_segments proyectados desde `segments`. None → clasificador siempre 'indeterminate'
├── knowledge_base_dir: Path | None
├── bant_thresholds: BantThresholds
│   ├── hot: { min_score: int, rules: list }
│   ├── warm: { min_score: int }
│   └── cold: { min_score: int }
├── disclosure: DisclosurePolicy
│   ├── agent_identity: str
│   ├── reveal_ai_on_direct_question: bool   # CORE: si es False, el loader lo fuerza a True y emite warning
│   └── reveal_ai_in_first_message: bool
├── channels: ChannelConfig
│   ├── whatsapp: { enabled, number_e164, provider }
│   ├── web_widget: { enabled }
│   └── email: { enabled }
├── warnings: list[str]                    # solo poblado con strict=False
└── _source: LoaderSource                  # debug: timestamps, checksums, versión del schema
```

### 3.1. Tipos compuestos del `PolicyBundle`

Los campos del `PolicyBundle` ya no son `dict | None` opacos. Cada uno tiene dataclass tipada. El loader es el único componente CORE responsable de materializar estos tipos a partir de los YAML/JSON del cliente; ninguna tool ni flow re-parsea.

Símbolos:
- ⚠ = valor pendiente de respuesta del responsable del primer cliente (ver `pendientes_david.md`). El loader sigue funcionando sin el valor: usa defaults CORE y emite warning a `cfg.warnings`.
- 🔒 = campo CORE inviolable. El cliente NO puede sobreescribirlo; si lo intenta en su YAML, el loader fuerza el valor CORE y emite warning estilo `DisclosureGuardrailViolation`.

```
EscalationPolicy:
  notify: NotifyConfig                          # ya parseable desde config.yml líneas 15-18 (primary_contact) o desde policies/escalacion.yaml si existe
  keywords: list[str]                           # ⚠ requiere respuesta del responsable; default CORE: []
  sla_business_hours: str                       # ⚠ requiere respuesta; default CORE: "lo antes posible"
  sla_after_hours: str                          # ⚠ requiere respuesta; default CORE: "el siguiente día hábil antes de las 10:00"
  hours: BusinessHoursRef                       # referencia a BusinessHours (puede ser inline o link a cfg.policies.business_hours)
  timezone: str                                 # default: cfg.meta.timezone
  idempotency_window_min: int = 10              # 🔒 CORE inviolable
  lockout_h: int = 48                           # 🔒 CORE inviolable

NotifyConfig:
  channel: enum["whatsapp", "email", "slack", "webhook"]
  primary: NotifyTarget                         # { target: str (E.164/email/etc), name: str }
  on_call_rotation: list[OnCallSlot] | None     # opcional, Sem 7+
  group_target: str | None

NotifyTarget:
  target: str                                   # E.164, email, Slack channel id, o webhook URL
  name: str                                     # nombre humano para usar en plantillas

OnCallSlot:
  weekday: str                                  # "mon" | "mon-fri" | "sat" | etc.
  hours: str                                    # "HH:MM-HH:MM"
  target: str

DiscountAuthorizationPolicy:                    # REEMPLAZA el antiguo DiscountPolicy con tope autónomo
  consultation_ttl_min: int                     # ⚠ requiere respuesta; default CORE: 30
  on_timeout: enum["escalate", "decline", "ask_client_to_wait"]   # ⚠ requiere respuesta; default CORE: "ask_client_to_wait"
  notify_target: str | None                     # opcional override; si None, usa cfg.policies.escalation.notify.primary.target
  notify_channel: enum["whatsapp","email","slack","webhook"] | None   # opcional override; si None, usa cfg.policies.escalation.notify.channel
  context_to_share: ContextToShare              # qué contexto enviar al responsable
  autonomy_pct: float = 0.0                     # 🔒 CORE inviolable. El agente NUNCA aplica descuento por iniciativa propia. Cualquier intento del cliente de poner >0 en su YAML se fuerza a 0 y emite warning.
  max_retries_on_ask_client_to_wait: int = 2    # 🔒 CORE inviolable hard cap (defensa contra cliente eterno en limbo)
  segment_overrides: dict[str, SegmentDiscountOverride] | None = None
                                                # ⚠ por-cliente. Default None → comportamiento idéntico al original (consultar siempre al responsable).
                                                # Mecanismo CORE para "ciertos segmentos del catálogo del tenant tienen decisión de descuento ya tomada y estable; no hace falta preguntarle al humano cada vez".
                                                # La clave del dict es el `segment_id` que debe existir en `clients/<slug>/segments/buyer_personas.json` (cualquiera de los `segmentos_observados[].id` o de los buyer personas).
                                                # Si el segmento del cliente actual matchea alguna clave, el flow `discount_authorization` ejecuta el `action` configurado SIN mandar outbound al responsable (ver `core/flows/discount_authorization.spec.md` §5.5).
                                                # Si el segmento del cliente es indeterminado en runtime, NO se aplica override (fallback: consultar al responsable).
                                                # Ejemplo de uso (vive en `clients/<slug>/policies/descuentos.yaml`, NO en CORE): el primer cliente declara una clave `<su_segmento_sin_descuento>` con `action: decline_no_consultation` para codificar la regla "a este segmento no se le da descuento" que el responsable ya tiene tomada como política comercial estable. El motor solo conoce el mecanismo; el identificador del segmento lo aporta el cliente.

SegmentDiscountOverride:                        # ⚠ por-cliente. Toda la dataclass es valor, no mecanismo.
  action: enum["decline_no_consultation"]       # extensible en el futuro (Sem 7+: posibles "auto_approve_max", "redirect_to_secondary_contact", etc.). Por ahora un único valor.
  decline_message_template: str                 # texto que el agente le envía al cliente cuando aplica el override. Admite los placeholders estándar del flow ({{currency}}, {{grand_total}}, {{customer_name}}, etc.). Si renderiza vacío o falla, el flow cae al fallback CORE en `core/flows/i18n/discount_authorization_segment_decline_{lang}.txt`.
  reason_for_audit: str                         # texto interno (NO se muestra al cliente) que se persiste en `discount_authorizations.raw_metadata.segment_override.reason_for_audit` para reportes y revisión humana. Tipo: justificación comercial estable, redactada por el operador del tenant en su YAML, con fecha de decisión.

ContextToShare:
  include_customer_history: bool = True
  include_segment: bool = True
  include_competitor_mention: bool = True

StockPolicy:
  thresholds_path: Path                         # → policies/stock_thresholds.yaml (existe en el primer cliente, validado 2026-05-21)
  states: list[StateDef]                        # parseado desde el YAML v2.0 (4 estados)
  hard_rules: list[HardRule]                    # parseado desde el YAML v2.0 (4 reglas duras)
  supplier_pickup_attribute_key: str = "supplier_pickup_available"
                                                # D-46: key dentro de products.extra que el motor lee post-clasificación de estado
                                                # para decidir si el SKU es vendible vía pickup en planta del proveedor cuando EXIST<=0.
                                                # Convención CORE = "supplier_pickup_available". Override per-cliente raro
                                                # (solo por catálogo legacy heredado). Validación: pattern ^[a-z][a-z0-9_]{2,63}$.
                                                # Si la key no existe en un product.extra concreto, el motor asume False
                                                # (comportamiento legacy de 4 estados). Cualquier cliente que no use el flag
                                                # mantiene comportamiento idéntico al actual.
  stale_24h_warning: bool = True                # 🔒 CORE inviolable
  stale_48h_degrade: bool = True                # 🔒 CORE inviolable

StateDef:
  name: str                                     # "ok" | "bajo" | "critico" | "agotado" (u otros declarados por el cliente)
  threshold: int | dict                         # int absoluto o dict per-SKU
  display_label: str | None

HardRule:
  trigger: str                                  # condición declarativa (ej. "sku_bandera AND status=agotado")
  action: enum["escalate", "block_quote", "warn_agent"]
  metadata: dict

BusinessHours:
  monday: TimeRange | None                      # cada día: rango o None=cerrado
  tuesday: TimeRange | None
  wednesday: TimeRange | None
  thursday: TimeRange | None
  friday: TimeRange | None
  saturday: TimeRange | None                    # ⚠ requiere respuesta del responsable
  sunday: TimeRange | None                      # default: None (cerrado)
  timezone: str                                 # default: cfg.meta.timezone
  holidays: list[date]                          # ⚠ requiere respuesta del responsable; default CORE: []

TimeRange:
  start: str                                    # "HH:MM" 24h, IANA timezone aware via parent BusinessHours.timezone
  end: str                                      # "HH:MM"

BusinessHoursRef:                               # discriminated union
  kind: enum["inline", "link"]
  inline: BusinessHours | None                  # cuando kind=inline (escalation.yaml define sus propias horas)
  link: Literal["cfg.policies.business_hours"] | None  # cuando kind=link (escalation reutiliza business_hours global)

OpeningClosingCopy:                             # D-45. Copy turn-aware: apertura del primer turno + cierre de la interacción.
  version: str | None                            # versión del YAML del cliente (semver libre)
  opening_template: str | None                   # ⚠ requiere respuesta del responsable del tenant; default CORE: i18n fallback
                                                 # Texto del bloque de apertura. Admite placeholders estándar del orquestador
                                                 # ({{primary_contact_name}}, {{display_name}}, etc.). El disclosure reactivo
                                                 # (§5.12 Core Invariant) se compone APARTE; este template NO lo reemplaza.
  closing_template: str | None                   # ⚠ requiere respuesta del responsable; default CORE: i18n fallback
                                                 # Texto del bloque de cierre. Admite placeholders adicionales {{escalation_keyword}}
                                                 # (primer elemento de cfg.policies.escalation.keywords) y {{escalation_keywords_join}}
                                                 # (lista unida con " o "). FUENTE ÚNICA de keywords: cfg.policies.escalation.keywords.
                                                 # Declarar lista de keywords aquí es error de schema.
  emit_opening_on: enum["first_turn_in_conversation", "first_turn_after_silence_24h"]
                                                 # default CORE: "first_turn_in_conversation"
                                                 # Cuándo el orquestador inyecta opening_block ANTES del cuerpo de la respuesta del LLM.
  emit_closing_on: enum["phase_cierre", "explicit_tool_call", "never"]
                                                 # default CORE: "phase_cierre"
                                                 # Cuándo el orquestador inyecta closing_block DESPUÉS del cuerpo de la respuesta del LLM.
                                                 # "phase_cierre" requiere TurnEnvelope.phase poblado (pendiente Sem 5).
                                                 # Si el campo aún no existe en el envelope, loader emite warning phase_machine_not_implemented.
  fallback_lang: str | None                      # default: cfg.meta.language. Usado para resolver i18n fallback si los templates son null.

QuotePolicy:                                    # D-47. Política de cotización del tenant. Hoy contiene únicamente el branch de visita física para deals grandes.
  version: str | None
  visit_required_above_amount: int | None       # ⚠ requiere respuesta del responsable. Default CORE: None (motor nunca fuerza visita).
                                                # Monto en la currency del cliente (cfg.meta.currency) por encima del cual `cotizar`
                                                # NO cierra autónomamente y dispara `agendar(visita)` con `cfg.meta.primary_contact`.
                                                # El motor compara `grand_total > visit_required_above_amount` (igualdad NO dispara).
                                                # Si None/ausente, el branch nunca se activa.
  visit_required_message_template: str | None   # ⚠ default CORE: i18n fallback en core/prompts/i18n/quote_visit_required_{lang}.txt.
                                                # Texto que el agente envía al cliente final cuando el branch de visita se activa.
                                                # Admite placeholders estándar del orquestador ({{primary_contact_name}}, {{display_name}},
                                                # {{currency}}, {{grand_total}}). Si renderiza vacío o falla, fallback CORE i18n.

SegmentationPolicy:                             # §5.22. Política del clasificador de segmento. Mecanismo CORE; valores por-cliente.
  min_confidence: float = 0.6                   # 🔒 piso CORE 0.5. Umbral bajo el cual el resultado es 'indeterminado'.
                                                # Calibrable por tenant, pero el loader rechaza < 0.5 (SegmentationConfigInvalid → default 0.6 + warning).
  weights: dict[str,float] | None = None        # pesos por señal del matcher de reglas. Default CORE: iguales por señal. Mismo patrón que bant_thresholds.weights.
  llm_tiebreak_margin: float = 0.15             # margen ganador-vs-runner_up que dispara el desempate por LLM ligero (§5.2 segmentation.spec).
  candidate_segments: list[SegmentDef] = []     # ⚠ por-cliente. El set sobre el que se clasifica. Vacío → clasificador retorna siempre 'indeterminate' (conservador).
                                                # NO se declara a mano: el loader lo PROYECTA desde `clients/<slug>/segments/buyer_personas.json` (ver regla 12).
                                                # 🔒 GUARDRAIL §5.22: el segment_id resultante calibra persona/tono/ruteo/BANT y resuelve segment_overrides;
                                                # NUNCA autoriza, sugiere ni modifica un descuento. autonomy_pct=0 prevalece sobre cualquier segmentación.

SegmentDef:                                     # forma genérica de un segmento (mecanismo CORE; contenido del tenant). El motor nunca nombra un id concreto.
  id: str                                       # clave estable del segmento (string opaco, R1). CONFIG del tenant.
  match_signals: SegmentMatchSignals            # pistas declarativas para el matcher por reglas (todas opcionales).
  llm_description: str | None                   # descripción en prosa para la ruta LLM ligera de desempate.

SegmentMatchSignals:                            # todas opcionales; señales ausentes reducen evidencia (→ menor confianza), no penalizan.
  product_categories: list[str] | None          # categorías típicas del segmento (solapamiento Jaccard con las observadas).
  ticket_range: { min: float, max: float } | None
  authority_roles: list[str] | None              # roles BANT que suelen mapear a este segmento.
  timeline_horizons: list[str] | None
  keyword_hints: list[str] | None                # frases/tokens característicos (match laxo, ignora acentos/caso).
```

**Reglas de resolución del loader:**

1. **Defaults CORE aplicados automáticamente** cuando el YAML del cliente omite el campo y este tiene default CORE. Cada default aplicado se anota en `cfg.warnings` con prefijo `default_applied:` para que el operador sepa qué quedó implícito.
2. **Campos 🔒 inviolables** se imponen incluso si el YAML del cliente los contradice. Ejemplo: si `policies/descuentos.yaml` declara `autonomy_pct: 5`, el loader lo fuerza a `0` y emite warning duro.
3. **Campos ⚠ pendientes** no son error: el loader retorna el `ClientConfig` con el default CORE en su lugar y warning. La conversación funciona; la conversación con el responsable cierra los ⚠ y luego se actualiza el YAML.
4. **Validación cruzada `EscalationPolicy.hours` ↔ `BusinessHours`:** si `escalation.hours.kind == "link"`, el loader requiere que `cfg.policies.business_hours` exista; si no, error. Si `kind == "inline"`, usa esos rangos.
5. **`DiscountAuthorizationPolicy.notify_target` cascada:** si null → fallback a `cfg.policies.escalation.notify.primary.target` → fallback a `cfg.meta.primary_contact.phone_e164`. Si los tres son null, error `MissingReferencedFileError`-style: no hay a quién preguntar el descuento.
6. **`DiscountAuthorizationPolicy.segment_overrides` validación cruzada:** si el cliente declara una clave de override (ej. `mi_segmento_x`), el loader **NO** la valida contra `clients/<slug>/segments/buyer_personas.json` (no quiere reabrir ese archivo en eager; el coste de un override mal escrito es bajo — simplemente no matchea y la regla no se aplica). Sin embargo, el loader sí emite warning `segment_override_declared:<key>` por cada clave declarada para que el operador pueda auditar el config completo de un vistazo. La validación de coherencia segments-vs-overrides se hace en CI vía test dedicado, no en runtime.

7. **`OpeningClosingCopy` defaults CORE (D-45):** si el cliente no declara `paths.policies.opening_closing_copy` o el archivo está ausente, el loader instancia `OpeningClosingCopy(opening_template=None, closing_template=None, emit_opening_on="first_turn_in_conversation", emit_closing_on="phase_cierre", fallback_lang=cfg.meta.language)`. El orquestador resuelve los templates null leyendo `core/prompts/i18n/opening_block_fallback_{lang}.txt` y `core/prompts/i18n/closing_block_fallback_{lang}.txt`. Cada default aplicado se anota en `cfg.warnings` con prefijo `default_applied:opening_closing_copy.*`.

8. **Validación cruzada `closing_template` ↔ `escalation.keywords` (D-45):** si `closing_template` referencia los placeholders `{{escalation_keyword}}` o `{{escalation_keywords_join}}` y `cfg.policies.escalation.keywords` está vacío incluso después de aplicar defaults CORE (`{AGENTE,HUMANO,ASESOR,PERSONA}`), el loader emite warning `closing_template_references_empty_keywords`. NO aborta: el orquestador rendea con el default CORE. Es el cliente quien debe corregir su YAML.

9. **Bloqueo de keywords duplicadas (D-45):** el schema rechaza cualquier campo `keywords` dentro de `opening_closing_copy`. Fuente única: `cfg.policies.escalation.keywords`. Si el cliente lo declara, error `InvalidFieldValueError` con mensaje explícito apuntando a `policies/escalacion.yaml`.

10. **`QuotePolicy` defaults CORE (D-47):** si el cliente no declara `paths.policies.quote_policy` o el archivo está ausente, el loader instancia `QuotePolicy(visit_required_above_amount=None, visit_required_message_template=None)`. Con ambos None, el branch de visita NUNCA se dispara y `cotizar` opera como antes. Cualquier default aplicado se anota en `cfg.warnings` con prefijo `default_applied:quote.*`. Si `visit_required_above_amount` se declara <= 0, error `InvalidFieldValueError`.

11. **`StockPolicy.supplier_pickup_attribute_key` (D-46):** si el cliente no declara la key, el loader aplica el default CORE `"supplier_pickup_available"`. Si la declara con valor inválido (no string, vacío, no matchea `^[a-z][a-z0-9_]{2,63}$`), `InvalidFieldValueError`. El loader NO valida que la key exista en algún `product.extra` del catálogo (eso es responsabilidad del data-engineer/data ingest, no del loader); ausencia ⇒ flag asumido `False` en runtime.

12. **`SegmentationPolicy.candidate_segments` proyectado desde `buyer_personas.json` (§5.22):** el operador NO declara `candidate_segments` a mano. El loader lo deriva del `clients/<slug>/segments/buyer_personas.json` ya parseado (`cfg.segments`): por cada buyer persona / `segmentos_observados[].id` del tenant, un adaptador CORE proyecta sus campos por-cliente al `SegmentMatchSignals` genérico — `calibracion_bant` (budget/authority/timeline) → `ticket_range`/`authority_roles`/`timeline_horizons`; `frases_tipicas` → `keyword_hints`; hints de producto → `product_categories`; descripción de la persona → `llm_description`. El `id` viaja como string opaco (R1). Este adaptador es el ÚNICO lugar que conoce el mapeo `buyer_personas.json` → `SegmentDef`; ninguna tool ni flow re-parsea. Si `cfg.segments` es `None`/vacío, `candidate_segments=[]` y el clasificador retorna siempre `indeterminate` (conservador, sin romper R3). El `min_confidence` calibrado del tenant (si lo declara en `config.yml`/policy) se valida contra el piso CORE 0.5; < 0.5 → `SegmentationConfigInvalid` → default 0.6 + warning `segmentation_min_confidence_below_floor`. 🔒 GUARDRAIL §5.22: el segmento proyectado calibra persona/tono/ruteo/BANT y resuelve `segment_overrides`; NUNCA habilita un descuento (el único efecto sobre descuentos es vía `segment_overrides.action=decline_no_consultation`, que RESTA, nunca SUMA).

**Auditoría R1 sobre los tipos:** ningún campo, valor por defecto, ni enum contiene strings del primer cliente. Cumple. Los placeholders en defaults (`"lo antes posible"`, `"el siguiente día hábil antes de las 10:00"`) son texto genérico hispano-LATAM aplicable a cualquier PyME.

---

**Auditoría R1 sobre este shape:** ningún campo, tipo ni nombre contiene strings prohibidos. Todos son sustantivos genéricos del dominio "PyME comercial". Los únicos lugares donde aparece contenido específico del cliente son **valores en runtime**, no claves del tipo. El motor consume `cfg.prompts.tono` sin saber jamás qué dice — es solo data. **R1 cumplida.**

**Justificación de qué se carga eager vs lazy:**
- **Eager** (en `load_client_config`): prompts `.md`, policies (`.json`/`.yaml`), `segments`, disclosure, BANT, channels. Son pequeños (kB), se usan en cada turno, y validarlos al arranque previene fallos a media conversación.
- **Lazy** (referencia path, no contenido): catálogo, FAQs, few-shots, knowledge_base. Pueden ser MB; los consume el pipeline RAG con su propio caching/indexado, no el orquestador.

---

## 4. Campos del `config.yml` actual revisados desde el ángulo Core/Config

| Campo en `config.yml` | Veredicto | Comentario |
|---|---|---|
| `client.*` | OK config | Genérico, requerido para todo cliente. |
| `mvp_focus.*` | **Sospechoso** | El motor en runtime no debería ramificar por `mvp_focus`. Es metadato para humanos y para reportes/evals. Recomiendo: el loader lo expone, pero ningún módulo de `core/flows/` o `core/scoring/` puede consumirlo. Si lo consume, es bug. Anotar como observación, no como bloqueante. |
| `baseline.*` | OK config (uso restringido) | Solo evaluation/reportes lo leen. El motor de conversación no. |
| `paths.*` | OK config | Es exactamente lo que el loader resuelve. |
| `bant_thresholds.*` | OK config (calibración) | Coincide con la tabla maestra del Core Invariant §3 fila "Thresholds BANT". |
| `disclosure.agent_identity` | OK config | Es el `{{NOMBRE_VENDEDOR}}` materializado. |
| `disclosure.reveal_ai_on_direct_question` | **CORE inviolable disfrazado de config** | El cliente NO puede ponerlo en `false`. Ver Core Invariant §6 ("Disclaimer 'estás hablando con IA' cuando el cliente pregunta directamente — inviolable"). El loader debe **forzar a `true`** si llega `false` y emitir warning duro (no error, para no romper el arranque, pero registrado). El cliente solo puede calibrar `reveal_ai_in_first_message`. |
| `disclosure.reveal_ai_in_first_message` | OK config | Esta sí es decisión del cliente. |
| `channels.*` | OK config | Aunque `provider: "meta_cloud_api"` está hoy hardcodeado a Meta, eso lo resuelve el connector core: el campo es declarativo. |
| `policies.escalation` apunta a `stock_thresholds.yaml` | **Naming inconsistente, no bloqueante** | El campo se llama `escalation` pero el archivo es de stock. Con la ampliación §3.1, lo correcto es separar en `paths.policies.escalation` (→ `escalacion.yaml`) y `paths.policies.stock_thresholds` (→ `stock_thresholds.yaml`). Mientras el cliente no migre, el loader sigue el path tal cual pero loguea `path_naming_mismatch` en `warnings`. Arreglar el naming es responsabilidad del owner del cliente, no del core. |
| `policies.discount_authorization` apunta a `descuentos.yaml` | OK config (NUEVO §3.1) | Reemplaza la antigua noción de `policies.discounts` con tope autónomo. El loader parsea a `DiscountAuthorizationPolicy`; si el YAML legacy tiene `default.max_pct`/`by_segment`/`require_approval_above_pct`, el loader los ignora, emite warning `legacy_discount_fields_ignored`, y aplica `autonomy_pct=0` 🔒. |
| `policies.business_hours` apunta a `business_hours.yaml` | OK config (NUEVO §3.1) | Opcional. Si null, `EscalationPolicy.hours` solo puede ser `kind=inline`. |
| `policies.opening_closing_copy` apunta a `opening_closing.yaml` | OK config (NUEVO §3.1, D-45) | Opcional. Si ausente, loader instancia defaults CORE y orquestador usa i18n fallback. Materializa los slots `{{tenant.opening_block}}` y `{{tenant.closing_block}}` definidos en `core/prompts/system_template.spec.md` §12. Reemplaza al Markdown libre legado `policies/copy_disclosure_v1.md`, que se conserva como documento humano de firma del responsable pero NO lo lee el motor. |
| `policies.quote_policy` apunta a `quote_policy.yaml` | OK config (NUEVO §3.1, D-47) | Opcional. Si ausente, loader instancia `QuotePolicy(visit_required_above_amount=None, ...)` y el branch de visita NUNCA se dispara (`cotizar` opera como antes). Si el tenant lo declara, materializa el umbral monetario y el copy de aviso. El branch NO es escalación ni lockout — es ruta alterna de cierre via `agendar()`. |

**Conclusión de auditoría del YAML actual:** la única violación real es `disclosure.reveal_ai_on_direct_question` siendo configurable a `false`. Acción: el loader normaliza ese campo. Todo lo demás es config legítima.

---

## 5. Tabla de errores

Todos heredan de una base `ConfigLoaderError` con atributos `slug`, `path` (cuando aplique) y `cause`. El motor distingue por tipo para decidir si reintenta, escala o aborta.

| Excepción | Cuándo se dispara | Acción esperada del caller |
|---|---|---|
| `ClientSlugInvalidError` | El `client_slug` no matchea el regex `^[a-z][a-z0-9_]{2,63}$`, o contiene `..`/`/`. | Abortar inmediato. No es runtime error, es input inválido del webhook. |
| `ClientNotFoundError` | `clients/<slug>/` no existe en disco. | Abortar; loguear como `tenant_unknown`. |
| `ConfigFileMissingError` | `clients/<slug>/config.yml` no existe. | Abortar; el cliente está mal scaffoldeado. |
| `MalformedYamlError` | El YAML no parsea (sintaxis rota, indentación, etc.). | Abortar; mensaje incluye line/column del parser. |
| `MissingRequiredFieldError` | Falta una clave declarada como `required` en el JSON Schema (ver §8). | Abortar; mensaje cita JSON Pointer del campo faltante. |
| `InvalidFieldValueError` | Tipo o valor fuera de enum (`disclosure.reveal_ai_on_direct_question` no booleano, `country` no es ISO-3166). | Abortar; mensaje cita el valor recibido y el esperado. |
| `MissingReferencedFileError` | Una ruta en `paths.*` apunta a un archivo que no existe en disco. | Con `strict=True`: abortar. Con `strict=False`: se anota en `warnings`. |
| `PathTraversalError` | Una ruta en `paths.*` resuelve fuera de `clients/<slug>/` (intento de `../../etc/...`). | Abortar siempre, incluso con `strict=False`. Esto es defensa de seguridad, no de UX. |
| `DisclosureGuardrailViolation` (warning, no excepción) | `reveal_ai_on_direct_question` viene `false`. | El loader fuerza `true` y emite warning a stderr + a `cfg.warnings`. Nunca aborta. |

Errores que el loader **NO** maneja (responsabilidad del motor downstream):
- Catálogo malformado → el RAG pipeline lo valida cuando ingesta.
- Few-shots con conversaciones inválidas → el motor de prompts lo detecta.

Razón: si el loader validara cada archivo profundamente, se vuelve la única pieza con conocimiento de todos los formatos. Mejor cada subsistema valida lo suyo.

---

## 6. Resolución de rutas relativas

Algoritmo:

1. Anclar la raíz del cliente: `client_root = (clients_root / slug).resolve()`. Esta es la única raíz permitida para este cliente.
2. Para cada ruta en `paths.*` del YAML, que viene como `./prompts/tono.md` o `./catalog/catalogo.json`:
   - Construir candidata: `(client_root / path_str).resolve()`.
   - **Verificar contención:** `candidate.is_relative_to(client_root)`. Si no, lanzar `PathTraversalError`. Esto bloquea `./../../etc/passwd` y similares.
   - Si `strict=True`, verificar `candidate.exists()`; si no, `MissingReferencedFileError`.
3. Guardar el path resuelto absoluto en el `ClientConfig` (no se vuelve a tocar el string relativo).

**Por qué esta defensa:** el `client_slug` viene del payload del webhook (n8n nodo 2). Aunque el regex filtra el slug, las rutas dentro del YAML las escribe el operador humano que adapta al cliente. Un YAML malicioso con `catalog: "../../../etc/passwd"` no debe poder leerse. Cuesta 3 líneas y cierra una clase entera de bugs.

---

## 7. Política de caching

**Producción (proceso largo del motor):**
- Cachear `ClientConfig` por `(slug, mtime de config.yml, mtime de cada archivo referenciado eager)`. Si cualquier mtime cambia, invalidar.
- Cache en memoria del proceso, no compartida entre workers. Para multi-tenant simultáneo (varios slugs activos), el cache es un dict `{slug: ClientConfig}` con TTL suave de 5 min como fallback en caso de filesystems donde mtime no es confiable (montajes de red).
- Razón del TTL: hot reload de config sin reiniciar el motor. Importante para piloto Sem 7-8 donde se ajustarán prompts in-situ.

**Tests:**
- `lru_cache` deshabilitado vía fixture. Cada test que toca el loader pide config fresca.
- Razón: tests parametrizados crean clientes sintéticos temporales; el cache cruzaría estados.

**CLI / scripts:**
- Sin cache. Vida del proceso es corta.

**Para n8n (Sem 3):** la noción de cache no aplica al nodo Code (cada ejecución es stateless). El "cache" en Sem 3 es trivial: leer en cada turno. Aceptable por volumen del POC.

---

## 8. Schema validation

Validar contra JSON Schema, siguiendo el patrón existente en `tests/evals/schema/rag_groundtruth.schema.json`.

**Ubicación propuesta:** `core/utils/schema/client_config.schema.json`.

**Claves obligatorias del `config.yml` (mínimo viable, derivado de ambos clientes existentes):**

- `client.slug` (string, regex igual al del input)
- `client.display_name` (string no vacío)
- `client.country` (enum: `MX`, `CO`, `AR`, `CL`, `PE`, `EC`, `BO`, `UY`, `PY`, `VE`, `CR`, `PA`, `GT`, `SV`, `HN`, `NI`, `DO` — todo LATAM hispano del scope)
- `client.language` (string, patrón BCP-47, default permitido `es-XX`)
- `client.timezone` (string, IANA)
- `client.currency` (ISO-4217)
- `paths.prompts.tono` (string, ruta relativa)
- `paths.prompts.sobre_empresa` (string, ruta relativa)
- `bant_thresholds.hot.min_score` (integer 0-100)
- `bant_thresholds.warm.min_score` (integer 0-100, < hot)
- `bant_thresholds.cold.min_score` (integer 0-100, < warm, típicamente 0)
- `disclosure.agent_identity` (string no vacío)
- `disclosure.reveal_ai_on_direct_question` (boolean — pero ver §4: el loader lo fuerza a `true`)
- `disclosure.reveal_ai_in_first_message` (boolean)
- `channels.whatsapp.enabled` (boolean)

**Claves opcionales:**
- `paths.catalog`, `paths.faqs`, `paths.few_shots`, `paths.segments`, `paths.knowledge_base`
- `paths.policies.escalation`, `paths.policies.discount_authorization`, `paths.policies.stock_thresholds`, `paths.policies.business_hours`, `paths.policies.opening_closing_copy` (D-45), `paths.policies.quote_policy` (D-47)
- `mvp_focus.*`, `baseline.*`
- `channels.web_widget`, `channels.email`

**Validaciones cruzadas** (vía `allOf` como en el schema RAG existente):
- Si `channels.whatsapp.enabled == true`, entonces `channels.whatsapp.number_e164` es requerido y matchea `^\+\d{8,15}$`.
- `bant_thresholds.hot.min_score > warm.min_score > cold.min_score`.
- Si existe `paths.catalog`, el sufijo debe estar en `.json | .csv | .jsonl`.

El schema se ejecuta **antes** que la lectura de archivos referenciados. Razón: fallar barato si el YAML es estructuralmente inválido, antes de hacer I/O.

---

## 9. Variable de entorno `ACTIVE_CLIENT` — alcance exacto

- **En runtime del agente (servidor que atiende webhooks):** el `client_slug` viene **siempre** del payload del request, ruteado por el nodo Set (Sem 3, n8n) o por el handler del webhook (Sem 4-5, Python). `ACTIVE_CLIENT` se ignora.
- **En CLIs y scripts** (`scripts/ingest_catalog.py`, `scripts/run_eval.py`, etc.): `ACTIVE_CLIENT` es la fuente principal. La función `load_active_client()` existe para esto.
- **En tests:** ninguna de las dos. Cada test pasa `client_slug` explícito a `load_client_config`. Si un test depende de `ACTIVE_CLIENT`, es test mal escrito.

**Razón:** en multi-tenant simultáneo (Sem 6+), un proceso del motor sirve a varios clientes al mismo tiempo. Una env var global rompe ese modelo. La env var sobrevive solo como conveniencia para single-tenant offline.

Esta regla queda registrada como caso límite §5.9 en `docs/core_invariant.md`.

---

## 10. Contrato cross-stack (Sem 3 JS vs Sem 4-5 Python)

**El contrato compartido es el JSON Schema del `config.yml` + el shape del `ClientConfig` (§3)**, no la implementación.

- **Fuente de verdad única:** `core/utils/schema/client_config.schema.json`.
- **Sem 3 (nodo Code 4 de n8n):** valida el YAML cargado contra el schema usando `ajv` (que ya está en el runtime de n8n) o, si `NODE_FUNCTION_ALLOW_EXTERNAL` no lo expone, importarlo vía la misma técnica que `js-yaml`. La salida es un objeto JS que cumple el shape de `ClientConfig` (sin tipos estáticos, pero con las mismas claves).
- **Sem 4-5 (Python):** valida con `jsonschema` o, mejor, genera la dataclass desde el schema (Pydantic `parse_obj`). La salida es la instancia tipada de §3.

El contrato es el schema **+ el shape del objeto resultante (§3)**, no solo el schema del YAML. Razón: el shape `ClientConfig` también define qué se hace eager vs lazy y cómo se nombran los campos en runtime. Si Sem 4-5 cambia los nombres de los campos en el objeto, el motor entero se reescribe. Por eso el shape es contrato también.

**Decisión: Camino A (`js-yaml` vía `NODE_FUNCTION_ALLOW_EXTERNAL`) como oficial.**

Justificación:
- **Camino A:** depende de 1 línea de configuración del entorno de ejecución de n8n (`NODE_FUNCTION_ALLOW_EXTERNAL`). Da un parser YAML completo, mantenido, idéntico semánticamente a PyYAML (ambos siguen YAML 1.1/1.2). Si un cliente futuro añade un bloque `|` multilínea o un anchor, A lo aguanta sin cambios.
- **Camino B (parser inline):** funcional para los YAML actuales (~30 líneas), pero **deuda creciente**: el día que alguien añada `<<: *defaults` o un escape exótico, hay que extender el parser, y el divergir respecto a PyYAML es garantizado. Inaceptable como oficial.
- **Camino C (JSON paralelo):** correctamente rechazado en el build map. No se reconsidera.

**Recomendación operativa:** A oficial. B vive como snippet documentado en este mismo archivo, apéndice "Fallback de emergencia para n8n sin NODE_FUNCTION_ALLOW_EXTERNAL". Si B se usa alguna vez en producción, es deuda registrada en doc 11.

---

## 11. Ejemplos de invocación

### Python (Sem 4-5, dentro del motor)

```python
from core.utils.config_loader import load_client_config, ClientNotFoundError

def handle_webhook(payload: dict) -> dict:
    slug = payload["client_slug"]   # nunca de env var en runtime
    try:
        cfg = load_client_config(slug)
    except ClientNotFoundError:
        return {"status": "tenant_unknown", "code": 404}

    system_prompt = SYSTEM_PROMPT_TEMPLATE \
        .replace("{{TONO}}", cfg.prompts.tono) \
        .replace("{{SOBRE_EMPRESA}}", cfg.prompts.sobre_empresa) \
        .replace("{{NOMBRE_VENDEDOR}}", cfg.disclosure.agent_identity)

    # El catálogo NO se lee aquí. Solo el path se pasa al RAG.
    rag_response = catalog_tool.search(
        query=payload["message"],
        catalog_path=cfg.catalog.path,
        tenant=cfg.slug,
    )
    ...
```

### JavaScript (Sem 3, nodo Code 4 de n8n)

```js
const yaml = require('js-yaml');
const fs = require('fs').promises;
const path = require('path');
const Ajv = require('ajv');

const slug = $input.item.json.client_slug;
if (!/^[a-z][a-z0-9_]{2,63}$/.test(slug)) {
  throw new Error(`ClientSlugInvalidError: ${slug}`);
}

const clientRoot = path.resolve('/workspace/clients', slug);
const yamlBuf = await this.helpers.getBinaryDataBuffer(0, 'config_yml');
const rawCfg = yaml.load(yamlBuf.toString('utf8'));

// Validación contra schema compartido (la misma fuente de verdad que Python).
const schema = require('/workspace/core/utils/schema/client_config.schema.json');
const validate = new Ajv({ allErrors: true }).compile(schema);
if (!validate(rawCfg)) {
  throw new Error(`MissingRequiredFieldError: ${JSON.stringify(validate.errors)}`);
}

// Disclosure guardrail (núcleo inviolable).
if (rawCfg.disclosure.reveal_ai_on_direct_question === false) {
  console.warn('DisclosureGuardrailViolation: forcing reveal_ai_on_direct_question=true');
  rawCfg.disclosure.reveal_ai_on_direct_question = true;
}

// Resolver rutas y leer prompts (eager).
const resolveSafe = (rel) => {
  const abs = path.resolve(clientRoot, rel);
  if (!abs.startsWith(clientRoot + path.sep)) {
    throw new Error(`PathTraversalError: ${rel}`);
  }
  return abs;
};

const tono = await fs.readFile(resolveSafe(rawCfg.paths.prompts.tono), 'utf8');
const sobreEmpresa = await fs.readFile(resolveSafe(rawCfg.paths.prompts.sobre_empresa), 'utf8');

const clientConfig = {
  slug,
  meta: rawCfg.client,
  prompts: { tono, sobre_empresa: sobreEmpresa },
  disclosure: rawCfg.disclosure,
  bant_thresholds: rawCfg.bant_thresholds,
  channels: rawCfg.channels,
  catalog: rawCfg.paths.catalog ? { path: resolveSafe(rawCfg.paths.catalog) } : null,
};

return [{ json: { clientConfig } }];
```

El shape del objeto JS resultante usa **exactamente las mismas claves** que el `ClientConfig` Python (§3). Esto es el contrato cross-stack en acción.

---

## 12. Fuera de alcance del loader

- Hot reload con watchers de filesystem. Para Sem 7-8.
- Multi-region (un cliente en MX y otro en CO con configs distintas por región). Sem 8+.
- Secrets (tokens Meta, API keys). Viven en variables de entorno fuera del repo (Core Invariant §5.7); el loader NO los mezcla con `config.yml`. Si el motor los necesita, los lee aparte.
- Migración de schema (versionado del `config.yml` si la estructura cambia). Cuando ocurra: añadir campo top-level `schema_version: "1.0"`, y el loader maneja una tabla de migraciones. No hace falta para Sem 3.
- Validación profunda del catálogo, FAQs, few-shots: cada subsistema lo hace.

---

## 13. Observaciones para el PM

1. Crear `core/utils/schema/client_config.schema.json` siguiendo §8 (lo puede hacer el engineer que implemente).
2. Commit aparte añade §5.9 a `docs/core_invariant.md`: regla de scope de `ACTIVE_CLIENT`.
3. `mvp_focus` y `baseline` están en el YAML pero deben ser **invisibles** al motor conversacional — solo evals/reportes los consumen. Vigilar en code review de Sem 4-5.

4. **(D-45)** El sub-bundle `OpeningClosingCopy` exige dos archivos i18n CORE nuevos en `core/prompts/i18n/`: `opening_block_fallback_{lang}.txt` y `closing_block_fallback_{lang}.txt`. Owner: `prompt-conversation-engineer`. NO bloqueante de la implementación del primer cliente (que ya provee templates en `clients/<slug>/policies/opening_closing.yaml`). Bloqueante de R3 (test de adaptabilidad Sem 6) si `clients/clinica_demo/` se prueba sin templates propios.
5. **(D-47)** El sub-bundle `QuotePolicy` exige un archivo i18n CORE nuevo en `core/prompts/i18n/`: `quote_visit_required_{lang}.txt`. Owner: `prompt-conversation-engineer`. NO bloqueante de la implementación del primer cliente (que ya provee `visit_required_message_template` en `clients/<slug>/policies/quote_policy.yaml`). Bloqueante de R3 si un cliente declara el umbral pero no el template.
6. El renombrado de `policies.escalation → policies.stock_thresholds` en el YAML de un tenant lo decide el owner del cliente, no el core.
