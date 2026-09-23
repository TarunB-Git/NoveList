"""Fetch, validate, cache, and serve catalogue cover images."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

COVERS_DIR = Path(__file__).parent / "data" / "covers"
COVERS_DIR.mkdir(parents=True, exist_ok=True)
_EXTENSIONS = (".jpg", ".webp", ".png", ".avif", ".gif")
_DEFAULT_COVER_HOSTS = frozenset({
    "novelfull.com",
    "www.royalroadcdn.com",
    "m.media-amazon.com",
    "www.royalroad.com",
    "novelfire.net",
    "dryofg8nmyqjw.cloudfront.net",
    "book-pic.webnovel.com",
})


def _allowed_cover_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    extra_hosts = {
        host.strip().casefold()
        for host in os.getenv("COVER_EXTRA_HOSTS", "").split(",")
        if host.strip()
    }
    return (
        parsed.scheme == "https"
        and parsed.hostname is not None
        and parsed.hostname.casefold() in (_DEFAULT_COVER_HOSTS | extra_hosts)
        and parsed.username is None
        and parsed.password is None
    )



_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def cover_path(novel_id: int) -> Path:
    """Return the local filesystem path for a novel's cached cover."""
    return COVERS_DIR / f"{novel_id}.jpg"


def cover_path_webp(novel_id: int) -> Path:
    return COVERS_DIR / f"{novel_id}.webp"


def is_cached(novel_id: int) -> bool:
    return cover_path(novel_id).exists() or cover_path_webp(novel_id).exists()


def get_cached_path(novel_id: int) -> Optional[Path]:
    for suffix in _EXTENSIONS:
        p = COVERS_DIR / f"{novel_id}{suffix}"
        if p.exists():
            return p
    return None


def fetch_and_cache(novel_id: int, url: str, timeout: int = 15) -> Optional[Path]:
    """
    Download cover image from `url` and save to local cache.
    Returns the cached Path on success, None on failure.
    """
    import requests

    cached = get_cached_path(novel_id)
    if cached:
        return cached

    if not _allowed_cover_url(url):
        logger.warning("Cover URL is not on the allowed HTTPS host list")
        return None

    try:
        headers = {
            "User-Agent": _UA,
            "Referer": _extract_base(url),
            "Accept": "image/webp,image/avif,image/*,*/*;q=0.8",
        }
        resp = requests.get(
            url, headers=headers, timeout=timeout, stream=True, allow_redirects=False
        )
        if 300 <= resp.status_code < 400:
            raise ValueError("cover source redirected to another URL")
        resp.raise_for_status()

        content_type = resp.headers.get("content-type", "").casefold()
        if not content_type.startswith("image/"):
            raise ValueError(f"remote response was {content_type or 'not an image'}")
        ext = (
            ".webp"
            if "webp" in content_type
            else ".png"
            if "png" in content_type
            else ".avif"
            if "avif" in content_type
            else ".gif"
            if "gif" in content_type
            else ".jpg"
        )
        dest = COVERS_DIR / f"{novel_id}{ext}"
        pending = dest.with_suffix(dest.suffix + ".part")

        downloaded = 0
        with open(pending, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=8192):
                downloaded += len(chunk)
                if downloaded > 8 * 1024 * 1024:
                    raise ValueError("cover exceeded the 8 MB limit")
                fh.write(chunk)
        if downloaded < 512:
            raise ValueError("cover response was empty")
        pending.replace(dest)

        size_kb = dest.stat().st_size / 1024
        logger.info(
            "Cached cover for novel #%d → %s (%.0f KB)", novel_id, dest.name, size_kb
        )
        return dest

    except Exception as exc:
        for partial in COVERS_DIR.glob(f"{novel_id}.*.part"):
            partial.unlink(missing_ok=True)
        logger.warning(
            "Cover fetch failed for novel #%d from %s: %s", novel_id, url[:60], exc
        )
        return None


def delete_cached(novel_id: int) -> bool:
    """Delete locally cached cover. Returns True if a file was removed."""
    for suffix in _EXTENSIONS:
        p = COVERS_DIR / f"{novel_id}{suffix}"
        if p.exists():
            p.unlink()
            logger.info("Deleted cached cover for novel #%d", novel_id)
            return True
    return False


def cache_stats() -> dict:
    """Return stats about the local cover cache."""
    files = [path for suffix in _EXTENSIONS for path in COVERS_DIR.glob(f"*{suffix}")]
    total_bytes = sum(f.stat().st_size for f in files)
    return {
        "cached_count": len(files),
        "total_size_mb": round(total_bytes / 1024 / 1024, 2),
        "avg_size_kb": round(total_bytes / max(len(files), 1) / 1024, 1),
    }


def _extract_base(url: str) -> str:
    from urllib.parse import urlparse

    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"
