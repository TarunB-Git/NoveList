# Search quality in CI

The search quality job builds a FAISS index for a fictional 32-novel catalogue, then evaluates the production hybrid ranker with typo matching enabled. The fixture has 27 fixed queries covering exact titles, aliases, single typos, double typos, and ambiguous near-matches. The benchmark records a hit when any expected novel ID appears in the first five results.

The gate requires **90% overall Hit@5** and **90% single-typo Hit@5**. On this fixture, those thresholds require at least 25 of 27 overall hits and 11 of 12 single-typo hits. Empty required categories, unreadable inputs, and invalid labels fail the check. Latency is informational. The Actions job uploads its JSON report on success or failure.

## Observed local results

| Query category | Production ranker | Typo fallback disabled |
|---|---:|---:|
| Exact titles | 4/4 | 4/4 |
| Aliases | 4/4 | 4/4 |
| Single typos | 12/12 | 8/12 |
| Double typos | 4/5 | 4/5 |
| Ambiguous near-matches | 2/2 | 2/2 |
| Overall | 26/27 | 22/27 |

Local CPU latency with a warm model and an empty query cache per sample was **6.86 ms p50** and **8.33 ms p95** for the production ranker. These measurements exclude model startup and HTTP. The fixture includes shared title terms that make several single typos hard to recover with vector and keyword ranking alone. It also includes a double typo outside the fallback's one-edit limit.

The local CLI passed at both 90% thresholds and exited nonzero at a 100% overall threshold while retaining the JSON report. Removing the ambiguous category or supplying a missing query file also failed with a report.

## Regenerate the index

From the repository root, with Python 3.11 and CPU PyTorch installed:

```bash
python -m pip install -r backend/requirements.txt
index_dir=$(mktemp -d)
OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 PYTHONHASHSEED=0 \
  python scripts/build_index.py --data tests/search_quality_catalogue.json --index-dir "$index_dir"
OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 PYTHONHASHSEED=0 \
  python scripts/benchmark_search.py --index-dir "$index_dir" \
    --queries tests/search_quality_queries.json \
    --mode hybrid-typo --min-hit-at-5 0.90 --min-single-typo-hit-at-5 0.90
```

The index builder downloads MiniLM on first use and writes the generated vectors and metadata to the temporary directory. The larger local catalogue is outside this fixture.

## GitHub Actions verification

Hosted verification is pending. Record the search-quality job duration, hit counts, and links after observing the branch runs under both thresholds. The dependent dry-run job should succeed with both 90% gates and be skipped when the 100% overall gate fails. Verify the final PR with the 90% thresholds and the dry-run job removed.
