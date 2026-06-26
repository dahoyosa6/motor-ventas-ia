#!/usr/bin/env python3
"""Corre la suite de evals capturando la CONVERSACION COMPLETA (cliente + agente)
de cada caso desde la tabla `turns`, además de checks/juez/latencia. Genera:
  - docs/pruebas/pruebas_agente_conversaciones_completas_2026-06-05.md  (transcripts completos)
  - tests/evals/results/iter3_full_<suffix>.json                (resultados crudos)
  - imprime un bloque de KPIs (% aciertos por categoría, errores, latencia) a stdout.

Reusa run_agent_eval.py (driver n8n + checks + judge). Pensado para correr la suite
completa (58 casos) post-sync de iteración 2, y comparar contra el baseline 2026-06-04.

Uso:  .venv/bin/python3 tests/evals/run_eval_with_transcripts.py [--no-judge] [--category X]
"""
from __future__ import annotations
import argparse, json, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_agent_eval as R  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
DOC = REPO / "docs" / "pruebas" / "pruebas_agente_conversaciones_completas_2026-06-05.md"
RESULTS_DIR = REPO / "tests" / "evals" / "results"

# ids de la iteración 3 (set realista nuevo) para separar el reporte vs los 42 originales
ITER3_IDS = {f"CONV{n:03d}" for n in range(31, 44)} | {"ESC013", "ESC014", "ESC015"}
INTER_CASE_GAP_S = 6.0  # extra entre casos para no gatillar rate-limit/auto-desactivacion


def fetch_transcript(env, phone, tenant):
    custs = R._supa_get(env, "customers",
                        {"tenant_slug": f"eq.{tenant}", "phone": f"eq.{phone}", "select": "id"})
    if not custs:
        return []
    cid = custs[0]["id"]
    convs = R._supa_get(env, "conversations",
                        {"customer_id": f"eq.{cid}", "select": "id",
                         "order": "started_at.desc", "limit": "1"})
    if not convs:
        return []
    conv = convs[0]["id"]
    return R._supa_get(env, "turns",
                       {"conversation_id": f"eq.{conv}",
                        "select": "role,content,latency_ms,created_at",
                        "order": "created_at.asc"})


def pct(p, n):
    return f"{p}/{n} ({(p/n*100 if n else 0):.1f}%)"


