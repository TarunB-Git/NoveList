"""Hybrid lexical and vector search over the local novel catalogue."""

from __future__ import annotations

import logging
import json
import re
from collections import OrderedDict
from pathlib import Path
from typing import Literal, Optional, Tuple

import faiss
import numpy as np

from embedder import Embedder, build_query_text
from catalogue_store import load_records
from paths import INDEX_DIR

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[\w'-]+", re.UNICODE)

SearchMode = Literal["vector", "keyword", "hybrid", "hybrid-typo"]


def _query_tokens(text: str) -> list[str]:
    return [token.casefold() for token in _TOKEN_RE.findall(text) if len(token) > 1]


def _one_edit_apart(query: str, title: str) -> bool:
    """Allow one insertion, deletion, replacement, or adjacent transposition."""
    if abs(len(query) - len(title)) > 1 or query == title:
        return False
    if len(query) > len(title):
        query, title = title, query
    for offset, (left, right) in enumerate(zip(query, title)):
        if left != right:
            break
    else:
        return len(title) > len(query)
    if len(title) > len(query):
        return query[offset:] == title[offset + 1:]
    return query[offset + 1:] == title[offset + 1:] or (
        query[offset:offset + 2] == title[offset:offset + 2][::-1]
        and query[offset + 2:] == title[offset + 2:]
    )


class SearchEngine:
    """
    Main search engine.

    Attributes:
        num_indexed (int): Number of novels in the FAISS index.
    """

    def __init__(self, index_dir: Path = INDEX_DIR, *, verify_catalogue: bool = True):
        self.index_dir = index_dir
        self.embedder = Embedder()
        self._load_index()
        if verify_catalogue and self.index_dir == INDEX_DIR and self.metadata != load_records():
            raise ValueError("Search index differs from the catalogue database; run make index")

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _load_index(self) -> None:
        vectors_path = self.index_dir / "vectors.npy"
        metadata_path = self.index_dir / "metadata.json"

        if not vectors_path.exists() and not metadata_path.exists():
            self.metadata = []
            vectors = np.empty((0, self.embedder.dim), dtype=np.float32)
        elif not vectors_path.exists() or not metadata_path.exists():
            raise FileNotFoundError(
                f"Incomplete index at {self.index_dir}; run make index"
            )
        else:
            with metadata_path.open(encoding="utf-8") as fh:
                self.metadata = json.load(fh)
            vectors = np.load(vectors_path, allow_pickle=False)
        if (
            not isinstance(self.metadata, list)
            or not all(isinstance(item, dict) for item in self.metadata)
            or vectors.dtype != np.float32
            or vectors.ndim != 2
            or vectors.shape[0] != len(self.metadata)
            or vectors.shape[1] != self.embedder.dim
            or not np.isfinite(vectors).all()
        ):
            raise ValueError("Index artifacts are invalid or out of sync; run make index")

        self.index = faiss.IndexFlatIP(vectors.shape[1])
        self.index.add(np.ascontiguousarray(vectors))
        self.num_indexed = self.index.ntotal
        self.metadata_by_id = {
            novel.get("id"): novel
            for novel in self.metadata
            if novel.get("id") is not None
        }
        self.metadata_by_title = {}
        self.lexical_index: dict[str, set[int]] = {}
        self._title_keys: dict[str, set[int]] = {}
        for index, novel in enumerate(self.metadata):
            self.metadata_by_title.setdefault(
                str(novel.get("title", "")).casefold(), novel
            )
            for alias in novel.get("title_aliases") or []:
                self.metadata_by_title.setdefault(str(alias).casefold(), novel)
            for title in [novel.get("title", ""), *(novel.get("title_aliases") or [])]:
                title_key = "".join(_query_tokens(str(title)))
                if title_key:
                    self._title_keys.setdefault(title_key, set()).add(index)
            fields = [
                novel.get("title", ""),
                novel.get("author", ""),
                *(novel.get("title_aliases") or []),
                *(novel.get("tags") or []),
            ]
            for token in _query_tokens(" ".join(str(field) for field in fields)):
                self.lexical_index.setdefault(token, set()).add(index)
        self._query_cache: OrderedDict[tuple, tuple[list[dict], Optional[str]]] = (
            OrderedDict()
        )
        logger.info("Index loaded: %d novels", self.num_indexed)

    def _lexical_matches(self, query: str, limit: int) -> list[tuple[int, float, str]]:
        """Rank exact title, alias, author, and tag matches alongside semantic search."""
        query_key = "".join(_query_tokens(query))
        query_tokens = set(_query_tokens(query))
        if not query_tokens:
            return []
        candidates: set[int] = set()
        for token in query_tokens:
            candidates.update(self.lexical_index.get(token, set()))
        scores: list[tuple[int, float, str]] = []
        for index in candidates:
            novel = self.metadata[index]
            title = str(novel.get("title", ""))
            aliases = [str(alias) for alias in (novel.get("title_aliases") or [])]
            title_keys = {"".join(_query_tokens(value)) for value in [title, *aliases]}
            title_tokens = set(_query_tokens(" ".join([title, *aliases])))
            author_tokens = set(_query_tokens(str(novel.get("author", ""))))
            tag_tokens = set(_query_tokens(" ".join(map(str, novel.get("tags") or []))))
            matched_title = len(query_tokens & title_tokens)
            matched_author = len(query_tokens & author_tokens)
            matched_tags = len(query_tokens & tag_tokens)
            if query_key and query_key in title_keys:
                scores.append((index, 10.0, "Exact title or title variant"))
            else:
                score = matched_title * 2.5 + matched_author * 1.5 + matched_tags
                if score:
                    parts = []
                    if matched_title:
                        parts.append("title")
                    if matched_author:
                        parts.append("author")
                    if matched_tags:
                        parts.append("tags")
                    scores.append((index, score, "Matched " + ", ".join(parts)))
        return sorted(scores, key=lambda item: item[1], reverse=True)[:limit]

    def _typo_match(self, query: str) -> int | None:
        key = "".join(_query_tokens(query))
        if len(key) < 6 or key in self._title_keys:
            return None
        matching_novels: set[int] = set()
        for title, indices in self._title_keys.items():
            if _one_edit_apart(key, title):
                matching_novels.update(indices)
                if len(matching_novels) > 1:
                    return None
        return next(iter(matching_novels), None)

    def _vector_candidates(self, query: str, limit: int) -> dict[int, dict]:
        # Torch-backed encoders can deadlock when invoked from an ad-hoc worker
        # thread. A single query encode is short and predictable, so keeping it
        # on the owning thread is both faster and more reliable here.
        query_vec = self.embedder.embed_one(build_query_text(query))
        # Already L2-normalised by Embedder; reshape for FAISS
        query_vec = query_vec.reshape(1, -1).astype(np.float32)

        distances, indices = self.index.search(query_vec, limit)

        candidates_by_index: dict[int, dict] = {}
        for dist, idx in zip(distances[0], indices[0]):
            if idx < 0:
                continue  # FAISS padding for small indexes
            novel = self.metadata[idx].copy()
            novel["vector_score"] = float(
                dist
            )  # inner product ≡ cosine when normalised
            novel["ranking_score"] = float(dist)
            novel["match_reason"] = "Semantic match"
            candidates_by_index[int(idx)] = novel
        return candidates_by_index

    # ------------------------------------------------------------------
    # Public search API
    # ------------------------------------------------------------------

    async def search(
        self,
        query: str,
        top_k: int = 8,
        filter_tags: list[str] | None = None,
        allowed_ids: set[int] | None = None,
        *,
        mode: SearchMode = "hybrid-typo",
        use_cache: bool = True,
    ) -> Tuple[list[dict], Optional[str]]:
        """
        Full pipeline search.

        The offline benchmark selects a ranking mode and bypasses the query cache.

        Returns:
            (results, rewritten_query)
            results: list of dicts with keys title, score, reason, synopsis, tags
            rewritten_query: retained as None for API compatibility
        """
        if self.num_indexed == 0:
            return [], None
        wanted_tags = tuple(
            sorted(
                {tag.casefold().strip() for tag in (filter_tags or []) if tag.strip()}
            )
        )
        cache_key = (mode, query.casefold().strip(), top_k, wanted_tags,
                     tuple(sorted(allowed_ids)) if allowed_ids is not None else None)
        cached = self._query_cache.get(cache_key) if use_cache else None
        if cached is not None:
            self._query_cache.move_to_end(cache_key)
            return cached

        rewritten_query: Optional[str] = None

        # ── 3. FAISS search (cosine via inner product on unit vectors) ───
        # A tag-constrained search may need to look beyond the nearest few
        # vectors. The local catalogue is small enough to filter the full search
        # result without making the UI feel slower.
        k_retrieve = (
            self.num_indexed
            if wanted_tags or allowed_ids is not None
            else min(max(top_k * 4, 40), self.num_indexed)
        )
        candidates_by_index = (
            {} if mode == "keyword" else self._vector_candidates(query, k_retrieve)
        )
        lexical_matches = [] if mode == "vector" else self._lexical_matches(query, k_retrieve)
        for index, lexical_score, reason in lexical_matches:
            novel = candidates_by_index.get(index, self.metadata[index].copy())
            novel.setdefault("vector_score", 0.0)
            lexical_rank = min(0.99, 0.44 + lexical_score * 0.055)
            novel["ranking_score"] = max(
                float(novel.get("ranking_score", 0.0)), lexical_rank
            )
            novel["match_reason"] = (
                reason if lexical_score >= 2 else novel.get("match_reason", reason)
            )
            candidates_by_index[index] = novel

        if mode == "hybrid-typo" and (index := self._typo_match(query)) is not None:
            novel = candidates_by_index.get(index, self.metadata[index].copy())
            novel["ranking_score"] = max(float(novel.get("ranking_score", 0.0)), 0.98)
            novel["match_reason"] = "Possible title typo"
            candidates_by_index[index] = novel

        candidates = sorted(
            candidates_by_index.values(),
            key=lambda novel: novel.get("ranking_score", 0),
            reverse=True,
        )
        if allowed_ids is not None:
            candidates = [novel for novel in candidates if novel.get("id") in allowed_ids]
        if wanted_tags:
            candidates = [
                novel
                for novel in candidates
                if set(wanted_tags).issubset(
                    {str(tag).casefold() for tag in novel.get("tags", [])}
                )
            ]

        if not candidates:
            return [], rewritten_query

        results = self._format_results(candidates)

        response = (results[:top_k], rewritten_query)
        if use_cache:
            self._query_cache[cache_key] = response
            self._query_cache.move_to_end(cache_key)
            if len(self._query_cache) > 128:
                self._query_cache.popitem(last=False)
        return response

    @staticmethod
    def _format_results(candidates: list[dict]) -> list[dict]:
        return [
            {
                "novel_id": novel.get("id"),
                "title": novel["title"],
                "score": round(
                    float(novel.get("ranking_score", novel.get("vector_score", 0.5))), 4
                ),
                "reason": novel.get("match_reason")
                or f"Semantic similarity: {novel.get('vector_score', 0):.3f}",
                "synopsis": ""
                if novel.get("hand_authored")
                else novel.get("synopsis", ""),
                "tags": novel.get("tags", []),
                "urls": novel.get("urls", []),
                "author": novel.get("author", ""),
                "cover_url": novel.get("cover_url", ""),
            }
            for novel in candidates
        ]

    # ------------------------------------------------------------------
    # Utility
    # ------------------------------------------------------------------

    def reload_index(self) -> None:
        """Hot-reload the index (e.g. after adding new novels)."""
        self._load_index()
