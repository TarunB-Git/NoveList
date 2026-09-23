"""Administrator-controlled catalogue editing backed by SQLite."""

from __future__ import annotations

from contextlib import contextmanager
import fcntl
import re
import threading
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

from catalogue_store import load_records, save_records

LOCK_PATH = Path(__file__).parent / "data" / "catalogue.lock"
_LOCK = threading.RLock()


@contextmanager
def _catalogue_file_lock():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _title_key(value: str) -> str:
    text = unicodedata.normalize("NFKC", value or "").casefold()
    return re.sub(r"[^\w]+", "", text, flags=re.UNICODE)


def _valid_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _clean_links(values: list[dict]) -> list[dict]:
    links: list[dict] = []
    known: set[str] = set()
    for value in values:
        url = str(value.get("url") or "").strip()
        if not url or url in known:
            continue
        if not _valid_url(url):
            raise ValueError(f"Invalid source URL: {url[:100]}")
        known.add(url)
        site = str(
            value.get("site") or urlparse(url).netloc.removeprefix("www.")
        ).strip()[:80]
        links.append({"site": site, "url": url})
    return links


def _clean_payload(payload: dict) -> dict:
    title = re.sub(r"\s+", " ", str(payload.get("title") or "")).strip()
    if not title or len(title) > 300:
        raise ValueError("Title must contain 1 to 300 characters")
    cover_url = str(payload.get("cover_url") or "").strip()
    if cover_url and not _valid_url(cover_url):
        raise ValueError("Cover URL must be an HTTP or HTTPS address")
    tags = list(
        dict.fromkeys(
            re.sub(r"\s+", " ", str(tag)).strip()
            for tag in payload.get("tags", [])
            if str(tag).strip()
        )
    )[:100]
    aliases = list(
        dict.fromkeys(
            re.sub(r"\s+", " ", str(alias)).strip()
            for alias in payload.get("title_aliases", [])
            if str(alias).strip() and _title_key(str(alias)) != _title_key(title)
        )
    )[:30]
    return {
        "title": title,
        "title_aliases": aliases,
        "author": re.sub(r"\s+", " ", str(payload.get("author") or "")).strip()[:300],
        "synopsis": str(payload.get("synopsis") or "").strip()[:20_000],
        "tags": tags,
        "source": re.sub(r"\s+", " ", str(payload.get("source") or "")).strip()[:120],
        "status": re.sub(r"\s+", " ", str(payload.get("status") or "")).strip()[:80],
        "cover_url": cover_url,
        "urls": _clean_links(payload.get("urls") or []),
        "hand_authored": False,
    }


def _load() -> list[dict]:
    return load_records()


def _save(novels: list[dict]) -> None:
    save_records(novels)


def create_record(payload: dict) -> dict:
    record = _clean_payload(payload)
    with _LOCK, _catalogue_file_lock():
        novels = _load()
        key = _title_key(record["title"])
        for novel in novels:
            if key in {
                _title_key(novel.get("title", "")),
                *(_title_key(alias) for alias in novel.get("title_aliases", [])),
            }:
                raise ValueError(
                    f"A catalogue record already uses this title (#{novel.get('id')})"
                )
        record["id"] = (
            max((int(novel.get("id") or 0) for novel in novels), default=0) + 1
        )
        novels.append(record)
        _save(novels)
    return record


def update_record(novel_id: int, payload: dict) -> tuple[dict, str]:
    record = _clean_payload(payload)
    with _LOCK, _catalogue_file_lock():
        novels = _load()
        index = next(
            (
                position
                for position, novel in enumerate(novels)
                if novel.get("id") == novel_id
            ),
            None,
        )
        if index is None:
            raise KeyError(novel_id)
        key = _title_key(record["title"])
        for novel in novels:
            if novel.get("id") == novel_id:
                continue
            if key in {
                _title_key(novel.get("title", "")),
                *(_title_key(alias) for alias in novel.get("title_aliases", [])),
            }:
                raise ValueError(
                    f"Another catalogue record already uses this title (#{novel.get('id')})"
                )
        old_cover = str(novels[index].get("cover_url") or "")
        record["id"] = novel_id
        novels[index] = record
        _save(novels)
    return record, old_cover
