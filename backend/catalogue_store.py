"""Local SQLite storage for catalogue metadata."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import sqlite3
from pathlib import Path

from paths import DATA_DIR

DB_PATH = DATA_DIR / "catalogue.db"
LEGACY_JSON_PATH = DB_PATH.parent / "novels.json"


@contextmanager
def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.execute("PRAGMA busy_timeout=30000")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS novels (id INTEGER PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL)"
    )
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def load_records() -> list[dict]:
    with _connect() as connection:
        rows = connection.execute("SELECT payload FROM novels ORDER BY position").fetchall()
    return [json.loads(row[0]) for row in rows]


def save_records(records: list[dict]) -> None:
    identifiers = [record.get("id") for record in records]
    if len(set(identifiers)) != len(identifiers) or any(
        not isinstance(identifier, int) or identifier <= 0 for identifier in identifiers
    ):
        raise ValueError("Catalogue records need unique positive integer IDs")
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM novels")
        connection.executemany(
            "INSERT INTO novels (id, position, payload) VALUES (?, ?, ?)",
            (
                (record["id"], position, json.dumps(record, ensure_ascii=False))
                for position, record in enumerate(records)
            ),
        )


def import_json(path: Path = LEGACY_JSON_PATH) -> int:
    records = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(records, list) or not all(isinstance(item, dict) for item in records):
        raise ValueError("Expected a JSON array of catalogue records")
    if load_records():
        raise ValueError("Catalogue database already contains records; import requires an empty database")
    save_records(records)
    return len(records)


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a local catalogue JSON file into SQLite")
    parser.add_argument("--from-json", type=Path, default=LEGACY_JSON_PATH)
    args = parser.parse_args()
    print(f"Imported {import_json(args.from_json)} records into {DB_PATH}")


if __name__ == "__main__":
    main()
