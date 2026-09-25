#!/usr/bin/env python3
"""Back up or restore one installation's SQLite data and search artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

BACKEND_DIR = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))
from paths import DATA_DIR  # noqa: E402

DATABASES = ("catalogue.db", "library.db")
STATE_FILES = ("scraped_urls.txt", "scrape_state.json", "repair_history.json")
INDEX_FILES = ("index/vectors.npy", "index/metadata.json")
COVER_EXTENSIONS = {".jpg", ".webp", ".png", ".avif", ".gif"}


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _allowed(name: str) -> bool:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts:
        return False
    if name in DATABASES + STATE_FILES + INDEX_FILES:
        return True
    return (
        len(path.parts) == 2
        and path.parts[0] == "covers"
        and path.stem.isdecimal()
        and path.suffix.lower() in COVER_EXTENSIONS
    )


def _copy_database(source: Path, destination: Path) -> None:
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as original:
        with sqlite3.connect(destination) as snapshot:
            original.backup(snapshot)


def _check_index(stage: Path) -> None:
    catalogue = stage / "catalogue.db"
    metadata = stage / "index/metadata.json"
    vectors = stage / "index/vectors.npy"
    if metadata.exists() != vectors.exists():
        raise ValueError("Search index is incomplete; rebuild it before backup")
    if not catalogue.exists():
        return
    with sqlite3.connect(catalogue) as database:
        records = [json.loads(row[0]) for row in database.execute(
            "SELECT payload FROM novels ORDER BY position"
        )]
    if records and not metadata.exists():
        raise ValueError("Catalogue has records but no search index; run make index")
    if metadata.exists() and json.loads(metadata.read_text(encoding="utf-8")) != records:
        raise ValueError("Catalogue and search index differ; retry after the index job finishes")


def backup(destination: Path, data_dir: Path = DATA_DIR) -> None:
    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="novelist-backup-") as temporary:
        stage = Path(temporary)
        for name in DATABASES:
            source = data_dir / name
            if source.exists():
                _copy_database(source, stage / name)
        for name in STATE_FILES + INDEX_FILES:
            source = data_dir / name
            if source.is_file():
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        cover_dir = data_dir / "covers"
        if cover_dir.exists():
            for source in cover_dir.iterdir():
                if source.is_file() and _allowed(f"covers/{source.name}"):
                    target = stage / "covers" / source.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
        _check_index(stage)
        files = {str(path.relative_to(stage)): _digest(path)
                 for path in stage.rglob("*") if path.is_file()}
        if not files:
            raise ValueError("There is no state to back up")
        pending = destination.with_name(destination.name + ".tmp")
        try:
            with zipfile.ZipFile(pending, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for name in sorted(files):
                    archive.write(stage / name, name)
                archive.writestr("manifest.json", json.dumps({"version": 1, "sha256": files}, indent=2))
            os.replace(pending, destination)
        finally:
            pending.unlink(missing_ok=True)
    print(f"Saved {len(files)} files to {destination}")


def restore(source: Path, data_dir: Path = DATA_DIR) -> None:
    source = source.expanduser().resolve()
    data_dir = data_dir.expanduser().resolve()
    if data_dir.exists() and any(data_dir.iterdir()):
        raise ValueError(f"Restore target must be empty: {data_dir}")
    with zipfile.ZipFile(source) as archive:
        entries = archive.namelist()
        if len(entries) != len(set(entries)) or "manifest.json" not in entries:
            raise ValueError("Invalid backup archive")
        manifest = json.loads(archive.read("manifest.json"))
        files = manifest.get("sha256", {})
        if manifest.get("version") != 1 or not isinstance(files, dict):
            raise ValueError("Unsupported backup manifest")
        if set(entries) != set(files) | {"manifest.json"} or not all(_allowed(name) for name in files):
            raise ValueError("Unexpected file in backup archive")
        with tempfile.TemporaryDirectory(prefix="novelist-restore-") as temporary:
            stage = Path(temporary)
            for name, expected in files.items():
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as input_file, target.open("wb") as output_file:
                    shutil.copyfileobj(input_file, output_file)
                if _digest(target) != expected:
                    raise ValueError(f"Backup checksum failed: {name}")
            _check_index(stage)
            data_dir.mkdir(parents=True, exist_ok=True)
            for name in files:
                target = data_dir / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(stage / name, target)
    print(f"Restored {len(files)} files to {data_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("backup", "restore"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    args = parser.parse_args()
    try:
        if args.action == "backup":
            backup(args.archive, args.data_dir)
        else:
            restore(args.archive, args.data_dir)
    except (OSError, ValueError, sqlite3.Error, zipfile.BadZipFile) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
