#!/usr/bin/env python
"""
add_novels.py — Add / update novels in the dataset and rebuild the index.

Merge behaviour (important):
  - New title          → add as new entry
  - Existing title, hand_authored=True  → replace synopsis + tags with scraped data,
                                          add URL, clear hand_authored flag.
                                          (The original 92 use seeded descriptions;
                                           scraped source data is preferred.)
  - Existing title, hand_authored=False → merge URLs only (data already real)

Usage:
    python scripts/add_novels.py --file new_novels.json
    python scripts/add_novels.py --interactive
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import logging
import subprocess
import sys
from pathlib import Path

from title_normalizer import choose_title, title_key

BACKEND_DIR = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))
from catalogue_store import load_records, save_records  # noqa: E402

LOCK_PATH = BACKEND_DIR / "data" / "catalogue.lock"

logging.basicConfig(level=logging.INFO, format="%(levelname)-8s | %(message)s")
logger = logging.getLogger("add_novels")

REQUIRED_FIELDS = {"title", "synopsis", "tags"}


def validate_novel(obj: dict, idx: int) -> list[str]:
    errors = []
    for field in REQUIRED_FIELDS:
        if field not in obj or not obj[field]:
            errors.append(f"  Novel #{idx}: missing '{field}'")
    if "tags" in obj and not isinstance(obj["tags"], list):
        errors.append(f"  Novel #{idx}: 'tags' must be a list")
    return errors


def load_dataset() -> list[dict]:
    return load_records()


def save_dataset(novels: list[dict]) -> None:
    for index, novel in enumerate(novels, 1):
        novel["id"] = index
    save_records(novels)
    logger.info("Saved %d novels to the catalogue database", len(novels))


def _merge_urls(existing_urls: list, new_url: str, site: str) -> list:
    """Add a new {site, url} entry if the URL isn't already present."""
    if not new_url:
        return existing_urls
    known = {u.get("url") for u in existing_urls}
    if new_url not in known:
        existing_urls.append({"site": site, "url": new_url})
    return existing_urls


def _site_from_url(url: str) -> str:
    """Extract a short site label from a URL."""
    from urllib.parse import urlparse

    try:
        host = urlparse(url).netloc
        return host.replace("www.", "")
    except Exception:
        return url[:30]


def _metadata_score(novel: dict) -> int:
    """Prefer complete source metadata without replacing a useful record with a stub."""
    synopsis = str(novel.get("synopsis", "")).strip()
    return (
        min(len(synopsis), 1200)
        + 180 * bool(novel.get("author"))
        + 25 * len(novel.get("tags", []))
        + 120 * bool(novel.get("cover_url"))
    )


def _merge_metadata(current: dict, incoming: dict) -> bool:
    changed = False
    if incoming.get("author") and (
        not current.get("author")
        or current.get("author", "").casefold() in {"unknown", "n/a"}
    ):
        current["author"] = incoming["author"]
        changed = True
    incoming_tags = [
        str(tag).strip() for tag in incoming.get("tags", []) if str(tag).strip()
    ]
    merged_tags = list(dict.fromkeys([*current.get("tags", []), *incoming_tags]))
    if merged_tags != current.get("tags", []):
        current["tags"] = merged_tags
        changed = True
    if incoming.get("cover_url") and not current.get("cover_url"):
        current["cover_url"] = incoming["cover_url"]
        changed = True
    if (
        incoming.get("synopsis")
        and _metadata_score(incoming) > _metadata_score(current) + 80
    ):
        current["synopsis"] = incoming["synopsis"]
        current["source"] = incoming.get("source", current.get("source", ""))
        current["status"] = incoming.get("status", current.get("status", ""))
        changed = True
    return changed


