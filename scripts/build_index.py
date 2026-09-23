#!/usr/bin/env python
"""
Build search vectors and catalogue metadata from local novel records.

Run from the project root:
    python scripts/build_index.py

Or with a custom dataset:
    python scripts/build_index.py --data path/to/novels.json

The script saves two files:
    backend/index/vectors.npy   — normalized float32 vectors
    backend/index/metadata.json — catalogue records in vector order
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

# Allow importing backend modules
BACKEND_DIR = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import faiss  # noqa: E402
import numpy as np  # noqa: E402
from embedder import Embedder, build_novel_text  # noqa: E402
from catalogue_store import load_records  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
)
logger = logging.getLogger("build_index")


def build_index(data_path: Path | None, index_dir: Path, model_name: str) -> None:
    logger.info("Loading novels from %s", data_path or "catalogue database")
    if data_path is None:
        novels = load_records()
    else:
        with data_path.open(encoding="utf-8") as fh:
            novels = json.load(fh)
    logger.info("Loaded %d novels", len(novels))

    # ── Build text representations ─────────────────────────────────────
    texts = [build_novel_text(novel) for novel in novels]

    # ── Embed ──────────────────────────────────────────────────────────
    try:
        embedder = Embedder(model_name, local_files_only=True)
    except OSError:
        logger.info(
            "Embedding model is not cached; downloading it for the initial index build"
        )
        embedder = Embedder(model_name, local_files_only=False)
    logger.info("Embedding %d texts with model '%s'…", len(texts), model_name)
    t0 = time.time()
    embeddings: np.ndarray = (
        embedder.embed(texts) if texts else np.empty((0, embedder.dim), dtype=np.float32)
    )
    elapsed = time.time() - t0
    logger.info(
        "Embedded %d texts in %.1fs  (%.0f texts/s)  shape=%s",
        len(texts),
        elapsed,
        len(texts) / elapsed if elapsed else 0,
        embeddings.shape,
    )

    # ── Build FAISS index ──────────────────────────────────────────────
    dim = embeddings.shape[1]

    # IndexFlatIP = exact inner-product search.
    # Since vectors are L2-normalised, inner product == cosine similarity.
    index = faiss.IndexFlatIP(dim)
    index.add(embeddings)
    logger.info("Validated %d vectors for FAISS (dim=%d)", index.ntotal, dim)

    # ── Save artifacts ─────────────────────────────────────────────────
    index_dir.mkdir(parents=True, exist_ok=True)

    vectors_path = index_dir / "vectors.npy"
    metadata_path = index_dir / "metadata.json"
    vectors_pending = index_dir / "vectors.npy.tmp"
    metadata_pending = index_dir / "metadata.json.tmp"

    with vectors_pending.open("wb") as fh:
        np.save(fh, embeddings, allow_pickle=False)
    with metadata_pending.open("w", encoding="utf-8") as fh:
        json.dump(novels, fh, ensure_ascii=False)
    vectors_pending.replace(vectors_path)
    metadata_pending.replace(metadata_path)
    logger.info("Saved vectors to %s and metadata to %s", vectors_path, metadata_path)

    logger.info("Index ready. Start the backend with: python backend/main.py")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build NoveList search vectors and metadata"
    )
    parser.add_argument(
        "--data",
        type=Path,
        help="Optional JSON source; defaults to the local catalogue database",
    )
    parser.add_argument(
        "--index-dir",
        type=Path,
        default=BACKEND_DIR / "index",
        help="Directory to save vectors and metadata",
    )
    parser.add_argument(
        "--model",
        default="all-MiniLM-L6-v2",
        help="Sentence-transformers model name (default: all-MiniLM-L6-v2)",
    )
    args = parser.parse_args()

    if args.data is not None and not args.data.exists():
        parser.error(f"Data file not found: {args.data}")

    build_index(args.data, args.index_dir, args.model)


if __name__ == "__main__":
    main()
