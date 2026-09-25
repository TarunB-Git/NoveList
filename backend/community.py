"""Shared collections, discussion, reader analytics, and ingestion request data."""

from __future__ import annotations

from collections import Counter
import os
from pathlib import Path
import time
from typing import Any

from collection import DATA_DIR, connection, list_items, now, profile
from paths import INDEX_DIR

_storage_cache: tuple[float, dict[str, Any]] | None = None


def initialise_community() -> None:
    with connection() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS shared_collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
            visibility TEXT NOT NULL DEFAULT 'public',created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shared_collection_items (
            collection_id INTEGER NOT NULL,novel_id INTEGER NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',cover_url TEXT,
            tier TEXT,position INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(collection_id,novel_id)
        );
        CREATE TABLE IF NOT EXISTS collection_follows (collection_id INTEGER NOT NULL,user_id INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(collection_id,user_id));
        CREATE TABLE IF NOT EXISTS novel_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT,novel_id INTEGER NOT NULL,user_id INTEGER NOT NULL,rating INTEGER,body TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS collection_comments (id INTEGER PRIMARY KEY AUTOINCREMENT,collection_id INTEGER NOT NULL,user_id INTEGER NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS novel_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,query TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scrape_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,source TEXT NOT NULL,limit_count INTEGER NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        """)
        conn.execute("UPDATE shared_collection_items SET tier='C' WHERE tier IS NULL")


def reader_analytics(user_id: int) -> dict[str, Any]:
    items = list_items(user_id)
    summary = profile(user_id)
    authors = Counter(item["author"] for item in items if item.get("author"))
    source = Counter(item["status"] for item in items)
    return {
        **summary,
        "authors": [name for name, _ in authors.most_common(5)],
        "active_count": source.get("reading", 0) + source.get("continue", 0),
        "completion_rate": round(
            100 * source.get("completed", 0) / max(len(items), 1), 1
        ),
    }


def storage_usage() -> dict[str, Any]:
    global _storage_cache
    if _storage_cache and time.monotonic() - _storage_cache[0] < 15:
        return dict(_storage_cache[1])
    targets = {
        "catalogue": DATA_DIR / "catalogue.db",
        "library": DATA_DIR / "library.db",
        "covers": DATA_DIR / "covers",
        "index": INDEX_DIR,
    }
    sizes = {}
    for name, target in targets.items():
        sizes[name] = (
            sum(path.stat().st_size for path in target.rglob("*") if path.is_file())
            if target.is_dir()
            else (target.stat().st_size if target.exists() else 0)
        )
    model_roots = [
        Path(
            os.getenv(
                "SENTENCE_TRANSFORMERS_HOME", "~/.cache/torch/sentence_transformers"
            )
        ).expanduser(),
        Path("~/.cache/huggingface/hub").expanduser(),
    ]
    sizes["models"] = sum(
        sum(path.stat().st_size for path in root.rglob("*") if path.is_file())
        for root in model_roots
        if root.exists()
    )
    sizes["total"] = sum(sizes.values())
    result = {key: round(value / 1024 / 1024, 2) for key, value in sizes.items()}
    _storage_cache = (time.monotonic(), result)
    return dict(result)


def featured_favorites(limit: int = 12) -> list[dict[str, Any]]:
    """Return a rotating public shelf of readers' confirmed S-tier titles."""
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT li.novel_id,MAX(li.title) title,MAX(li.author) author,MAX(li.cover_url) cover_url,
                   MIN(u.username) username,COUNT(*) favorite_count
            FROM library_items li JOIN users u ON u.id=li.user_id
            WHERE li.tier='S' AND COALESCE(li.tier_source,'')!='suggested'
            GROUP BY li.novel_id ORDER BY RANDOM() LIMIT ?
        """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def public_reader_profile(username: str) -> dict[str, Any]:
    """Expose aggregate reading taste without leaking private session data."""
    with connection() as conn:
        user = conn.execute(
            "SELECT id,username,created_at FROM users WHERE username=?",
            (username.casefold(),),
        ).fetchone()
        if not user:
            raise KeyError(username)
        status_rows = conn.execute(
            "SELECT status,COUNT(*) count FROM library_items WHERE user_id=? GROUP BY status",
            (user["id"],),
        ).fetchall()
        tier_rows = conn.execute(
            "SELECT tier,COUNT(*) count FROM library_items WHERE user_id=? AND tier IS NOT NULL GROUP BY tier",
            (user["id"],),
        ).fetchall()
        favorites = conn.execute(
            """
            SELECT novel_id,title,author,cover_url FROM library_items
            WHERE user_id=? AND tier='S' AND COALESCE(tier_source,'')!='suggested'
            ORDER BY tier_position,title LIMIT 24
        """,
            (user["id"],),
        ).fetchall()
    summary = profile(user["id"])
    return {
        "username": user["username"],
        "joined_at": user["created_at"],
        "library_count": summary["library_count"],
        "favorite_tags": summary["favorite_tags"],
        "status_counts": {row["status"]: row["count"] for row in status_rows},
        "tier_counts": {row["tier"]: row["count"] for row in tier_rows},
        "favorites": [dict(row) for row in favorites],
    }


def create_collection(
    user_id: int, name: str, description: str, visibility: str = "public"
) -> dict:
    if not name.strip() or len(name) > 80:
        raise ValueError("Collection names must be 1–80 characters")
    if visibility not in {"public", "private"}:
        raise ValueError("Invalid visibility")
    with connection() as conn:
        cursor = conn.execute(
            "INSERT INTO shared_collections (user_id,name,description,visibility,created_at) VALUES (?,?,?,?,?)",
            (user_id, name.strip(), description.strip()[:500], visibility, now()),
        )
        return get_collection(cursor.lastrowid, user_id, conn)


def get_collection(collection_id: int, viewer_id: int | None = None, conn=None) -> dict:
    owned = conn is None
    if owned:
        context = connection()
        conn = context.__enter__()
    try:
        row = conn.execute(
            """SELECT c.*,u.username,COUNT(DISTINCT f.user_id) followers FROM shared_collections c JOIN users u ON u.id=c.user_id
                         LEFT JOIN collection_follows f ON f.collection_id=c.id WHERE c.id=? GROUP BY c.id""",
            (collection_id,),
        ).fetchone()
        if not row:
            raise KeyError(collection_id)
        if row["visibility"] == "private" and viewer_id != row["user_id"]:
            raise PermissionError
        data = dict(row)
        data["items"] = [
            dict(item)
            for item in conn.execute(
                "SELECT * FROM shared_collection_items WHERE collection_id=? ORDER BY tier,position",
                (collection_id,),
            ).fetchall()
        ]
        data["following"] = bool(
            viewer_id
            and conn.execute(
                "SELECT 1 FROM collection_follows WHERE collection_id=? AND user_id=?",
                (collection_id, viewer_id),
            ).fetchone()
        )
        return data
    finally:
        if owned:
            context.__exit__(None, None, None)


def list_collections(viewer_id: int | None = None) -> list[dict]:
    with connection() as conn:
        viewer = viewer_id or -1
        rows = conn.execute(
            """SELECT c.id,c.name,c.description,c.visibility,c.user_id,c.created_at,u.username,COUNT(f.user_id) followers,
            EXISTS(SELECT 1 FROM collection_follows mine WHERE mine.collection_id=c.id AND mine.user_id=?) following
            FROM shared_collections c JOIN users u ON u.id=c.user_id LEFT JOIN collection_follows f ON f.collection_id=c.id
            WHERE c.visibility='public' OR c.user_id=? GROUP BY c.id ORDER BY c.created_at DESC""",
            (viewer, viewer),
        ).fetchall()
    return [dict(row) for row in rows]


def add_to_collection(user_id: int, collection_id: int, novel_id: int) -> None:
    with connection() as conn:
        owner = conn.execute(
            "SELECT user_id FROM shared_collections WHERE id=?", (collection_id,)
        ).fetchone()
        if not owner:
            raise KeyError(collection_id)
        if owner["user_id"] != user_id:
            raise PermissionError
        book = conn.execute(
            "SELECT title,author,cover_url,tier FROM library_items WHERE user_id=? AND novel_id=?",
            (user_id, novel_id),
        ).fetchone()
        if not book:
            raise KeyError(novel_id)
        position = conn.execute(
            "SELECT COALESCE(MAX(position),-1)+1 FROM shared_collection_items WHERE collection_id=?",
            (collection_id,),
        ).fetchone()[0]
        conn.execute(
            "INSERT OR REPLACE INTO shared_collection_items (collection_id,novel_id,title,author,cover_url,tier,position) VALUES (?,?,?,?,?,?,?)",
            (
                collection_id,
                novel_id,
                book["title"],
                book["author"],
                book["cover_url"],
                book["tier"] or "C",
                position,
            ),
        )


def move_collection_item(
    user_id: int,
    collection_id: int,
    novel_id: int,
    tier: str,
    ordered_novel_ids: list[int],
) -> None:
    if tier not in {"S", "A", "B", "C", "D"}:
        raise ValueError("Invalid tier")
    with connection() as conn:
        collection = conn.execute(
            "SELECT user_id FROM shared_collections WHERE id=?", (collection_id,)
        ).fetchone()
        if not collection:
            raise KeyError(collection_id)
        if collection["user_id"] != user_id:
            raise PermissionError
        item = conn.execute(
            "SELECT tier FROM shared_collection_items WHERE collection_id=? AND novel_id=?",
            (collection_id, novel_id),
        ).fetchone()
        if not item:
            raise KeyError(novel_id)
        expected = [
            row[0]
            for row in conn.execute(
                "SELECT novel_id FROM shared_collection_items WHERE collection_id=? AND tier=? AND novel_id!=?",
                (collection_id, tier, novel_id),
            )
        ]
        order = [int(value) for value in ordered_novel_ids]
        if (
            novel_id not in order
            or set(order) != set([*expected, novel_id])
            or len(order) != len(set(order))
        ):
            raise ValueError("Tier order does not match collection items")
        old_tier = item["tier"]
        conn.execute(
            "UPDATE shared_collection_items SET tier=? WHERE collection_id=? AND novel_id=?",
            (tier, collection_id, novel_id),
        )
        for position, item_id in enumerate(order):
            conn.execute(
                "UPDATE shared_collection_items SET position=? WHERE collection_id=? AND novel_id=?",
                (position, collection_id, item_id),
            )
        if old_tier and old_tier != tier:
            old_rows = conn.execute(
                "SELECT novel_id FROM shared_collection_items WHERE collection_id=? AND tier=? ORDER BY position,novel_id",
                (collection_id, old_tier),
            ).fetchall()
            for position, row in enumerate(old_rows):
                conn.execute(
                    "UPDATE shared_collection_items SET position=? WHERE collection_id=? AND novel_id=?",
                    (position, collection_id, row["novel_id"]),
                )


def follow_collection(user_id: int, collection_id: int, following: bool) -> None:
    with connection() as conn:
        collection = conn.execute(
            "SELECT user_id,visibility FROM shared_collections WHERE id=?",
            (collection_id,),
        ).fetchone()
        if not collection:
            raise KeyError(collection_id)
        if collection["visibility"] == "private" and collection["user_id"] != user_id:
            raise PermissionError
        if following:
            conn.execute(
                "INSERT OR IGNORE INTO collection_follows VALUES (?,?,?)",
                (collection_id, user_id, now()),
            )
        else:
            conn.execute(
                "DELETE FROM collection_follows WHERE collection_id=? AND user_id=?",
                (collection_id, user_id),
            )


def add_collection_comment(user_id: int, collection_id: int, body: str) -> dict:
    if not body.strip() or len(body) > 2000:
        raise ValueError("Comments must be 1–2,000 characters")
    with connection() as conn:
        collection = conn.execute(
            "SELECT user_id,visibility FROM shared_collections WHERE id=?",
            (collection_id,),
        ).fetchone()
        if not collection:
            raise KeyError(collection_id)
        if collection["visibility"] == "private" and collection["user_id"] != user_id:
            raise PermissionError
        cursor = conn.execute(
            "INSERT INTO collection_comments (collection_id,user_id,body,created_at) VALUES (?,?,?,?)",
            (collection_id, user_id, body.strip(), now()),
        )
        return dict(
            conn.execute(
                "SELECT c.*,u.username FROM collection_comments c JOIN users u ON u.id=c.user_id WHERE c.id=?",
                (cursor.lastrowid,),
            ).fetchone()
        )


def collection_comments(collection_id: int) -> list[dict]:
    with connection() as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT c.*,u.username FROM collection_comments c JOIN users u ON u.id=c.user_id WHERE collection_id=? ORDER BY created_at DESC",
                (collection_id,),
            ).fetchall()
        ]


def add_review(user_id: int, novel_id: int, rating: int | None, body: str) -> dict:
    if rating is not None and rating not in range(1, 6):
        raise ValueError("Rating must be between 1 and 5")
    if not body.strip() or len(body) > 2000:
        raise ValueError("Reviews must be 1–2,000 characters")
    with connection() as conn:
        cursor = conn.execute(
            "INSERT INTO novel_reviews (novel_id,user_id,rating,body,created_at) VALUES (?,?,?,?,?)",
            (novel_id, user_id, rating, body.strip(), now()),
        )
        return dict(
            conn.execute(
                "SELECT r.*,u.username FROM novel_reviews r JOIN users u ON u.id=r.user_id WHERE r.id=?",
                (cursor.lastrowid,),
            ).fetchone()
        )


def reviews(novel_id: int) -> list[dict]:
    with connection() as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT r.*,u.username FROM novel_reviews r JOIN users u ON u.id=r.user_id WHERE novel_id=? ORDER BY created_at DESC",
                (novel_id,),
            ).fetchall()
        ]


def request_novel(user_id: int, query: str, note: str) -> None:
    if not query.strip() or len(query) > 300:
        raise ValueError("Request a title or concise description")
    with connection() as conn:
        conn.execute(
            "INSERT INTO novel_requests (user_id,query,note,created_at) VALUES (?,?,?,?)",
            (user_id, query.strip(), note.strip()[:1000], now()),
        )


def list_novel_requests(limit: int = 100) -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            """SELECT r.*,u.username FROM novel_requests r JOIN users u ON u.id=r.user_id
                             ORDER BY r.created_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def set_novel_request_status(request_id: int, status: str) -> dict:
    if status not in {"open", "collecting", "resolved", "declined"}:
        raise ValueError("Invalid request status")
    with connection() as conn:
        cursor = conn.execute(
            "UPDATE novel_requests SET status=? WHERE id=?", (status, request_id)
        )
        if not cursor.rowcount:
            raise KeyError(request_id)
        return dict(
            conn.execute(
                "SELECT * FROM novel_requests WHERE id=?", (request_id,)
            ).fetchone()
        )