@contextmanager
def catalogue_lock():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _add_novels(new_novels: list[dict], rebuild: bool = True) -> None:
    existing = load_dataset()
    title_index = {}
    for i, novel in enumerate(existing):
        title_index[title_key(novel["title"])] = i
        for alias in novel.get("title_aliases", []):
            title_index.setdefault(title_key(alias), i)

    added = 0
    updated = 0
    url_merged = 0
    title_normalised = 0

    for novel in new_novels:
        incoming_variants = [novel["title"], *(novel.get("title_aliases") or [])]
        incoming_keys = [
            title_key(value) for value in incoming_variants if title_key(value)
        ]
        raw_url = novel.get("url", "") or novel.get("source_url", "")
        site = _site_from_url(raw_url) if raw_url else novel.get("source", "")

        matched_key = next((key for key in incoming_keys if key in title_index), None)
        if matched_key is not None:
            idx = title_index[matched_key]
            curr = existing[idx]
            old_title, old_aliases = curr["title"], curr.get("title_aliases", [])
            canonical, aliases = choose_title(
                [curr["title"], *curr.get("title_aliases", []), *incoming_variants]
            )
            curr["title"] = canonical
            curr["title_aliases"] = aliases
            for key in [
                title_key(canonical),
                *(title_key(alias) for alias in aliases),
            ]:
                if key:
                    title_index[key] = idx
            if curr["title"] != old_title or curr["title_aliases"] != old_aliases:
                title_normalised += 1

            if curr.get("hand_authored", False):
                # Replace seeded data with source data
                curr["synopsis"] = novel["synopsis"]
                curr["author"] = novel.get("author", curr.get("author", ""))
                curr["tags"] = novel["tags"]
                curr["status"] = novel.get("status", curr.get("status", ""))
                curr["source"] = novel.get("source", curr.get("source", ""))
                curr["hand_authored"] = False
                curr["urls"] = _merge_urls(curr.get("urls", []), raw_url, site)
                # Update cover_url if we now have one and didn't before
                if novel.get("cover_url") and not curr.get("cover_url"):
                    curr["cover_url"] = novel["cover_url"]
                updated += 1
                logger.info("Updated (was hand-authored): %s", novel["title"][:60])
            else:
                # Keep source URLs, but also accept clearly richer metadata.
                before = len(curr.get("urls", []))
                curr["urls"] = _merge_urls(curr.get("urls", []), raw_url, site)
                if _merge_metadata(curr, novel):
                    updated += 1
                if len(curr.get("urls", [])) > before:
                    url_merged += 1
                    logger.debug("Merged URL for: %s", novel["title"][:60])
        else:
            # Brand new novel
            entry = {
                "title": novel["title"],
                "synopsis": novel["synopsis"],
                "author": novel.get("author", ""),
                "tags": novel["tags"],
                "source": novel.get("source", ""),
                "status": novel.get("status", ""),
                "hand_authored": False,
                "cover_url": novel.get("cover_url", ""),
                "urls": _merge_urls([], raw_url, site),
            }
            existing.append(entry)
            canonical, aliases = choose_title(incoming_variants)
            entry["title"] = canonical
            entry["title_aliases"] = aliases
            for key in [
                title_key(canonical),
                *(title_key(alias) for alias in aliases),
            ]:
                if key:
                    title_index[key] = len(existing) - 1
            added += 1

    if added == 0 and updated == 0 and url_merged == 0 and title_normalised == 0:
        logger.info("Nothing to do — all novels already in DB with current data.")
        return

    save_dataset(existing)
    logger.info(
        "Result: %d added, %d descriptions updated, %d title variants retained, "
        "%d URL-only merges. Total: %d novels.",
        added,
        updated,
        title_normalised,
        url_merged,
        len(existing),
    )

    if rebuild:
        logger.info("Rebuilding FAISS index…")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).parent / "build_index.py")],
            check=False,
        )
        if result.returncode != 0:
            logger.error("Index rebuild failed. Run: python scripts/build_index.py")
        else:
            logger.info("✅  Index rebuilt.")


def add_novels(new_novels: list[dict], rebuild: bool = True) -> None:
    """Merge metadata under a process-safe catalogue lock."""
    with catalogue_lock():
        _add_novels(new_novels, rebuild=rebuild)


def interactive_add() -> None:
    print("\n── Add a novel interactively ───────────────────")
    title = input("Title:    ").strip()
    synopsis = input("Synopsis: ").strip()
    tags_raw = input("Tags (comma-separated): ").strip()
    source = input("Source (e.g. Chinese Webnovel): ").strip()
    status = input("Status (Ongoing/Completed): ").strip()
    url = input("URL (optional): ").strip()

    novel = {
        "title": title,
        "synopsis": synopsis,
        "tags": [t.strip() for t in tags_raw.split(",") if t.strip()],
        "source": source,
        "status": status,
        "url": url,
    }
    errors = validate_novel(novel, 1)
    if errors:
        print("\n".join(errors))
        sys.exit(1)

    if input(f"\nAdd '{title}'? [y/N] ").strip().lower() == "y":
        add_novels([novel])
    else:
        print("Aborted.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Add novels to the search dataset")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--file", type=Path)
    group.add_argument("--interactive", action="store_true")
    parser.add_argument("--no-rebuild", action="store_true")
    args = parser.parse_args()

    if args.interactive:
        interactive_add()
        return

    if not args.file.exists():
        parser.error(f"File not found: {args.file}")

    with open(args.file, encoding="utf-8") as fh:
        new_novels = json.load(fh)

    if not isinstance(new_novels, list):
        parser.error("JSON file must contain an array")

    errors = []
    for i, n in enumerate(new_novels):
        errors.extend(validate_novel(n, i + 1))
    if errors:
        print("\n".join(errors))
        sys.exit(1)

    add_novels(new_novels, rebuild=not args.no_rebuild)


if __name__ == "__main__":
    main()
