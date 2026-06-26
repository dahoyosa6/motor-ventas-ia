#!/usr/bin/env python3
"""Agrega los JSON crudos de run_eval_with_transcripts.py (uno por bloque/categoría)
en un resumen único de KPIs: pass rate overall y por categoría, fallos con el detalle
de checks, y latencia P50/P95 sobre los turnos del asistente.

Uso:
    python3 tests/evals/aggregate_kpis.py tests/evals/results/iter3_full_A.json [B.json ...]
    python3 tests/evals/aggregate_kpis.py --json ...   (salida JSON cruda)

El costo/turno NO se calcula aquí (no viaja en los transcripts); se toma de
Langfuse o del baseline documentado en scripts/roi_agente_vs_humano.py.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def percentile(values, p):
    if not values:
        return None
    vs = sorted(values)
    k = (len(vs) - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, len(vs) - 1)
    return vs[f] + (vs[c] - vs[f]) * (k - f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    rows = []
    for f in args.files:
        rows.extend(json.loads(Path(f).read_text(encoding="utf-8")))

    seen = set()
    cases = []
    for r in rows:
        if r["case_id"] in seen:  # si un caso se re-corrió, gana la última aparición
            cases = [c for c in cases if c["case_id"] != r["case_id"]]
        seen.add(r["case_id"])
        cases.append(r)

    by_cat = defaultdict(lambda: {"pass": 0, "total": 0})
    failures, infra = [], []
    latencies = []
    for c in cases:
        cat = c["category"]
        by_cat[cat]["total"] += 1
        if c.get("status") != "ok":
            infra.append({"case_id": c["case_id"], "category": cat, "error": c.get("error")})
        elif c.get("passed"):
            by_cat[cat]["pass"] += 1
        else:
            failed_checks = [
                {"name": ch.get("name"), "detail": str(ch.get("detail"))[:160]}
                for ch in (c.get("checks") or []) if not ch.get("pass")
            ]
            judge = c.get("judge") or {}
            failures.append({
                "case_id": c["case_id"], "category": cat,
                "subcategory": c.get("subcategory"),
                "failed_checks": failed_checks,
                "judge_verdict": judge.get("verdict"),
                "judge_reason": str(judge.get("reason", ""))[:200],
            })
        for t in c.get("transcript") or []:
            if t.get("role") == "assistant" and t.get("latency_ms"):
                latencies.append(t["latency_ms"])

    ok_cases = [c for c in cases if c.get("status") == "ok"]
    passed = sum(1 for c in ok_cases if c.get("passed"))
    out = {
        "overall": {
            "pass": passed,
            "total_ok": len(ok_cases),
            "total": len(cases),
            "rate_ok": round(passed / len(ok_cases), 3) if ok_cases else None,
            "rate_full": round(passed / len(cases), 3) if cases else None,
        },
        "by_category": {
            k: {**v, "rate": round(v["pass"] / v["total"], 3)}
            for k, v in sorted(by_cat.items())
        },
        "latency_ms": {
            "n_turnos": len(latencies),
            "p50": round(percentile(latencies, 50)) if latencies else None,
            "p95": round(percentile(latencies, 95)) if latencies else None,
        },
        "infra": infra,
        "failures": failures,
    }

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    o = out["overall"]
    print(f"OVERALL: {o['pass']}/{o['total_ok']} ok ({(o['rate_ok'] or 0)*100:.1f}%) "
          f"· full {o['pass']}/{o['total']} ({(o['rate_full'] or 0)*100:.1f}%) "
          f"· infra: {len(infra)}")
    for k, v in out["by_category"].items():
        print(f"  {k:20s} {v['pass']}/{v['total']} ({v['rate']*100:.0f}%)")
    lt = out["latency_ms"]
    print(f"LATENCIA ({lt['n_turnos']} turnos): P50 {lt['p50']} ms · P95 {lt['p95']} ms")
    if infra:
        print("INFRA:", ", ".join(i["case_id"] for i in infra))
    print(f"FALLOS DE CONTENIDO ({len(failures)}):")
    for f in failures:
        checks = "; ".join(f"{c['name']}: {c['detail']}" for c in f["failed_checks"]) or "(solo juez)"
        print(f"  {f['case_id']} [{f['category']}/{f['subcategory']}] juez={f['judge_verdict']}")
        print(f"    {checks[:300]}")


if __name__ == "__main__":
    main()
