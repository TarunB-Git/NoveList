"""Measure top-five search quality against a labelled catalogue index."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean, median, quantiles
from time import perf_counter_ns

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from search import SearchEngine  # noqa: E402

REQUIRED_CATEGORIES = {"exact", "alias", "single-typo", "double-typo", "ambiguous"}


class HybridWithoutTypo(SearchEngine):
    """Run the production ranker with the typo fallback disabled."""

    def _typo_match(self, query: str) -> None:
        return None


def load_labels(path: Path, novel_ids: set[int]) -> list[dict]:
    labels = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(labels, list) or not labels:
        raise ValueError("Expected a nonempty JSON array of labelled queries")

    seen = set()
    ids_by_split = defaultdict(set)
    for label in labels:
        if not isinstance(label, dict):
            raise ValueError("Every query label must be an object")
        query = label.get("query")
        category = label.get("category")
        split = label.get("split")
        relevant = label.get("relevant_ids")
        if (
            not isinstance(query, str)
            or not query.strip()
            or query.strip().casefold() in seen
            or not isinstance(category, str)
            or not category.strip()
            or category == "all"
            or split not in ("development", "holdout")
            or not isinstance(relevant, list)
            or not relevant
            or not all(type(novel_id) is int and novel_id in novel_ids for novel_id in relevant)
        ):
            raise ValueError(f"Invalid or duplicate query label: {label}")
        seen.add(query.strip().casefold())
        ids_by_split[split].update(relevant)
    if ids_by_split["development"] & ids_by_split["holdout"]:
        raise ValueError("Development and held-out queries must target different novels")
    return labels


async def benchmark(engine: SearchEngine, labels: list[dict], repeats: int) -> list[dict]:
    await engine.search(labels[0]["query"], top_k=5)
    quality = defaultdict(list)
    latency = defaultdict(list)
    rng = random.Random(42)
    for repetition in range(repeats):
        batch = labels.copy()
        rng.shuffle(batch)
        for label in batch:
            # Each sample runs the production search path with an empty result cache.
            engine._query_cache.clear()
            started = perf_counter_ns()
            results, _ = await engine.search(label["query"], top_k=5)
            elapsed_ms = (perf_counter_ns() - started) / 1_000_000
            expected = set(label["relevant_ids"])
            ranks = [
                rank for rank, novel in enumerate(results, start=1)
                if novel["novel_id"] in expected
            ]
            for category in (label["category"], "all"):
                key = (label["split"], category)
                latency[key].append(elapsed_ms)
                if repetition == 0:
                    quality[key].append((
                        bool(ranks),
                        1 / ranks[0] if ranks else 0.0,
                        len(ranks) / len(expected),
                    ))

    rows = []
    for (split, category), scores in sorted(quality.items()):
        times = latency[split, category]
        hits, reciprocal_ranks, recall = zip(*scores)
        rows.append({
            "split": split,
            "category": category,
            "hits_at_5": sum(hits),
            "queries": len(scores),
            "hit_at_5": mean(hits),
            "mrr_at_5": mean(reciprocal_ranks),
            "recall_at_5": mean(recall),
            "p50_ms": median(times),
            "p95_ms": quantiles(times, n=20, method="inclusive")[18],
        })
    return rows


def check_thresholds(rows: list[dict], thresholds: dict[str, float]) -> tuple[list[dict], list[str]]:
    results = {row["category"]: row for row in rows if row["split"] == "holdout"}
    missing = REQUIRED_CATEGORIES - results.keys()
    errors = [f"Missing required holdout category: {category}" for category in sorted(missing)]
    gates = []
    for category, minimum in thresholds.items():
        row = results.get(category)
        passed = row is not None and row["hit_at_5"] >= minimum
        gates.append({
            "category": category,
            "minimum_hit_at_5": minimum,
            "hits_at_5": row["hits_at_5"] if row else 0,
            "queries": row["queries"] if row else 0,
            "hit_at_5": row["hit_at_5"] if row else None,
            "passed": passed,
        })
        if row and not passed:
            errors.append(
                f"{category} Hit@5 was {row['hits_at_5']}/{row['queries']} "
                f"({row['hit_at_5']:.1%}); required {minimum:.1%}"
            )
    return gates, errors


def rate(value: str) -> float:
    threshold = float(value)
    if not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise argparse.ArgumentTypeError("expected a fraction between 0 and 1")
    return threshold


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index-dir", required=True, type=Path)
    parser.add_argument("--queries", required=True, type=Path)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--mode", choices=("hybrid-typo", "hybrid"), default="hybrid-typo")
    parser.add_argument("--min-hit-at-5", type=rate)
    parser.add_argument("--min-single-typo-hit-at-5", type=rate)
    args = parser.parse_args()
    if args.repeats < 2:
        parser.error("--repeats must be at least 2 for latency percentiles")
    thresholds = {
        category: minimum for category, minimum in (
            ("all", args.min_hit_at_5), ("single-typo", args.min_single_typo_hit_at_5)
        ) if minimum is not None
    }
    if thresholds and args.mode != "hybrid-typo":
        parser.error("quality thresholds apply only to hybrid-typo")

    report = {"mode": args.mode, "thresholds": thresholds, "results": [], "gates": []}
    try:
        engine_class = SearchEngine if args.mode == "hybrid-typo" else HybridWithoutTypo
        engine = engine_class(args.index_dir.resolve())
        if not engine.num_indexed:
            raise ValueError("The benchmark index is empty")
        labels = load_labels(args.queries, set(engine.metadata_by_id))
        report["metadata"] = {
            "novels": engine.num_indexed,
            "queries": len(labels),
            "repeats": args.repeats,
            "index_metadata_sha256": hashlib.sha256(
                (engine.index_dir / "metadata.json").read_bytes()
            ).hexdigest(),
            "index_vectors_sha256": hashlib.sha256(
                (engine.index_dir / "vectors.npy").read_bytes()
            ).hexdigest(),
            "queries_sha256": hashlib.sha256(args.queries.read_bytes()).hexdigest(),
        }
        report["results"] = asyncio.run(benchmark(engine, labels, args.repeats))
        if thresholds:
            report["gates"], errors = check_thresholds(report["results"], thresholds)
        else:
            errors = []
    except Exception as error:
        errors = [f"{type(error).__name__}: {error}"]

    report["status"] = "failed" if errors else "passed"
    report["errors"] = errors
    print(json.dumps(report, indent=2))
    for error in errors:
        print(error, file=sys.stderr)
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
