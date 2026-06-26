"""
Eval CONVERSACIONAL del agente completo contra tests/evals/agent_demo_cases.jsonl.

Un nivel por encima de run_rag_eval.py: aquel mide solo retrieval (¿el SKU correcto
está en top-K?). Éste corre el AGENTE COMPLETO — webhook n8n -> nodo 2 (router) ->
3/4 (config + system prompt) -> 5 (AI Agent) -> tools (consultar_catalogo / consultar_stock)
-> 11 (disclosure) -> 12 (log a Supabase) — y evalúa la RESPUESTA del agente con:

  1. Checks deterministas (baratos, sin LLM) para los guardrails inviolables:
     must_contain_any, must_not_match, price_grounded, expect_escalation.
  2. LLM-as-judge (opcional, --no-judge para saltarlo) para tono/pertinencia/
     manejo de objeción/no-invención de aplicaciones, con rúbrica por caso.

Driver (Fase 0 del plan de pruebas):
  - POST sintético al webhook local de n8n (poc-agente). El nodo 2 acepta el shape
    sintético {message, phone, client_slug} (con fallback al shape real de Meta).
  - Multi-turno: cada turno del caso se envía con el MISMO phone (wa_id) para
    ejercitar la memoria (nodo 6b - Window Buffer Memory). Cada caso usa un phone
    único por corrida para no arrastrar memoria entre casos.
  - La respuesta del agente NO vuelve en el body del webhook (nodo 13 responde
    EVENT_RECEIVED; el reply real sale por el nodo 14 a la Graph API). Se LEE de la
    tabla `turns` (role='assistant') que el nodo 12 escribe vía RPC poc_log_turn.
    Lectura con SERVICE_ROLE (script local confiable; NUNCA se expone a n8n — mismo
    patrón aprobado el 2026-05-30 para los ETL de re-ingest).

Pre-requisitos:
  - Stack local arriba: instancia de n8n en :5678 + Supabase accesible.
    Catálogo + inventario ya ingestados (run_rag_eval.py en verde).
  - .env con SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (para judge).
  - Variable opcional N8N_WEBHOOK_URL (default http://localhost:5678/webhook/poc-agente).

Uso:
  .venv/bin/python3 tests/evals/run_agent_eval.py                 # corre todo + reporte
  .venv/bin/python3 tests/evals/run_agent_eval.py --no-judge      # solo checks deterministas
  .venv/bin/python3 tests/evals/run_agent_eval.py --category guardrail
  .venv/bin/python3 tests/evals/run_agent_eval.py --case CONV001
  .venv/bin/python3 tests/evals/run_agent_eval.py --dry-run       # valida dataset + payloads, sin red
  .venv/bin/python3 tests/evals/run_agent_eval.py --json > tests/evals/results/agent_eval_$(date +%Y%m%d).json

Nota de cobertura: los checks que dependen de context.now_iso (sla_horario) o de la
detección fina de escalamiento (tool escalar_humano es stub en el POC) son
aproximaciones por texto hasta que esas piezas se cableen (Sem 5). Están marcadas en
los `notes` del caso. Lo que SÍ es fiel hoy: catálogo, stock, disclosure, formato,
anti-derivación, no-inventar-precio y aislamiento multi-tenant (vía client_slug).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATASET = REPO_ROOT / "tests" / "evals" / "agent_demo_cases.jsonl"
SCHEMA = REPO_ROOT / "tests" / "evals" / "schema" / "agent_eval_case.schema.json"
# Fuente de verdad de precios para price_grounded: export directo de la tabla
# `products` (Supabase) del tenant activo, precios CON IVA. Se regenera con
# scripts/export_products_eval_csv.py tras cada refresco de catálogo.
# En este repo público se usa el catálogo sintético de la clínica demo.
CATALOG_CSV = REPO_ROOT / "clients" / "clinica_demo" / "catalog" / "catalogo_clinica_demo.csv"

TENANT = "clinica_demo"
DEFAULT_WEBHOOK = "http://localhost:5678/webhook/poc-agente"
POLL_TIMEOUT_S = 120     # cuánto esperar la respuesta del agente por turno
POLL_INTERVAL_S = 2.0
TURN_GAP_S = 1.5         # pausa entre turnos del mismo caso
CASE_GAP_S = 4.0         # pausa entre casos: evita saturar el stack n8n/Anthropic
TIMEOUT_RETRIES = 1      # reintentos ante timeout (stack saturado transitorio)
RETRY_BACKOFF_S = 20.0   # pausa antes de reintentar un caso que dio timeout

# Pistas de escalamiento a humano (aprox. hasta cablear escalar_humano, Sem 5).
# Endurecido 2026-06-09 (triaje 06-05 §3): solo cuentan COMPROMISOS ACTIVOS de
# transferir/escalar ("te comunico", "ya pasé tu caso"). Sustantivos sueltos como
# "un asesor" o "una persona del equipo" daban falsos positivos cuando el agente
# solo hacía disclosure ("una persona del equipo te atenderá en horario X") o
# preguntaba antes de escalar (ESC010/ESC011).
ESCALATION_CUES = [
    r"escrib[ae]\s+agente",
    r"(te|lo|la) (comunico|conecto|transfiero|canalizo)",
    r"(te|lo|la) paso (con|a)\b",
    r"(voy a|ya) (comunicarte|conectarte|pasarte|canalizarte|transferirte)",
    r"(voy a|ya) (pasar|escalar|canalizar|enviar) (tu|el|este) (caso|pedido|mensaje|solicitud)",
    r"ya (pase|escale|canalice|envie|mande|comunique) (tu|el|este) (caso|pedido|mensaje|solicitud|reporte)",
    r"(un )?asesor te atendera",
    r"para que te atiendan",
    r"paso (tu|el|este) (caso|pedido|mensaje|solicitud)",
    r"voy a escalar", r"lo escalo", r"\bescalando\b",
    r"le (paso|aviso|comento|informo) (a jos[eé]|a un asesor|al equipo|a alguien del equipo)",
    r"se (pondra|va a poner) en contacto",
    r"te (contactara|buscara|llamara|escribira)",
    r"te (va|van) a (contactar|buscar|llamar|escribir)",
    r"en (un momento|breve|unos minutos) te (atiende|contacta|escribe|llama)",
]

# Frases que NEUTRALIZAN un cue dentro de la MISMA oración: ofertas condicionales
# ("si prefieres, puedo pasarte…") y confirmaciones previas a escalar ("¿quieres
# que te comunique…?"). No son escalamiento ejecutado.
ESCALATION_OFFER_CUES = [
    r"\bsi (quieres|prefieres|gustas|deseas|necesitas|lo necesitas|asi lo prefieres)\b",
    r"(quieres|deseas|prefieres) que", r"te gustaria",
    r"(puedo|podria) (comunicarte|conectarte|pasarte|canalizarte|transferirte|escalarte)",
]


def detect_escalation(folded_reply: str) -> bool:
    """Escalamiento POR ORACIÓN: un cue solo cuenta si la oración que lo contiene
    NO es pregunta (confirmación previa) NI oferta condicional (disclosure)."""
    sentences = re.split(r"(?<=[.!?\n])\s+", folded_reply)
    for s in sentences:
        if "?" in s or "¿" in s:
            continue  # pregunta de confirmación, no escalamiento ejecutado
        if any(rx(p).search(s) for p in ESCALATION_OFFER_CUES):
            continue  # oferta condicional / disclosure
        if any(rx(c).search(s) for c in ESCALATION_CUES):
            return True
    return False


# ----------------------------------------------------------------------------
# Utilidades de texto (folding de acentos para regex robustos)
# ----------------------------------------------------------------------------
def fold(text: str) -> str:
    """minúsculas + sin acentos, para matching tolerante."""
    nfkd = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()


def rx(pattern: str):
    return re.compile(fold(pattern), re.IGNORECASE)


# ----------------------------------------------------------------------------
# Carga de entorno, dataset, catálogo
# ----------------------------------------------------------------------------
def load_env_or_die(need_judge: bool) -> dict:
    try:
        from dotenv import load_dotenv
        load_dotenv(REPO_ROOT / ".env")
    except ImportError:
        pass
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url:
        sys.exit("❌ SUPABASE_URL no está en .env.")
    if not key:
        sys.exit("❌ SUPABASE_SERVICE_ROLE_KEY falta en .env "
                 "(se usa solo para LEER turns; nunca se expone a n8n).")
    env = {
        "SUPABASE_URL": url.rstrip("/"),
        "SERVICE_KEY": key,
        "WEBHOOK": os.getenv("N8N_WEBHOOK_URL", DEFAULT_WEBHOOK),
        "ANTHROPIC_API_KEY": os.getenv("ANTHROPIC_API_KEY"),
        "JUDGE_MODEL": (os.getenv("CLAUDE_MODEL_JUDGE")
                        or os.getenv("CLAUDE_MODEL_CHEAP")
                        or "claude-haiku-4-5-20251001"),
        # Juez fuerte: solo se invoca cuando el juez barato emite FAIL/PARTIAL
        # con cita no verificable en el transcript (anti-alucinación).
        "JUDGE_MODEL_STRONG": (os.getenv("CLAUDE_MODEL_JUDGE_STRONG")
                               or "claude-sonnet-4-6"),
    }
    if need_judge and not env["ANTHROPIC_API_KEY"]:
        sys.exit("❌ ANTHROPIC_API_KEY falta en .env (requerido para LLM-as-judge; "
                 "usa --no-judge para saltarlo).")
    return env


def load_dataset() -> list[dict]:
    if not DATASET.exists():
        sys.exit(f"❌ Dataset no encontrado: {DATASET}")
    cases = []
    with DATASET.open(encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                cases.append(json.loads(line))
            except json.JSONDecodeError as e:
                sys.exit(f"❌ Línea {i} de agent_demo_cases.jsonl no es JSON válido: {e}")
    return cases


def validate_schema(cases: list[dict]) -> None:
    """Valida contra el JSON Schema si jsonschema está disponible (best-effort)."""
    try:
        import jsonschema
    except ImportError:
        print("⚠️  jsonschema no instalado; salto validación de schema.",
              file=sys.stderr)
        return
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    ids = set()
    for c in cases:
        jsonschema.validate(c, schema)
        if c["case_id"] in ids:
            sys.exit(f"❌ case_id duplicado: {c['case_id']}")
        ids.add(c["case_id"])
    print(f"✅ Schema OK — {len(cases)} casos válidos, ids únicos.", file=sys.stderr)


def load_catalog_prices() -> dict:
    """Precios del catálogo para price_grounded.

    Devuelve {"exact": set[str 2-decimales], "values": list[float]}: el set para
    match exacto, la lista para la tolerancia de redondeo (ver _price_in_catalog).
    Truthy/falsy se preserva: dict vacío => check se salta (catálogo ausente)."""
    if not CATALOG_CSV.exists():
        print(f"⚠️  Catálogo no encontrado ({CATALOG_CSV}); price_grounded se saltará.",
              file=sys.stderr)
        return {}
    exact: set[str] = set()
    values: list[float] = []
    with CATALOG_CSV.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        price_cols = [c for c in (reader.fieldnames or [])
                      if re.search(r"precio|price|unit_price|importe", c, re.I)]
        if not price_cols:
            print("⚠️  No hallé columna de precio en el catálogo; price_grounded se saltará.",
                  file=sys.stderr)
            return {}
        for row in reader:
            for col in price_cols:
                raw = (row.get(col) or "").strip()
                num = _to_amount(raw)
                if num is not None and f"{num:.2f}" not in exact:
                    exact.add(f"{num:.2f}")
                    values.append(num)
    return {"exact": exact, "values": values}


def _price_in_catalog(amt: float, catalog_prices: dict) -> bool:
    """True si el precio citado está anclado al catálogo.

    Criterio de tolerancia (triaje 2026-06-05 §3: el agente redondea $4,376 a
    $4,380/$4,400 para leerse natural y eso NO es inventar): acepta el monto si
    (a) coincide EXACTO con un precio del catálogo, o
    (b) es algún precio del catálogo redondeado a la DECENA o CENTENA más cercana, o
    (c) es un TOTAL = precio de catálogo × cantidad entera (2..20), exacto o
        redondeado a decena/centena (los casos realista_largo cotizan "3 cubetas
        × $X = $Y" y el total no existe como precio unitario en el catálogo).
    Se eligió redondeo (no ±%) por ser determinista y no abrir banda a precios
    arbitrarios cercanos. Limitación conocida: totales que SUMAN ítems distintos
    no se verifican aquí (los cubre el judge_rubric)."""
    if f"{amt:.2f}" in catalog_prices.get("exact", set()):
        return True
    for p in catalog_prices.get("values", []):
        if round(p) == amt or round(p / 10) * 10 == amt or round(p / 100) * 100 == amt:
            return True
        for n in range(2, 21):
            total = round(p * n, 2)
            if total == amt or round(total) == amt or round(total / 10) * 10 == amt \
                    or round(total / 100) * 100 == amt:
                return True
    return False


def _to_amount(raw: str) -> float | None:
    s = re.sub(r"[^\d.,]", "", raw or "")
    if not s:
        return None
    # quita separador de miles (coma) si hay punto decimal; si solo coma:
    # grupos de 3 dígitos ("1,010" / "12,500") = separador de miles, no decimal
    if "." in s and "," in s:
        s = s.replace(",", "")
    elif "," in s and "." not in s:
        if re.fullmatch(r"\d{1,3}(,\d{3})+", s):
            s = s.replace(",", "")
        else:
            s = s.replace(",", ".")
    try:
        return round(float(s), 2)
    except ValueError:
        return None


# ----------------------------------------------------------------------------
# Driver n8n + lectura de turns (Supabase PostgREST con service_role)
# ----------------------------------------------------------------------------
def _supa_get(env: dict, table: str, params: dict) -> list[dict]:
    import requests
    r = requests.get(
        f"{env['SUPABASE_URL']}/rest/v1/{table}",
        params=params,
        headers={
            "apikey": env["SERVICE_KEY"],
            "Authorization": f"Bearer {env['SERVICE_KEY']}",
            "Accept": "application/json",
        },
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def _count_assistant_turns(env: dict, phone: str,
                           tenant: str = TENANT) -> tuple[int, list[str]]:
    """(n_respuestas, lista_de_replies_en_orden) del asistente para ese phone.

    `tenant` permite leer bajo el tenant al que el caso enrutó (ej. el test de
    aislamiento multi-tenant escribe su turno bajo clinica_demo, no otro tenant)."""
    custs = _supa_get(env, "customers",
                      {"tenant_slug": f"eq.{tenant}", "phone": f"eq.{phone}",
                       "select": "id"})
    if not custs:
        return 0, []
    cid = custs[0]["id"]
    convs = _supa_get(env, "conversations",
                      {"customer_id": f"eq.{cid}", "select": "id",
                       "order": "started_at.desc", "limit": "1"})
    if not convs:
        return 0, []
    conv_id = convs[0]["id"]
    turns = _supa_get(env, "turns",
                      {"conversation_id": f"eq.{conv_id}", "role": "eq.assistant",
                       "select": "content,created_at", "order": "created_at.asc"})
    replies = [t["content"] for t in turns]
    return len(replies), replies


def send_turn(env: dict, phone: str, text: str, context: dict | None) -> None:
    import requests
    body = {"message": text, "phone": phone, "client_slug": TENANT}
    if context:
        # Forward-compatible: el workflow aún no lee now_iso; client_slug override SÍ
        # se respeta (nodo 2) y sirve para el test de aislamiento multi-tenant.
        if context.get("tenant_slug"):
            body["client_slug"] = context["tenant_slug"]
        if context.get("now_iso"):
            body["now_iso"] = context["now_iso"]
    # Un webhook colgado (n8n saturado / workflow auto-desactivado por rate-limit) NO debe
    # tumbar toda la corrida: se traga la excepción y el poll posterior marca timeout del caso.
    try:
        requests.post(env["WEBHOOK"], json=body, timeout=30)
    except requests.exceptions.RequestException:
        pass


def run_case(env: dict, case: dict, run_suffix: str) -> dict:
    digits = re.sub(r"\D", "", case["case_id"]) or "000"
    phone = f"test{digits}{run_suffix}"
    n_turns = len(case["turns"])
    read_tenant = (case.get("context") or {}).get("tenant_slug") or TENANT

    for idx, turn in enumerate(case["turns"], start=1):
        send_turn(env, phone, turn["text"], case.get("context"))
        # Espera a que aparezca la respuesta nro idx del asistente.
        deadline = time.time() + POLL_TIMEOUT_S
        while time.time() < deadline:
            n, _ = _count_assistant_turns(env, phone, read_tenant)
            if n >= idx:
                break
            time.sleep(POLL_INTERVAL_S)
        else:
            return {"case_id": case["case_id"], "error": f"timeout esperando turno {idx}",
                    "phone": phone}
        if idx < n_turns:
            time.sleep(TURN_GAP_S)

    _, replies = _count_assistant_turns(env, phone, read_tenant)
    return {"case_id": case["case_id"], "phone": phone, "replies": replies}


# ----------------------------------------------------------------------------
# Checks deterministas
# ----------------------------------------------------------------------------
def pick_reply(replies: list[str], checks: dict) -> str:
    if not replies:
        return ""
    idx = checks.get("check_turn_index")
    if idx is None:
        return replies[-1]
    return replies[idx] if 0 <= idx < len(replies) else replies[-1]


def run_checks(reply: str, checks: dict, catalog_prices: dict) -> list[dict]:
    """Devuelve lista de {name, pass, detail}."""
    out = []
    folded = fold(reply)

    for group in checks.get("must_contain_any", []):
        ok = any(rx(p).search(folded) for p in group)
        out.append({"name": "must_contain_any", "pass": ok,
                    "detail": ("ok" if ok else f"ninguno de {group} apareció")})

    for pat in checks.get("must_not_match", []):
        bad = bool(rx(pat).search(folded))
        out.append({"name": "must_not_match", "pass": not bad,
                    "detail": ("ok" if not bad else f"prohibido apareció: «{pat}»")})

    if checks.get("price_grounded") and catalog_prices:
        invented = []
        for m in re.finditer(r"\$\s?[\d.,]+", reply):
            # montos precedidos por "Total:"/"subtotal" son aritmética sobre ítems
            # ya verificados (sumas multi-ítem no se reconstruyen aquí); se eximen.
            prefix = fold(reply[max(0, m.start() - 18):m.start()])
            if re.search(r"(sub)?total\s*:?\s*$", prefix):
                continue
            amt = _to_amount(m.group(0))
            if amt is not None and not _price_in_catalog(amt, catalog_prices):
                invented.append(m.group(0).strip())
        ok = not invented
        out.append({"name": "price_grounded", "pass": ok,
                    "detail": ("ok" if ok else f"precio(s) fuera de catálogo: {invented}")})

    if "expect_escalation" in checks:
        escalated = detect_escalation(folded)
        want = checks["expect_escalation"]
        ok = escalated == want
        out.append({"name": "expect_escalation", "pass": ok,
                    "detail": ("ok" if ok else
                               f"esperaba escalamiento={want}, detectado={escalated}")})
    return out


def run_turn_checks(replies: list[str], specs: list[dict] | None,
                    catalog_prices: dict) -> list[dict]:
    """Aplica checks deterministas a respuestas INDIVIDUALES por índice de turno.

    Cada spec es {turn_index, checks:{...}} y permite asertar turnos intermedios
    (ej. 'en el turno 0 el agente NO dio precio porque le falta info') además de la
    respuesta final que evalúa `checks`/pick_reply. Reusa run_checks sin cambios;
    sólo etiqueta el nombre con @t<idx> para que el reporte muestre qué turno falló."""
    out: list[dict] = []
    for spec in (specs or []):
        idx = spec.get("turn_index", 0)
        sub = spec.get("checks", {})
        if idx < 0 or idx >= len(replies):
            out.append({"name": f"checks_by_turn@t{idx}", "pass": False,
                        "detail": f"no hubo respuesta del asistente en el turno {idx}"})
            continue
        for c in run_checks(replies[idx], sub, catalog_prices):
            c["name"] = f"{c['name']}@t{idx}"
            out.append(c)
    return out


# ----------------------------------------------------------------------------
# LLM-as-judge
# ----------------------------------------------------------------------------
# Anti-alucinación del juez (sesión 2026-06-10): el juez barato emitía ~5
# veredictos falsos por corrida acusando al agente de omisiones que SÍ estaban
# en el transcript (ej. CONV050, ESC012, CONV078). Mitigación en 3 capas:
#   1. El JSON de veredicto exige `evidence_quote`: cita TEXTUAL del transcript,
#      obligatoria si verdict ≠ PASS.
#   2. Post-parse: si la cita no aparece en el transcript (matching tolerante a
#      acentos/mayúsculas/espacios), se re-juzga UNA vez con JUDGE_MODEL_STRONG.
#   3. Si el fuerte tampoco da cita verificable → verdict ERROR
#      ("cita no verificable"). PASS nunca escala.

VALID_VERDICTS = ("PASS", "PARTIAL", "FAIL")


def parse_judge_json(text: str) -> dict:
    """Extrae el primer objeto JSON con clave `verdict` del texto del juez.

    Tolera prosa alrededor, fences de markdown y objetos anidados (usa
    raw_decode balanceado, no regex codiciosa). Sin JSON parseable →
    verdict FAIL con reason "sin JSON". Verdict fuera del enum → FAIL.
    Pura y determinista: testeable offline.
    """
    dec = json.JSONDecoder()
    data = None
    for m in re.finditer(r"\{", text or ""):
        try:
            candidate, _ = dec.raw_decode(text[m.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and "verdict" in candidate:
            data = candidate
            break
    if data is None:
        return {"verdict": "FAIL", "reason": "sin JSON", "evidence_quote": ""}
    v = str(data.get("verdict", "FAIL")).upper().strip()
    if v not in VALID_VERDICTS:
        v = "FAIL"
    return {
        "verdict": v,
        "reason": str(data.get("reason", "") or ""),
        "evidence_quote": str(data.get("evidence_quote", "") or ""),
    }


def quote_in_transcript(quote: str, transcript: str) -> bool:
    """¿La cita del juez existe textualmente en el transcript?

    Matching tolerante: minúsculas, sin acentos (fold) y espacios/saltos
    colapsados a un espacio. Cita vacía → False (FAIL/PARTIAL sin evidencia
    no es verificable). Pura y determinista: testeable offline.
    """
    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", fold(s)).strip()
    q = norm(quote)
    return bool(q) and q in norm(transcript)


def adjudicate(call_judge, transcript_text: str,
               judge_model: str, judge_model_strong: str) -> dict:
    """Veredicto con verificación de evidencia y escalada única.

    `call_judge(model) -> str` es inyectable (texto crudo del juez) para
    poder mockearlo en tests sin tocar la API. Reglas:
    - PASS nunca escala.
    - FAIL/PARTIAL con cita verificable en transcript → se acepta.
    - FAIL/PARTIAL con cita NO verificable → re-juzgar UNA vez con el modelo
      fuerte; si este da PASS o cita verificable se acepta su veredicto;
      si tampoco da cita verificable → ERROR "cita no verificable".
    """
    data = parse_judge_json(call_judge(judge_model))
    if data["verdict"] == "PASS":
        return data
    if quote_in_transcript(data["evidence_quote"], transcript_text):
        return data
    data2 = parse_judge_json(call_judge(judge_model_strong))
    data2["escalated"] = True
    if data2["verdict"] == "PASS":
        return data2
    if quote_in_transcript(data2["evidence_quote"], transcript_text):
        return data2
    return {"verdict": "ERROR", "reason": "cita no verificable",
            "evidence_quote": data2["evidence_quote"], "escalated": True}


def judge_case(env: dict, case: dict, reply: str,
               transcript: list[dict] | None = None) -> dict | None:
    rubric = case.get("judge_rubric")
    if not rubric:
        return None
    from anthropic import Anthropic
    client = Anthropic(api_key=env["ANTHROPIC_API_KEY"])
    # En hilos largos el juez DEBE ver toda la conversación (cliente + agente), no solo
    # la respuesta final: si no, no puede juzgar coherencia, memoria, ni si preguntó
    # antes de actuar en un turno intermedio.
    if transcript:
        convo = "\n".join(
            f"{'CLIENTE' if t.get('role') == 'user' else 'AGENTE'}: {t.get('content','')}"
            for t in transcript)
        eval_block = (f"CONVERSACIÓN COMPLETA (cliente + agente, en orden):\n{convo}\n\n"
                      "Evalúa el desempeño del AGENTE a lo largo de TODA la conversación "
                      "según la rúbrica (coherencia, memoria, manejo de objeción, política).\n\n")
        transcript_text = convo
    else:
        user_turns = "\n".join(f"- {t['text']}" for t in case["turns"])
        eval_block = (f"MENSAJES del cliente:\n{user_turns}\n\n"
                      f"RESPUESTA del agente a evaluar:\n«{reply}»\n\n")
        transcript_text = f"{user_turns}\n{reply}"
    prompt = (
        "Eres un evaluador estricto de un agente de ventas por WhatsApp de una "
        "PyME comercial (español de México). Juzga SOLO según la rúbrica.\n\n"
        "IMPORTANTE: el agente consulta un catálogo y herramientas REALES. La "
        "veracidad de SKUs, precios y existencias se valida con un check determinista "
        "APARTE (no es tu trabajo). NO acuses al agente de inventar por citar un SKU, "
        "precio o especificación concreta: asume que vino de su catálogo salvo que la "
        "rúbrica diga explícitamente lo contrario. Evalúa SOLO tono, pertinencia, "
        "lógica, manejo de objeción y cumplimiento de política.\n\n"
        f"PERSONA del cliente: {case['persona_id']}\n"
        + eval_block +
        f"RÚBRICA: {rubric}\n\n"
        "Responde SOLO con un JSON: {\"verdict\": \"PASS|PARTIAL|FAIL\", "
        "\"reason\": \"una frase\", \"evidence_quote\": \"cita textual del "
        "transcript\"}.\n"
        "REGLA DE EVIDENCIA: si tu veredicto es FAIL o PARTIAL, `evidence_quote` "
        "es OBLIGATORIA y debe ser una cita TEXTUAL copiada del transcript "
        "(exacta, sin parafrasear ni resumir) que demuestra el problema. Antes "
        "de emitir FAIL/PARTIAL, copia la cita exacta del transcript que lo "
        "demuestra; si no puedes citarla, el veredicto es PASS. Con PASS, "
        "`evidence_quote` puede ir vacía."
    )

    def call_judge(model: str) -> str:
        msg = client.messages.create(
            model=model, max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")

    try:
        return adjudicate(call_judge, transcript_text,
                          env["JUDGE_MODEL"], env["JUDGE_MODEL_STRONG"])
    except Exception as e:  # noqa: BLE001
        return {"verdict": "ERROR", "reason": str(e)[:120]}


# ----------------------------------------------------------------------------
# Orquestación + reporte
# ----------------------------------------------------------------------------
def evaluate(env: dict, cases: list[dict], use_judge: bool,
             catalog_prices: set[str], run_suffix: str) -> list[dict]:
    results = []
    for i, case in enumerate(cases, 1):
        print(f"  [{i}/{len(cases)}] {case['case_id']} "
              f"({case['category']}/{case['subcategory']})…", file=sys.stderr)
        conv = run_case(env, case, run_suffix)
        # Reintento ante timeout: el stack n8n/Anthropic puede saturarse en corridas
        # largas; un timeout transitorio no es un fallo del agente.
        attempt = 0
        while conv.get("error") and attempt < TIMEOUT_RETRIES:
            attempt += 1
            print(f"      timeout; reintento {attempt} tras {RETRY_BACKOFF_S:.0f}s…",
                  file=sys.stderr)
            time.sleep(RETRY_BACKOFF_S)
            conv = run_case(env, case, f"{run_suffix}r{attempt}")
        time.sleep(CASE_GAP_S)
        if conv.get("error"):
            results.append({**_case_meta(case), "status": "error",
                            "error": conv["error"], "reply": "", "checks": [],
                            "judge": None, "passed": False})
            continue
        reply = pick_reply(conv["replies"], case["checks"])
        checks = run_checks(reply, case["checks"], catalog_prices)
        checks += run_turn_checks(conv["replies"], case.get("checks_by_turn"),
                                  catalog_prices)
        det_pass = all(c["pass"] for c in checks)
        # El juez DEBE ver la conversación completa en multiturno (fix 2026-06-09;
        # antes solo recibía la respuesta final y acusaba "escaló sin preguntar"
        # cuando la pregunta vivía en un turno intermedio — triaje 06-05 §3).
        # Se reconstruye intercalando turnos del caso con las replies del agente.
        transcript = []
        for t_idx, t in enumerate(case["turns"]):
            transcript.append({"role": "user", "content": t["text"]})
            if t_idx < len(conv["replies"]):
                transcript.append({"role": "assistant",
                                   "content": conv["replies"][t_idx]})
        judge = (judge_case(env, case, reply,
                            transcript=transcript if len(transcript) > 2 else None)
                 if use_judge else None)
        judge_fail = bool(judge and judge["verdict"] in ("FAIL", "ERROR"))
        results.append({
            **_case_meta(case),
            "status": "ok",
            "reply": reply,
            "checks": checks,
            "judge": judge,
            "passed": det_pass and not judge_fail,
        })
    return results


def _case_meta(case: dict) -> dict:
    return {"case_id": case["case_id"], "category": case["category"],
            "subcategory": case["subcategory"], "persona_id": case["persona_id"],
            "difficulty": case["difficulty"]}


def aggregate(results: list[dict]) -> dict:
    def rate(items):
        n = len(items)
        p = sum(1 for r in items if r["passed"])
        return {"pass": p, "total": n, "rate": (p / n if n else 0.0)}

    by_cat: dict[str, list] = {}
    by_sub: dict[str, list] = {}
    by_persona: dict[str, list] = {}
    for r in results:
        by_cat.setdefault(r["category"], []).append(r)
        by_sub.setdefault(r["subcategory"], []).append(r)
        by_persona.setdefault(r["persona_id"], []).append(r)
    return {
        "overall": rate(results),
        "by_category": {k: rate(v) for k, v in sorted(by_cat.items())},
        "by_subcategory": {k: rate(v) for k, v in sorted(by_sub.items())},
        "by_persona": {k: rate(v) for k, v in sorted(by_persona.items())},
        "failures": [r for r in results if not r["passed"]],
    }


def print_report(results: list[dict]) -> None:
    agg = aggregate(results)
    print("\n" + "=" * 78)
    print("  EVAL CONVERSACIONAL — agente de ventas (tenant demo)")
    print("=" * 78)
    o = agg["overall"]
    print(f"\n  PASS GLOBAL: {o['pass']}/{o['total']}  ({o['rate']:.1%})")

    print("\n  Por categoría:")
    for k, v in agg["by_category"].items():
        print(f"    {k:<14} {v['pass']}/{v['total']}  ({v['rate']:.0%})")
    print("\n  Por subcategoría:")
    for k, v in agg["by_subcategory"].items():
        print(f"    {k:<18} {v['pass']}/{v['total']}  ({v['rate']:.0%})")
    print("\n  Por persona:")
    for k, v in agg["by_persona"].items():
        print(f"    {k:<36} {v['pass']}/{v['total']}  ({v['rate']:.0%})")

    print("\n  FALLOS:")
    if not agg["failures"]:
        print("    (ninguno) 🎉")
    for r in agg["failures"]:
        print(f"\n    {r['case_id']} [{r['category']}/{r['subcategory']}] "
              f"persona={r['persona_id']}")
        if r["status"] == "error":
            print(f"        ERROR: {r['error']}")
            continue
        for c in r["checks"]:
            if not c["pass"]:
                print(f"        ✗ {c['name']}: {c['detail']}")
        if r["judge"] and r["judge"]["verdict"] in ("FAIL", "ERROR"):
            print(f"        ✗ judge[{r['judge']['verdict']}]: {r['judge']['reason']}")
        print(f"        reply: «{r['reply'][:140]}»")
    print("\n" + "=" * 78 + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-judge", action="store_true", help="Salta el LLM-as-judge.")
    ap.add_argument("--category", help="Filtra por categoría.")
    ap.add_argument("--subcategory", help="Filtra por subcategoría.")
    ap.add_argument("--case", help="Corre un solo case_id.")
    ap.add_argument("--limit", type=int, help="Máximo de casos a correr.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Valida dataset + imprime payloads, sin tocar la red.")
    ap.add_argument("--json", action="store_true", help="Payload JSON crudo a stdout.")
    args = ap.parse_args()

    cases = load_dataset()
    validate_schema(cases)

    if args.category:
        cases = [c for c in cases if c["category"] == args.category]
    if args.subcategory:
        cases = [c for c in cases if c["subcategory"] == args.subcategory]
    if args.case:
        cases = [c for c in cases if c["case_id"] == args.case]
    if args.limit:
        cases = cases[:args.limit]
    if not cases:
        sys.exit("❌ Ningún caso tras aplicar filtros.")

    if args.dry_run:
        print(f"DRY-RUN — {len(cases)} casos. Payloads sintéticos que se enviarían:",
              file=sys.stderr)
        for c in cases:
            for t in c["turns"]:
                print(json.dumps({"message": t["text"], "phone": f"test{c['case_id']}",
                                  "client_slug": TENANT}, ensure_ascii=False))
        return 0

    env = load_env_or_die(need_judge=not args.no_judge)
    # Sufijo de corrida (phone único por caso); time es válido aquí (script normal).
    run_suffix = str(int(time.time()))[-6:]
    print(f"📋 {len(cases)} casos · webhook={env['WEBHOOK']} · "
          f"judge={'off' if args.no_judge else env['JUDGE_MODEL']}", file=sys.stderr)

    results = evaluate(env, cases, use_judge=not args.no_judge,
                       catalog_prices=load_catalog_prices(), run_suffix=run_suffix)

    if args.json:
        print(json.dumps({"results": results, "aggregate": aggregate(results)},
                         ensure_ascii=False, indent=2, default=str))
    else:
        print_report(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
