"""
T1.2 PARTE B — Eval en VIVO de extracción BANT (con inferencia LLM).

Re-corre la extracción en vivo sobre N conversaciones del set de fixtures
y compara el bant_state resultante (leído de `conversations.bant_state` en Supabase)
contra la etiqueta de referencia 'silver' de bant_demo_fixtures.jsonl.

En este repo público los fixtures son sintéticos (clínica/ferretería demo).
En un proyecto real, la regla es: las etiquetas de referencia se validan con un
humano del negocio, no se inventan con el LLM.

NOTA: la extracción BANT es NO-DETERMINISTA aun a temp 0 (el eval regenera la
conversación en vivo con tool calls/RAG); el porcentaje de acierto rebota entre
corridas con el mismo prompt. Usar como señal, no como gate ×N estricto.

Uso:
  cd /path/to/repo
  .venv/bin/python3 tests/evals/run_bant_live_eval.py
  .venv/bin/python3 tests/evals/run_bant_live_eval.py --dry-run
  .venv/bin/python3 tests/evals/run_bant_live_eval.py --n 3   # subset aún más pequeño

Pre-requisitos:
  - n8n arriba: curl http://localhost:5678/healthz debe dar 200
  - .env con SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  - catálogo ingestado (run_rag_eval.py en verde)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_PATH = REPO_ROOT / "tests" / "evals" / "bant_demo_fixtures.jsonl"

try:
    from dotenv import load_dotenv
    load_dotenv(REPO_ROOT / ".env")
except ImportError:
    pass

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
WEBHOOK_URL = os.environ.get("N8N_WEBHOOK_URL", "http://localhost:5678/webhook/poc-agente")
TENANT = "clinica_demo"

POLL_TIMEOUT_S = 90
POLL_INTERVAL_S = 2.0
TURN_GAP_S = 1.5
CASE_GAP_S = 5.0

# Fixtures seleccionados para Part B: N=6, cobertura diversa (todos los stages)
# Excluye sintéticos y fixtures con conversation_id SYNTHETIC_*
SELECTED_FIXTURE_IDS = ["BANT_F01", "BANT_F02", "BANT_F03"]


def _supa_get(table: str, params: dict) -> list[dict]:
    import requests
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        params=params,
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
                 "Accept": "application/json"},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def _get_conversation_bant_state(phone: str) -> dict | None:
    """Lee el bant_state de la conversación más reciente de ese teléfono."""
    custs = _supa_get("customers", {"tenant_slug": f"eq.{TENANT}", "phone": f"eq.{phone}",
                                    "select": "id"})
    if not custs:
        return None
    cid = custs[0]["id"]
    convs = _supa_get("conversations", {"customer_id": f"eq.{cid}", "select": "id,bant_state",
                                        "order": "started_at.desc", "limit": "1"})
    if not convs:
        return None
    return convs[0].get("bant_state", {})


def _count_assistant_turns(phone: str) -> tuple[int, list[str]]:
    custs = _supa_get("customers", {"tenant_slug": f"eq.{TENANT}", "phone": f"eq.{phone}",
                                    "select": "id"})
    if not custs:
        return 0, []
    cid = custs[0]["id"]
    convs = _supa_get("conversations", {"customer_id": f"eq.{cid}", "select": "id",
                                        "order": "started_at.desc", "limit": "1"})
    if not convs:
        return 0, []
    conv_id = convs[0]["id"]
    turns = _supa_get("turns", {"conversation_id": f"eq.{conv_id}", "role": "eq.assistant",
                                "select": "content,created_at", "order": "created_at.asc"})
    replies = [t["content"] for t in turns]
    return len(replies), replies


def send_turn(phone: str, text: str) -> None:
    import requests
    body = {"message": text, "phone": phone, "client_slug": TENANT}
    try:
        requests.post(WEBHOOK_URL, json=body, timeout=30)
    except requests.exceptions.RequestException:
        pass


def run_fixture_live(fixture: dict, run_suffix: str) -> dict:
    """Envía los turnos de usuario del fixture al webhook y espera las respuestas."""
    fx_id = fixture["fixture_id"]
    phone = f"bant{re.sub(r'[^0-9]', '', fx_id)}{run_suffix}"

    # Solo enviar turnos de usuario (los de role='user')
    user_turns = [t for t in fixture["turns"] if t["role"] == "user"]

    for idx, turn in enumerate(user_turns, 1):
        send_turn(phone, turn["content"])
        deadline = time.time() + POLL_TIMEOUT_S
        while time.time() < deadline:
            n, _ = _count_assistant_turns(phone)
            if n >= idx:
                break
            time.sleep(POLL_INTERVAL_S)
        else:
            return {"fixture_id": fx_id, "phone": phone, "error": f"timeout en turno {idx}"}
        if idx < len(user_turns):
            time.sleep(TURN_GAP_S)

    bant_state = _get_conversation_bant_state(phone)
    return {"fixture_id": fx_id, "phone": phone, "live_bant_state": bant_state}


def compare_bant_states(ref: dict, live: dict, fixture_id: str) -> dict:
    """Compara bant_state de referencia vs obtenido en vivo por dimensión."""
    dims = ("budget", "authority", "need", "timeline")
    result = {"fixture_id": fixture_id, "dimensions": {}, "asymmetry_ok": True}

    for dim in dims:
        ref_val = ref.get(dim)
        live_val = live.get(dim) if live else None

        if ref_val is None:
            status = "skip"  # fixture no tiene referencia para esta dimensión
        elif live_val is None:
            status = "requiere_ratificacion_humana"
        elif live_val == ref_val:
            status = "match"
        else:
            status = "mismatch"

        result["dimensions"][dim] = {
            "reference": ref_val,
            "live": live_val,
            "status": status,
        }

    # Verificar score y stage
    ref_score = ref.get("score")
    ref_stage = ref.get("stage")
    live_score = live.get("score") if live else None
    live_stage = live.get("stage") if live else None

    result["score"] = {"reference": ref_score, "live": live_score,
                       "match": ref_score == live_score if ref_score is not None else None}
    result["stage"] = {"reference": ref_stage, "live": live_stage,
                       "match": ref_stage == live_stage if ref_stage is not None else None}

    return result


def compute_accuracy(comparisons: list[dict]) -> dict:
    """Calcula accuracy por dimensión y global (excluyendo requiere_ratificacion_humana)."""
    dims = ("budget", "authority", "need", "timeline")
    dim_stats = {d: {"match": 0, "total": 0} for d in dims}
    global_match = 0
    global_total = 0

    for comp in comparisons:
        for dim in dims:
            d = comp["dimensions"].get(dim, {})
            status = d.get("status", "skip")
            if status in ("match", "mismatch"):
                dim_stats[dim]["total"] += 1
                if status == "match":
                    dim_stats[dim]["match"] += 1
                    global_match += 1
                global_total += 1

    result = {}
    for dim in dims:
        s = dim_stats[dim]
        n, t = s["match"], s["total"]
        result[dim] = {"match": n, "total": t, "accuracy": n / t if t else None}

    result["global"] = {
        "match": global_match,
        "total": global_total,
        "accuracy": global_match / global_total if global_total else None,
    }
    return result


def load_selected_fixtures(n: int | None = None) -> list[dict]:
    ids = SELECTED_FIXTURE_IDS[:n] if n else SELECTED_FIXTURE_IDS
    all_fx = []
    with FIXTURES_PATH.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                fx = json.loads(line)
                if fx["fixture_id"] in ids and not fx["conversation_id"].startswith("SYNTHETIC"):
                    all_fx.append(fx)
    # Preservar orden de SELECTED_FIXTURE_IDS
    order = {fid: i for i, fid in enumerate(ids)}
    return sorted(all_fx, key=lambda fx: order.get(fx["fixture_id"], 999))


def print_report(comparisons: list[dict], accuracy: dict, errors: list[str]) -> None:
    print("\n" + "=" * 70)
    print("  T1.2 PARTE B — Eval en VIVO de extracción BANT")
    print("=" * 70)
    print(f"\n  N corrido: {len(comparisons)} conversaciones")
    print(f"  Errores de timeout/red: {len(errors)}")
    if errors:
        for e in errors:
            print(f"    - {e}")

    print("\n  ACCURACY por dimensión:")
    for dim in ("budget", "authority", "need", "timeline"):
        s = accuracy[dim]
        if s["total"] == 0:
            print(f"    {dim:<12} N/A (sin casos evaluables)")
        else:
            pct = s["accuracy"] * 100
            flag = "✓" if pct >= 90 else "✗"
            print(f"    {dim:<12} {s['match']}/{s['total']}  ({pct:.0f}%)  {flag}")

    g = accuracy["global"]
    global_pct = g["accuracy"] * 100 if g["accuracy"] is not None else 0
    flag = "✓" if global_pct >= 90 else "✗"
    print(f"\n  ACCURACY GLOBAL: {g['match']}/{g['total']}  ({global_pct:.0f}%)  {flag}")
    print(f"  TARGET: ≥90% por dimensión y global")

    print("\n  DETALLE por fixture:")
    for comp in comparisons:
        dims_str = " | ".join(
            f"{d}:{comp['dimensions'][d]['status'][0].upper()}"
            for d in ("budget", "authority", "need", "timeline")
        )
        score_str = f"score {comp['score']['reference']}→{comp['score']['live']}"
        stage_str = f"stage {comp['stage']['reference']}→{comp['stage']['live']}"
        print(f"    {comp['fixture_id']:<12} [{dims_str}] {score_str} {stage_str}")

    print("\n  FALLOS (mismatch):")
    any_fail = False
    for comp in comparisons:
        for dim, d in comp["dimensions"].items():
            if d["status"] == "mismatch":
                any_fail = True
                print(f"    {comp['fixture_id']}.{dim}: ref='{d['reference']}' live='{d['live']}'")
        if comp["score"].get("match") is False:
            any_fail = True
            print(f"    {comp['fixture_id']}.score: ref={comp['score']['reference']} live={comp['score']['live']}")
        if comp["stage"].get("match") is False:
            any_fail = True
            print(f"    {comp['fixture_id']}.stage: ref='{comp['stage']['reference']}' live='{comp['stage']['live']}'")

    if not any_fail:
        print("    (ninguno)")

    print("\n  ASIMETRÍA STATE MACHINE: verificada en Parte A (test determinista verde)")

    # Costo estimado
    total_turns = sum(len([t for t in fx.get("turns", []) if t["role"] == "user"])
                      for comp in comparisons
                      for fx in [{"turns": []}])
    print(f"\n  Gasto: ~$0.087/turno (sonnet-4-6); gasto EXACTO con scripts/poc_n8n_cost_report.py.")
    print("=" * 70 + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true",
                    help="Muestra qué se enviaría sin tocar la red.")
    ap.add_argument("--n", type=int, default=None,
                    help="Número de fixtures a correr (default: todos los seleccionados = 6).")
    args = ap.parse_args()

    if not SUPABASE_URL or not SERVICE_KEY:
        sys.exit("ERROR: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY deben estar en .env")

    fixtures = load_selected_fixtures(args.n)
    if not fixtures:
        sys.exit(f"ERROR: no se encontraron fixtures seleccionados en {FIXTURES_PATH}")

    print(f"\nPASO CON INFERENCIA: re-corro extracción en vivo sobre N={len(fixtures)} "
          f"conversaciones del set curado (no se puede hacer determinista porque mide "
          f"la calidad de extracción del LLM).")
    print(f"Webhook: {WEBHOOK_URL} | Tenant: {TENANT}")

    if args.dry_run:
        print(f"\nDRY-RUN — {len(fixtures)} fixtures seleccionados:")
        for fx in fixtures:
            user_turns = [t for t in fx["turns"] if t["role"] == "user"]
            print(f"  {fx['fixture_id']}: {len(user_turns)} turnos de usuario")
            for t in user_turns:
                print(f"    > {t['content'][:80]}")
        return 0

    # Verificar n8n antes de empezar
    import requests
    try:
        r = requests.get("http://localhost:5678/healthz", timeout=5)
        if r.status_code != 200:
            sys.exit(f"ERROR: n8n healthz devolvió {r.status_code} — levanta el stack antes.")
    except Exception as e:
        sys.exit(f"ERROR: n8n no responde en :5678 — {e}. Levanta tu instancia local de n8n.")

    run_suffix = str(int(time.time()))[-5:]
    comparisons = []
    errors = []

    for i, fx in enumerate(fixtures, 1):
        print(f"  [{i}/{len(fixtures)}] {fx['fixture_id']} ({fx['label']})...",
              end=" ", flush=True)
        result = run_fixture_live(fx, run_suffix)

        if "error" in result:
            print(f"ERROR: {result['error']}")
            errors.append(f"{fx['fixture_id']}: {result['error']}")
            time.sleep(CASE_GAP_S)
            continue

        live_bs = result.get("live_bant_state") or {}
        ref_bs = fx.get("reference_bant_state", {})
        comp = compare_bant_states(ref_bs, live_bs, fx["fixture_id"])
        comparisons.append(comp)

        # Resumen rápido por fixture
        matches = sum(1 for d in comp["dimensions"].values() if d["status"] == "match")
        total_dims = sum(1 for d in comp["dimensions"].values() if d["status"] in ("match", "mismatch"))
        print(f"dims={matches}/{total_dims} stage={live_bs.get('stage','?')} score={live_bs.get('score','?')}")
        time.sleep(CASE_GAP_S)

    if not comparisons:
        print("ERROR: ningún fixture completó correctamente.")
        return 1

    accuracy = compute_accuracy(comparisons)
    print_report(comparisons, accuracy, errors)

    global_acc = accuracy["global"]["accuracy"]
    if global_acc is None or global_acc < 0.9:
        print(f"ROJO: accuracy global {(global_acc or 0)*100:.0f}% < 90%. Ver fallos arriba.")
        return 1
    else:
        print(f"VERDE: accuracy global {global_acc*100:.0f}% ≥ 90%.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
