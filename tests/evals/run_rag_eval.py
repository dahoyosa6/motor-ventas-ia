"""
Eval de recall del RAG de catálogo contra tests/evals/rag_groundtruth.jsonl.

Mide el cimiento del POC de Sem 3: ¿la búsqueda semántica encuentra el SKU
correcto ANTES de construir el agente n8n encima?

Qué hace:
  1. Lee las 20 queries ground truth (17 positivas + 3 negativas).
  2. Para cada query embebe el texto con text-embedding-3-small (1536d).
  3. Hace retrieval vía la función SQL `match_products` (RPC de Supabase) —
     la MISMA función que usan los nodos del orquestador. Se pasa
     `filter_tenant='clinica_demo'` EXPLÍCITO: la función lo exige y
     un filtro olvidado sería fuga cross-tenant.
  4. Calcula recall@1 / @3 / @5 sobre las positivas (¿el SKU esperado aparece
     en el top-K?) y, sobre las negativas, el score del top-1 (riesgo de
     falso positivo / alucinación).
  5. Imprime tabla por query + agregados + análisis de fallos.

Pre-requisitos:
  - .env con OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY.
  - scripts/ingest_catalog_to_pgvector.py ya corrido (products +
    product_embeddings poblados).
  - Migration 0002 aplicada (función match_products).

Uso:
  .venv/bin/python3 tests/evals/run_rag_eval.py
  .venv/bin/python3 tests/evals/run_rag_eval.py --json   # salida JSON cruda
  .venv/bin/python3 tests/evals/run_rag_eval.py --k 10   # top-K mayor

Reproducible: mismo catálogo + mismo ground truth + mismo modelo => mismos
números (HNSW ef_search se fija en 40 dentro de match_products). Re-correr es
solo-lectura sobre Supabase y barato en OpenAI (~20 embeddings de 1 query).

Diseño:
  - SCORE_ALERT_THRESHOLD (0.45): umbral heurístico para señalar una negativa
    como "riesgo de falso positivo". NO es el umbral de producción del agente
    (ese lo fija el quality-engineer con la curva completa); aquí solo sirve
    para que el reporte marque negativas peligrosas. Cosine similarity de
    text-embedding-3-small entre query y producto no relacionado suele caer
    < 0.35; > 0.45 merece una mirada humana.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUNDTRUTH = REPO_ROOT / "tests" / "evals" / "rag_groundtruth.jsonl"

EMBEDDING_MODEL = "text-embedding-3-small"
TENANT = "clinica_demo"
SCORE_ALERT_THRESHOLD = 0.45  # ver docstring: heurística de reporte, no de prod


def load_env_or_die() -> tuple[str, str, str]:
    try:
        from dotenv import load_dotenv
        load_dotenv(REPO_ROOT / ".env")
    except ImportError:
        pass
    openai_key = os.getenv("OPENAI_API_KEY")
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_ANON_KEY")
    if not openai_key:
        sys.exit("❌ OPENAI_API_KEY no está en .env.")
    if not (supabase_url and supabase_key):
        sys.exit("❌ SUPABASE_URL o SUPABASE_ANON_KEY faltan en .env.")
    return openai_key, supabase_url, supabase_key


def load_groundtruth() -> list[dict]:
    if not GROUNDTRUTH.exists():
        sys.exit(f"❌ Ground truth no encontrado: {GROUNDTRUTH}")
    queries = []
    with GROUNDTRUTH.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                queries.append(json.loads(line))
    return queries


def first_hit_rank(retrieved_skus: list[str], expected: list[str]) -> int | None:
    """Posición (1-indexed) del primer SKU recuperado que está en expected."""
    expected_set = set(expected)
    for rank, sku in enumerate(retrieved_skus, start=1):
        if sku in expected_set:
            return rank
    return None


def run_eval(k: int) -> dict:
    openai_key, supabase_url, supabase_key = load_env_or_die()

    from openai import OpenAI
    from supabase import create_client

    openai_client = OpenAI(api_key=openai_key)
    supa = create_client(supabase_url, supabase_key)

    queries = load_groundtruth()
    # Va a stderr a propósito: con --json, stdout debe ser SOLO el payload
    # JSON parseable (`run_rag_eval.py --json > resultado.json`).
    print(f"📋 {len(queries)} queries cargadas de rag_groundtruth.jsonl",
          file=sys.stderr)

    results = []
    for q in queries:
        emb = openai_client.embeddings.create(
            model=EMBEDDING_MODEL, input=q["query_text"]
        ).data[0].embedding

        # RPC a match_products. filter_tenant EXPLÍCITO (aislamiento cross-tenant).
        rpc = supa.rpc("match_products", {
            "query_embedding": emb,
            "match_count": k,
            "filter": {},
            "filter_tenant": TENANT,
        }).execute()

        hits = rpc.data or []
        retrieved = [
            {
                "sku": (h.get("metadata") or {}).get("sku"),
                "description": (h.get("metadata") or {}).get("description"),
                "similarity": round(h.get("similarity", 0.0), 4),
            }
            for h in hits
        ]
        retrieved_skus = [r["sku"] for r in retrieved]

        is_negative = q["expected_behavior"] == "no_match"
        expected = q.get("expected_any_of") or (
            [q["expected_sku"]] if q.get("expected_sku") else []
        )
        rank = first_hit_rank(retrieved_skus, expected) if not is_negative else None
        top1_score = retrieved[0]["similarity"] if retrieved else 0.0

        results.append({
            "query_id": q["query_id"],
            "query_type": q["query_type"],
            "difficulty": q["difficulty"],
            "query_text": q["query_text"],
            "is_negative": is_negative,
            "expected": expected,
            "retrieved": retrieved,
            "retrieved_skus": retrieved_skus,
            "first_hit_rank": rank,
            "top1_sku": retrieved[0]["sku"] if retrieved else None,
            "top1_score": top1_score,
            "false_positive_risk": is_negative and top1_score >= SCORE_ALERT_THRESHOLD,
        })

    return {"k": k, "results": results}


def aggregate(results: list[dict]) -> dict:
    positives = [r for r in results if not r["is_negative"]]
    negatives = [r for r in results if r["is_negative"]]
    n_pos = len(positives)

    def recall_at(n: int) -> float:
        hits = sum(
            1 for r in positives
            if r["first_hit_rank"] is not None and r["first_hit_rank"] <= n
        )
        return hits / n_pos if n_pos else 0.0

    by_type: dict[str, dict] = {}
    for r in positives:
        t = r["query_type"]
        bucket = by_type.setdefault(t, {"total": 0, "hit3": 0})
        bucket["total"] += 1
        if r["first_hit_rank"] is not None and r["first_hit_rank"] <= 3:
            bucket["hit3"] += 1

    return {
        "n_positive": n_pos,
        "n_negative": len(negatives),
        "recall@1": recall_at(1),
        "recall@3": recall_at(3),
        "recall@5": recall_at(5),
        "by_type_hit3": by_type,
        "negatives_with_fp_risk": [
            r["query_id"] for r in negatives if r["false_positive_risk"]
        ],
    }


def print_report(payload: dict) -> None:
    results = payload["results"]
    k = payload["k"]
    agg = aggregate(results)

    print("\n" + "=" * 78)
    print(f"  EVAL RAG — catálogo (tenant demo) — top-K={k}")
    print("=" * 78)

    print(f"\n{'QID':<5}{'TIPO':<22}{'DIF':<8}{'ESPERADO':<14}"
          f"{'POS':<6}{'SCORE':<8}RESULTADO")
    print("-" * 78)
    for r in sorted(results, key=lambda x: x["query_id"]):
        exp = (r["expected"][0] if r["expected"] else "—")
        exp = (exp[:12] + "…") if exp and len(exp) > 13 else exp
        if r["is_negative"]:
            pos = "n/a"
            verdict = ("⚠️ RIESGO FP" if r["false_positive_risk"]
                       else "✅ sin FP")
        else:
            if r["first_hit_rank"] is not None:
                pos = f"#{r['first_hit_rank']}"
                verdict = "✅ hit" if r["first_hit_rank"] <= 5 else "❌ fuera"
            else:
                pos = "—"
                verdict = "❌ NO ENCONTRADO"
        print(f"{r['query_id']:<5}{r['query_type']:<22}{r['difficulty']:<8}"
              f"{exp:<14}{pos:<6}{r['top1_score']:<8}{verdict}")

    print("\n" + "-" * 78)
    print("  RECALL AGREGADO (17 queries positivas)")
    print("-" * 78)
    print(f"  recall@1 : {agg['recall@1']:.1%}  "
          f"({round(agg['recall@1'] * agg['n_positive'])}/{agg['n_positive']})")
    print(f"  recall@3 : {agg['recall@3']:.1%}  "
          f"({round(agg['recall@3'] * agg['n_positive'])}/{agg['n_positive']})")
    print(f"  recall@5 : {agg['recall@5']:.1%}  "
          f"({round(agg['recall@5'] * agg['n_positive'])}/{agg['n_positive']})")

    print("\n  Hit@3 por tipo de query:")
    for t, b in sorted(agg["by_type_hit3"].items()):
        print(f"    {t:<24} {b['hit3']}/{b['total']}")

    print("\n  Negativas (3 queries — NO deben devolver match espurio):")
    for r in sorted((x for x in results if x["is_negative"]),
                    key=lambda x: x["query_id"]):
        flag = "⚠️ RIESGO" if r["false_positive_risk"] else "ok"
        print(f"    {r['query_id']}  top1={r['top1_sku']}  "
              f"score={r['top1_score']}  [{flag}]")

    print("\n  Fallos (queries positivas sin hit en top-K):")
    fails = [r for r in results
             if not r["is_negative"] and r["first_hit_rank"] is None]
    if not fails:
        print("    (ninguno)")
    for r in fails:
        print(f"    {r['query_id']} [{r['query_type']}] «{r['query_text'][:60]}»")
        print(f"        esperado: {r['expected']}")
        print(f"        top-3 recuperado:")
        for h in r["retrieved"][:3]:
            print(f"          {h['similarity']}  {h['sku']}  {h['description']}")
    print("=" * 78 + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--k", type=int, default=5,
                        help="top-K a recuperar (default: 5)")
    parser.add_argument("--json", action="store_true",
                        help="Imprime el payload JSON crudo (para guardar).")
    args = parser.parse_args()

    payload = run_eval(args.k)
    payload["aggregate"] = aggregate(payload["results"])

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print_report(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
