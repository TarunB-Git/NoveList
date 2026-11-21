"""Generate matched exact-title and simulated typo queries from a local index."""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

KEYBOARD_ROWS = ("qwertyuiop", "asdfghjkl", "zxcvbnm")
NEIGHBORS = {
    key: row[max(0, offset - 1):offset] + row[offset + 1:offset + 2]
    for row in KEYBOARD_ROWS
    for offset, key in enumerate(row)
}


def query_key(query: str) -> str:
    return re.sub(r"[^\w'-]", "", query.casefold())


def typo_variants(title: str, rng: random.Random) -> tuple[list[list[str]], list[str]]:
    offsets = [i for i, letter in enumerate(title) if letter.lower() in NEIGHBORS]

    def substitute(index: int) -> str:
        replacement = rng.choice(NEIGHBORS[title[index].lower()])
        return replacement.upper() if title[index].isupper() else replacement

    substitutions = {i: substitute(i) for i in offsets}
    transpositions = [
        title[:i] + title[i + 1] + title[i] + title[i + 2:]
        for i in offsets
        if i + 1 in substitutions and title[i].casefold() != title[i + 1].casefold()
    ]
    double_typos = [
        title[:i] + substitutions[i] + title[i + 1:j] + substitutions[j] + title[j + 1:]
        for i in offsets
        for j in offsets
        if i + 1 < j
    ]
    single_typos = [
        [title[:i] + title[i + 1:] for i in offsets],
        [title[:i] + substitutions[i] + title[i + 1:] for i in offsets],
        transpositions,
        [title[:i] + title[i] + title[i:] for i in offsets],
    ]
    return single_typos, double_typos


def generate(records: list[dict], prior_labels: list[dict], count: int, seed: int) -> list[dict]:
    title_ids = {}
    for record in records:
        for title in (record["title"], *(record.get("title_aliases") or [])):
            title_ids.setdefault(query_key(title), set()).add(record["id"])
    prior_ids = {novel_id for label in prior_labels for novel_id in label["relevant_ids"]}
    used_queries = {query_key(label["query"]) for label in prior_labels}

    rng = random.Random(seed)
    candidates = sorted(records, key=lambda record: record["id"])
    rng.shuffle(candidates)
    labels = []
    categories = ("exact", "single-typo", "double-typo")
    for record in candidates:
        title = record["title"].strip()
        key = query_key(title)
        novel_id = record["id"]
        if novel_id in prior_ids or key in used_queries or title_ids[key] != {novel_id}:
            continue
        single_variants, double_variants = typo_variants(title, rng)
        operation = len(labels) // len(categories) % len(single_variants)

        def available(variants: list[str]) -> list[str]:
            return [
                query for query in variants
                if (candidate_key := query_key(query))
                and candidate_key not in used_queries
                and candidate_key not in title_ids
            ]

        single = available(single_variants[operation])
        double = available(double_variants)
        if not single or not double:
            continue
        queries = (title, rng.choice(single), rng.choice(double))
        for category, query in zip(categories, queries):
            used_queries.add(query_key(query))
            labels.append({
                "query": query,
                "category": category,
                "split": "holdout",
                "relevant_ids": [novel_id],
            })
        if len(labels) == count * len(categories):
            return labels
    raise ValueError(f"Only {len(labels) // len(categories)} eligible titles; requested {count}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--exclude-queries", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--titles", type=int, default=300)
    parser.add_argument("--seed", type=int, default=20261118)
    args = parser.parse_args()
    if args.titles < 1:
        parser.error("--titles must be positive")
    records = json.loads(args.metadata.read_text(encoding="utf-8"))
    prior_labels = json.loads(args.exclude_queries.read_text(encoding="utf-8"))
    labels = generate(records, prior_labels, args.titles, args.seed)
    args.output.write_text(json.dumps(labels, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