def percentile(xs, q):
    if not xs:
        return None
    s = sorted(xs)
    i = min(len(s) - 1, int(round((q / 100) * (len(s) - 1))))
    return s[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--category")
    ap.add_argument("--cases", help="Lista de case_id separada por comas (filtro exacto).")
    ap.add_argument("--out", help="Ruta del .md de transcripts (default: el de la suite completa).")
    ap.add_argument("--turn-gap", type=float,
                    help="Segundos entre turnos del mismo caso (sube esto para no gatillar rate-limit).")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()
    global DOC
    if args.out:
        DOC = Path(args.out)
    if args.turn_gap:
        R.TURN_GAP_S = args.turn_gap

    env = R.load_env_or_die(need_judge=not args.no_judge)
    cases = R.load_dataset()
    R.validate_schema(cases)
    if args.category:
        cases = [c for c in cases if c["category"] == args.category]
    if args.cases:
        wanted = {x.strip() for x in args.cases.split(",")}
        cases = [c for c in cases if c["case_id"] in wanted]
    if args.limit:
        cases = cases[:args.limit]
    catalog_prices = R.load_catalog_prices()
    suffix = str(int(time.time()))[-6:]
    use_judge = not args.no_judge

    results = []
    latencies = []
    print(f"== {len(cases)} casos · judge={'off' if not use_judge else env['JUDGE_MODEL']} ==",
          file=sys.stderr)
    for i, case in enumerate(cases, 1):
        cid = case["case_id"]
        read_tenant = (case.get("context") or {}).get("tenant_slug") or R.TENANT
        print(f"  [{i}/{len(cases)}] {cid} ({case['category']}/{case['subcategory']})…",
              file=sys.stderr)
        conv = R.run_case(env, case, suffix)
        time.sleep(R.CASE_GAP_S)
        if conv.get("error"):
            results.append({"case": case, "status": "error", "error": conv["error"],
                            "transcript": [], "checks": [], "judge": None, "passed": False})
            time.sleep(INTER_CASE_GAP_S)
            continue
        transcript = fetch_transcript(env, conv["phone"], read_tenant)
        for t in transcript:
            if t["role"] == "assistant" and t.get("latency_ms"):
                latencies.append(t["latency_ms"])
        reply = R.pick_reply(conv["replies"], case["checks"])
        checks = R.run_checks(reply, case["checks"], catalog_prices)
        checks += R.run_turn_checks(conv["replies"], case.get("checks_by_turn"), catalog_prices)
        det_pass = all(c["pass"] for c in checks)
        judge = R.judge_case(env, case, reply, transcript=transcript) if use_judge else None
        judge_fail = bool(judge and judge["verdict"] in ("FAIL", "ERROR"))
        results.append({"case": case, "status": "ok", "transcript": transcript,
                        "reply": reply, "checks": checks, "judge": judge,
                        "passed": det_pass and not judge_fail})
        time.sleep(INTER_CASE_GAP_S)

    # ---- persistir crudo ----
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    raw = RESULTS_DIR / f"iter3_full_{suffix}.json"
    raw.write_text(json.dumps(
        [{"case_id": r["case"]["case_id"], "category": r["case"]["category"],
          "subcategory": r["case"]["subcategory"], "persona": r["case"]["persona_id"],
          "status": r["status"], "passed": r["passed"],
          "transcript": r["transcript"], "checks": r.get("checks"),
          "judge": r.get("judge"), "error": r.get("error")} for r in results],
        ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    # ---- documento de transcripts completos ----
    lines = []
    lines.append("# Pruebas del agente — conversaciones completas (2026-06-05)\n")
    lines.append("> Transcripts COMPLETOS (cliente + agente) de cada caso del harness, corridos en vivo "
                 "contra el agente real (n8n) tras sincronizar la iteración 2. No resumidos.\n")
    lines.append(f"> Suffix de corrida: `{suffix}` · casos: {len(results)} · "
                 f"juez: {'off' if not use_judge else env['JUDGE_MODEL']}\n")
    lines.append("> Fuente: tabla `turns` (Supabase). Verdict = checks deterministas + LLM-judge.\n")
    for r in results:
        c = r["case"]
        mark = "✅ PASS" if r["passed"] else "❌ FAIL"
        lines.append(f"\n---\n\n## {c['case_id']} · {c['category']}/{c['subcategory']} · "
                     f"{c['persona_id']} · {c['difficulty']} — {mark}\n")
        if r["status"] == "error":
            lines.append(f"**ERROR de infraestructura:** {r['error']} (timeout/rate-limit; no es fallo "
                         "de contenido del agente).\n")
            continue
        lines.append("**Conversación:**\n")
        for t in r["transcript"]:
            who = "🧑 Cliente" if t["role"] == "user" else "🤖 Agente"
            lat = f"  _({t['latency_ms']/1000:.1f}s)_" if t.get("latency_ms") and t["role"] == "assistant" else ""
            content = (t["content"] or "").replace("\n", "\n> ")
            lines.append(f"> **{who}:** {content}{lat}\n")
        # checks
        failed = [c2 for c2 in r["checks"] if not c2["pass"]]
        if failed:
            lines.append("\n**Checks fallidos:**\n")
            for c2 in failed:
                lines.append(f"- ✗ `{c2['name']}`: {c2['detail']}\n")
        else:
            lines.append("\n_Checks deterministas: todos OK._\n")
        if r["judge"]:
            lines.append(f"\n**Juez:** {r['judge']['verdict']} — {r['judge']['reason']}\n")
    DOC.write_text("".join(lines), encoding="utf-8")

    # ---- KPIs ----
    def rate(subset):
        n = len(subset); p = sum(1 for r in subset if r["passed"]); return p, n
    orig = [r for r in results if r["case"]["case_id"] not in ITER3_IDS]
    new = [r for r in results if r["case"]["case_id"] in ITER3_IDS]
    cats = {}
    for r in results:
        cats.setdefault(r["case"]["category"], []).append(r)
    errs = [r for r in results if not r["passed"]]
    infra = [r for r in errs if r["status"] == "error"]

    print("\n" + "=" * 70)
    print("  KPIs — corrida post-iteración 2")
    print("=" * 70)
    p, n = rate(results); print(f"\n  % ACIERTOS (full {n}):        {pct(p,n)}")
    p, n = rate(orig);    print(f"  % ACIERTOS (42 originales):   {pct(p,n)}   [ayer iter1: 37/42 (88.1%)]")
    p, n = rate(new);     print(f"  % ACIERTOS (16 nuevos iter3): {pct(p,n)}")
    print("\n  Por categoría (full):")
    for k in sorted(cats):
        p, n = rate(cats[k]); print(f"    {k:<18} {pct(p,n)}")
    print(f"\n  # ERRORES: {len(errs)} ({len(infra)} de infra/timeout, "
          f"{len(errs)-len(infra)} de contenido)")
    for r in errs:
        why = r.get("error") or "checks/judge"
        print(f"    ✗ {r['case']['case_id']} [{r['case']['category']}/{r['case']['subcategory']}] {why}")
    if latencies:
        print(f"\n  LATENCIA (n={len(latencies)} turnos): "
              f"P50={percentile(latencies,50)/1000:.1f}s · P95={percentile(latencies,95)/1000:.1f}s · "
              f"min={min(latencies)/1000:.1f}s · max={max(latencies)/1000:.1f}s   "
              f"[ayer: P50 7.1s · P95 15.5s]")
    print("\n  Doc transcripts:", DOC)
    print("  Resultados crudos:", raw)
    print("=" * 70)


if __name__ == "__main__":
    main()
