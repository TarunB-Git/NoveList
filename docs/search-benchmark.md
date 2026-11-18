# NoveList search benchmark

A local evaluation over 890 indexed novels compared FAISS vector search, keyword search, the existing hybrid ranker, and the hybrid ranker with a title typo fallback. The fallback boosts a unique title or alias one edit away, including adjacent letter swaps. It skips short queries, exact title hits, and cases where the edit matches multiple novels.

## Expanded title benchmark

| Ranker | All Hit@5 | Exact Hit@5 | One typo Hit@5 | Two typos Hit@5 | One typo MRR@5 | All p95 |
|---|---:|---:|---:|---:|---:|---:|
| Vector only | 77.89% | 94.67% | 77.67% | 61.33% | 0.646 | 10.13 ms |
| Keyword only | 87.78% | 98.00% | 90.67% | 74.67% | 0.798 | 8.18 ms |
| Original hybrid | 92.89% | 99.67% | 95.33% | 83.67% | 0.873 | 17.17 ms |
| Hybrid with typo fallback | 94.11% | 99.67% | 99.00% | 83.67% | 0.970 | 17.19 ms |

On single-typo queries, top-five misses fell from 14 of 300 to 3 of 300, a 78.6% relative reduction. Hit@5 increased by 3.67 percentage points. Exact-title and double-typo Hit@5 were unchanged.

This follow-up sampled 300 eligible titles whose novel IDs were absent from the pilot. Each title contributed three queries for 900 distinct queries total. The exact title was the control. Each single-typo query used one dropped letter, adjacent-key substitution, adjacent swap, or doubled letter, with 75 queries per edit type. Each double-typo query used two separated adjacent-key substitutions. The generator discards simulated typos that duplicate a known title or alias. The original ranker and the improved ranker ran on the same queries and index without further tuning.

Each query ran three times per ranking mode in shuffled order, with the same warm CPU and cache settings as the pilot. Treat the 900 inputs as three queries per title. The generated typos measure how search responds to controlled spelling errors and do not estimate how often those errors occur in production.

```bash
python scripts/generate_title_benchmark.py \
  --metadata backend/data/index/metadata.json \
  --exclude-queries backend/data/index/benchmark-queries.json \
  --output backend/data/index/expanded-benchmark-queries.json

OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 python scripts/benchmark_search.py \
  --index-dir backend/data/index \
  --queries backend/data/index/expanded-benchmark-queries.json \
  --repeats 3 > backend/data/index/expanded-benchmark-results.json
```

The generator uses a fixed seed and excludes every labelled title from the pilot. Query files and raw results stay in the ignored local index directory.

## Pilot held-out results

Higher Hit@5 and MRR@5 are better. Hit@5 counts whether the intended novel appeared in the first five results. MRR@5 gives more credit when it appears earlier. Each query in this run had one labelled target, so Recall@5 equals Hit@5.

| Ranker | All Hit@5 | All MRR@5 | Typo Hit@5 | Typo MRR@5 | Plot Hit@5 | All p95 |
|---|---:|---:|---:|---:|---:|---:|
| Vector only | 28/40 | 0.556 | 9/18 | 0.444 | 6/8 | 10.95 ms |
| Keyword only | 29/40 | 0.626 | 14/18 | 0.613 | 1/8 | 7.28 ms |
| Original hybrid | 30/40 | 0.643 | 15/18 | 0.596 | 1/8 | 16.48 ms |
| Hybrid with typo fallback | 33/40 | 0.812 | 18/18 | 0.972 | 1/8 | 16.49 ms |

Exact and alias Hit@5 remained 10/10 and 4/4 respectively after adding the fallback. The vector-only result on plot queries makes plot ranking a separate improvement opportunity.

## Method and reproduction

The set contains 61 queries across exact titles, aliases, simulated single-character typos, and hand-written plot paraphrases. It uses 21 development queries and 40 held-out queries with disjoint novel IDs. The held-out set contains 10 exact titles, 4 aliases, 18 typos, and 8 plot queries. Plot queries have one intended novel per paraphrase. These labels measure known-item retrieval and do not exhaustively judge other relevant novels.

The timings are local search-engine calls on an Intel Core i7-1165G7 with a warm MiniLM model, two threads configured through OpenMP and MKL, and the query cache bypassed. Each query and mode ran five times in shuffled order. The reported p95 excludes HTTP and model startup. The typo cases use simulated errors and the sample is small. Treat the figures as measurements on this set and machine.

From the repo root, with the search dependencies and the MiniLM model cached locally, run:

```bash
OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 python scripts/benchmark_search.py \
  --index-dir backend/data/index \
  --queries backend/data/index/benchmark-queries.json
```

The local labels and raw report are in the ignored index directory. For another catalogue snapshot, supply a JSON array with one object per query. For example:

```json
[
  {
    "query": "Drgaon Road",
    "category": "typo",
    "split": "holdout",
    "relevant_ids": [1]
  }
]
```

The evaluator validates labelled IDs and split overlap and emits the label and index hashes alongside the results. It evaluates the indexed snapshot without editing the catalogue.
