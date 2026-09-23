"""Conservative title canonicalisation for multi-source catalogue records."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter


_NOISE = re.compile(r"\b(novel|webnovel|light novel|chapter \d+)\b", re.IGNORECASE)


def clean_title(title: str) -> str:
    title = unicodedata.normalize("NFKC", title or "")
    return re.sub(r"\s+", " ", title).strip(" \t\n-–—:|")


def title_key(title: str) -> str:
    """A stable key that only merges obvious punctuation/case variants."""
    title = _NOISE.sub("", clean_title(title)).casefold()
    return re.sub(r"[^\w]+", "", title, flags=re.UNICODE)


def title_quality(title: str) -> float:
    """Prefer readable translated titles without asserting an uncertain rename."""
    text = clean_title(title)
    if not text or len(text) < 2 or len(text) > 180:
        return -100.0
    words = re.findall(r"[A-Za-z][A-Za-z'’-]*", text)
    alpha_share = sum(len(word) for word in words) / max(len(text), 1)
    # Natural translated titles often contain several short words. Do not let a
    # single romanised token win merely because it has no spaces.
    score = alpha_share * 1.2 + min(len(words), 12) * 0.25
    if re.search(r"\bchapter\b|read online", text, re.I):
        score -= 3
    if text == text.upper() and len(text) > 4:
        score -= 0.3
    return score


def choose_title(variants: list[str]) -> tuple[str, list[str]]:
    """Choose the strongest consensus spelling and preserve the rest as aliases."""
    cleaned = [clean_title(value) for value in variants if clean_title(value)]
    if not cleaned:
        return "Untitled", []
    counts = Counter(value.casefold() for value in cleaned)
    best = max(
        cleaned,
        key=lambda value: (
            counts[value.casefold()] * 2 + title_quality(value),
            -len(value),
        ),
    )
    aliases = list(
        dict.fromkeys(value for value in cleaned if value.casefold() != best.casefold())
    )
    return best, aliases
