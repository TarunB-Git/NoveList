"""Measure ranking quality and cache-bypassed search latency on a labelled index."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import random
import sys
from collections import defaultdict
from importlib.metadata import version
from pathlib import Path
from statistics import mean, quantiles
from time import perf_counter_ns

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from search import SearchEngine, SearchMode  # noqa: E402

MODES: tuple[SearchMode, ...] = ("vector", "keyword", "hybrid", "hybrid-typo")


def load_labels(path: Path, novel_ids: set[int]) -> list[dict]:
    labels = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(labels, list) or not labels:
        raise ValueError("Expected a nonempty JSON array of labelled queries")

    seen = set()
    ids_by_split = defaultdict(set)
    for label in labels:
        query = label["query"].strip().casefold()
        split = label["split"]
        relevant = set(label["relevant_ids"])
        if (
            not query
            or query in seen
            or not label["category"].strip()
            or label["category"] == "all"
            or split not in ("development", "holdout")
            or not relevant
            or not relevant.issubset(novel_ids)
        ):
            raise ValueError(f"Invalid or duplicate label: {label}")
        seen.add(query)
        ids_by_split[split].update(relevant)
    if ids_by_split["development"] & ids_by_split["holdout"]:
        raise ValueError("Development and held-out queries must target different novels")
    return labels


async def benchmark(engine: SearchEngine, labels: list[dict], repeats: int) -> list[dict]:
    for mode in MODES:
        await engine.search(labels[0]["query"], top_k=5, mode=mode, use_cache=False)

    quality = defaultdict(list)
    latency = defaultdict(list)
    rng = random.Random(42)
    for repetition in range(repeats):
        batch = labels.copy()
        rng.shuffle(batch)
        for label in batch:
            mode_order = list(MODES)
            rng.shuffle(mode_order)
            for mode in mode_order:
                started = perf_counter_ns()
                results, _ = await engine.search(
                    label["query"], top_k=5, mode=mode, use_cache=False,
                )
                elapsed_ms = (perf_counter_ns() - started) / 1_000_000
                expected = set(label["relevant_ids"])
                ranks = [
                    rank for rank, novel in enumerate(results, start=1)
                    if novel["novel_id"] in expected
                ]
                for category in (label["category"], "all"):
                    key = (label["split"], category, mode)
                    latency[key].append(elapsed_ms)
                    if repetition == 0:
                        quality[key].append((
                            bool(ranks),
                            1 / ranks[0] if ranks else 0.0,
                            len(ranks) / len(expected),
                        ))
    rows = []
    for (split, category, mode), scores in sorted(quality.items()):
        times = latency[split, category, mode]
        hits, reciprocal_ranks, recall = zip(*scores)
        rows.append({
            "split": split,
            "category": category,
            "mode": mode,
            "queries": len(scores),
            "hit_at_5": mean(hits),
            "mrr_at_5": mean(reciprocal_ranks),
            "recall_at_5": mean(recall),
            "p95_ms": quantiles(times, n=20, method="inclusive")[18],
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index-dir", required=True, type=Path)
    parser.add_argument("--queries", required=True, type=Path)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if args.repeats < 2:
        parser.error("--repeats must be at least 2 for latency percentiles")
    engine = SearchEngine(args.index_dir.resolve(), verify_catalogue=False)
    labels = load_labels(args.queries, set(engine.metadata_by_id))
    metadata = {
        "novels": engine.num_indexed,
        "queries": len(labels),
        "repeats": args.repeats,
        "python": platform.python_version(),
        "torch": version("torch"),
        "sentence_transformers": version("sentence-transformers"),
        "omp_num_threads": os.environ.get("OMP_NUM_THREADS"),
        "index_metadata_sha256": hashlib.sha256(
            (engine.index_dir / "metadata.json").read_bytes()
        ).hexdigest(),
        "index_vectors_sha256": hashlib.sha256(
            (engine.index_dir / "vectors.npy").read_bytes()
        ).hexdigest(),
        "queries_sha256": hashlib.sha256(args.queries.read_bytes()).hexdigest(),
    }
    print(json.dumps({
        "metadata": metadata,
        "results": asyncio.run(benchmark(engine, labels, args.repeats)),
    }, indent=2))


if __name__ == "__main__":
    main()
