"""Encode catalogue records and queries with the configured sentence-transformers model."""

from __future__ import annotations

import logging
from typing import List

import numpy as np

logger = logging.getLogger(__name__)

# Model used by the index builder and search service.
DEFAULT_MODEL = "all-MiniLM-L6-v2"


class Embedder:
    """Thin wrapper around a sentence-transformers model."""

    def __init__(self, model_name: str = DEFAULT_MODEL, local_files_only: bool = True):
        logger.info("Loading embedding model: %s", model_name)
        try:
            from sentence_transformers import SentenceTransformer

            # Serving must never depend on an outbound model registry request.
            # The index build is the explicit download/install boundary.
            self._model = SentenceTransformer(
                model_name, local_files_only=local_files_only
            )
            self.dim = self._model.get_embedding_dimension()
            logger.info("Embedding dim: %d", self.dim)
        except ImportError as exc:
            raise RuntimeError(
                "sentence-transformers is not installed. "
                "Run: pip install sentence-transformers"
            ) from exc

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def embed(self, texts: List[str], batch_size: int = 64) -> np.ndarray:
        """
        Embed a list of texts.
        Returns float32 ndarray of shape (len(texts), self.dim).
        Vectors are L2-normalised (ready for cosine similarity via dot product).
        """
        if not texts:
            return np.empty((0, self.dim), dtype=np.float32)

        embeddings = self._model.encode(
            texts,
            batch_size=batch_size,
            show_progress_bar=len(texts) > 100,
            normalize_embeddings=True,  # L2-normalise → cosine via dot
            convert_to_numpy=True,
        )
        return embeddings.astype(np.float32)

    def embed_one(self, text: str) -> np.ndarray:
        """Convenience: embed a single string, return (dim,) array."""
        return self.embed([text])[0]


# ------------------------------------------------------------------
# Text preparation helpers
# ------------------------------------------------------------------


def build_novel_text(novel: dict) -> str:
    """
    Combine title + synopsis + tags into a single rich text for embedding.
    The order and repetition are intentional:
      - Title gives a high-weight signal on the title token.
      - Synopsis carries semantic meaning.
      - Tags repeated twice to increase their weight in the embedding.
    """
    title = novel.get("title", "")
    author = novel.get("author", "")
    # Seeded catalogue notes are title/tag aids only. They are never indexed as
    # descriptions; a verified source scrape replaces them in the dataset.
    synopsis = "" if novel.get("hand_authored") else novel.get("synopsis", "")
    tags = novel.get("tags", [])
    aliases = novel.get("title_aliases", [])
    tag_str = ", ".join(tags)
    alias_str = ", ".join(aliases)

    # Tags appear twice to increase their embedding weight
    return f"{title}. Author: {author}. Also known as: {alias_str}. {synopsis} Tags: {tag_str}. Genre keywords: {tag_str}."


def build_query_text(query: str) -> str:
    """Light normalisation on user query (no stemming—model handles it)."""
    return query.strip()
