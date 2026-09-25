"""Per-user library, ranking, and activity storage."""

from __future__ import annotations

import json
import sqlite3
from urllib.parse import urlparse
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from paths import DATA_DIR

DB_PATH = DATA_DIR / "library.db"
VALID_STATUSES = {
    "reading",
    "completed",
    "dropped",
    "plan_to_read",
    "continue",
    "paused",
}
VALID_TIERS = {"S", "A", "B", "C", "D"}
TIER_SCORES = {"S": 5.0, "A": 4.0, "B": 3.0, "C": 2.0, "D": 1.0}


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def initialise() -> None:
    with connection() as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(library_items)")}
        if columns and "user_id" not in columns:
            _migrate_library_to_users(conn)
        event_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(activity_events)")
        }
        if event_columns and "user_id" not in event_columns:
            conn.execute(
                "ALTER TABLE activity_events ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1"
            )
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS library_items (
                user_id INTEGER NOT NULL, novel_id INTEGER NOT NULL, title TEXT NOT NULL,
                author TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '',
                tags_json TEXT NOT NULL DEFAULT '[]', cover_url TEXT, status TEXT NOT NULL DEFAULT 'plan_to_read',
                personal_rating INTEGER,
                tier TEXT, tier_source TEXT, tier_position INTEGER, predicted_tier TEXT NOT NULL DEFAULT 'C',
                prediction_score REAL NOT NULL DEFAULT 3.0, prediction_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, novel_id)
            );
            CREATE TABLE IF NOT EXISTS activity_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 1, novel_id INTEGER,
                kind TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_library_user_status ON library_items(user_id, status);
            CREATE INDEX IF NOT EXISTS idx_library_user_tier ON library_items(user_id, tier, tier_position);
            CREATE INDEX IF NOT EXISTS idx_events_user_created ON activity_events(user_id, created_at);
        """)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(library_items)")}
        for name, definition in (
            ("author", "TEXT NOT NULL DEFAULT ''"),
            ("tier_source", "TEXT"),
            ("tier_position", "INTEGER"),
            ("prediction_reason", "TEXT NOT NULL DEFAULT ''"),
            ("personal_rating", "INTEGER"),
        ):
            if name not in columns:
                conn.execute(
                    f"ALTER TABLE library_items ADD COLUMN {name} {definition}"
                )
        _repair_tier_positions(conn)


def _migrate_library_to_users(conn: sqlite3.Connection) -> None:
    """Copy the pre-account library into the bootstrap admin account (user 1)."""
    conn.executescript("""
        CREATE TABLE library_items_new (
            user_id INTEGER NOT NULL, novel_id INTEGER NOT NULL, title TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
            cover_url TEXT, status TEXT NOT NULL DEFAULT 'plan_to_read', tier TEXT, tier_source TEXT,
            tier_position INTEGER, predicted_tier TEXT NOT NULL DEFAULT 'C', prediction_score REAL NOT NULL DEFAULT 3.0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, novel_id)
        );
        INSERT INTO library_items_new
        (user_id,novel_id,title,synopsis,tags_json,cover_url,status,tier,tier_source,tier_position,predicted_tier,prediction_score,created_at,updated_at)
        SELECT 1,novel_id,title,synopsis,tags_json,cover_url,status,tier,tier_source,tier_position,predicted_tier,prediction_score,created_at,updated_at
        FROM library_items;
        DROP TABLE library_items;
        ALTER TABLE library_items_new RENAME TO library_items;
    """)


def _event(
    conn: sqlite3.Connection, user_id: int, novel_id: int, kind: str, **detail: Any
) -> None:
    conn.execute(
        "INSERT INTO activity_events (user_id,novel_id,kind,detail_json,created_at) VALUES (?,?,?,?,?)",
        (user_id, novel_id, kind, json.dumps(detail), now()),
    )


def _repair_tier_positions(
    conn: sqlite3.Connection, user_id: int | None = None
) -> None:
    params: tuple[Any, ...] = () if user_id is None else (user_id,)
    where = "WHERE tier IS NOT NULL" + (" AND user_id=?" if user_id is not None else "")
    rows = conn.execute(
        f"SELECT user_id,novel_id,tier,tier_position FROM library_items {where} "
        "ORDER BY user_id,tier,COALESCE(tier_position,999999),created_at,novel_id",
        params,
    ).fetchall()
    positions: dict[tuple[int, str], int] = defaultdict(int)
    for row in rows:
        key = (row["user_id"], row["tier"])
        position = positions[key]
        positions[key] += 1
        if row["tier_position"] != position:
            conn.execute(
                "UPDATE library_items SET tier_position=? WHERE user_id=? AND novel_id=?",
                (position, row["user_id"], row["novel_id"]),
            )


def _tier_from_score(score: float) -> str:
    return (
        "S"
        if score >= 4.5
        else "A"
        if score >= 3.55
        else "B"
        if score >= 2.55
        else "C"
        if score >= 1.55
        else "D"
    )


def _row_to_item(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["tags"] = json.loads(item.pop("tags_json"))
    return item


def _catalogue_cover_url(url: str | None) -> str | None:
    """Return an HTTP(S) cover URL stored in the administrator-curated catalogue."""
    if not url:
        return None
    parsed = urlparse(url)
    return url if parsed.scheme in {"http", "https"} and parsed.netloc else None


def _next_position(conn: sqlite3.Connection, user_id: int, tier: str) -> int:
    return int(
        conn.execute(
            "SELECT COALESCE(MAX(tier_position),-1)+1 FROM library_items WHERE user_id=? AND tier=?",
            (user_id, tier),
        ).fetchone()[0]
    )


def predict(
    user_id: int,
    tags: list[str],
    status: str = "plan_to_read",
    exclude_novel_id: int | None = None,
) -> tuple[str, float, int, str]:
    with connection() as conn:
        rows = conn.execute(
            """SELECT novel_id,tags_json,tier,tier_source,status,personal_rating
            FROM library_items WHERE user_id=? AND (
                personal_rating IS NOT NULL OR (tier IS NOT NULL AND COALESCE(tier_source,'')!='suggested')
            )""",
            (user_id,),
        ).fetchall()
    all_scores, tagged = [], defaultdict(list)
    for row in rows:
        if row["novel_id"] == exclude_novel_id:
            continue
        tier_score = (
            TIER_SCORES.get(row["tier"]) if row["tier_source"] != "suggested" else None
        )
        rating_score = float(row["personal_rating"]) if row["personal_rating"] else None
        if tier_score is not None and rating_score is not None:
            score = (tier_score * 1.15 + rating_score) / 2.15
        else:
            score = tier_score if tier_score is not None else rating_score
        if score is None:
            continue
        weight = {
            "completed": 1.15,
            "dropped": 1.15,
            "reading": 0.8,
            "continue": 0.8,
            "paused": 0.65,
        }.get(row["status"], 0.5)
        all_scores.append((score, weight))
        for tag in json.loads(row["tags_json"]):
            tagged[str(tag).casefold()].append((score, weight))
    base = (
        sum(score * weight for score, weight in all_scores)
        / sum(weight for _, weight in all_scores)
        if all_scores
        else 3.0
    )
    matches = [value for tag in tags for value in tagged.get(str(tag).casefold(), [])]
    if matches:
        match_score = sum(score * weight for score, weight in matches) / sum(
            weight for _, weight in matches
        )
        score = (match_score * len(matches) + base * 3) / (len(matches) + 3)
        reason = f"Based on {len(matches)} matching tag signals and {len(all_scores)} ratings or direct placements."
    else:
        score = base
        reason = f"Based on your {len(all_scores)} ratings or direct placements; no strong shared tags yet."
    if status == "dropped":
        score = min(score, 2.0)
        reason += " Dropped titles start conservatively until you place them yourself."
    elif status in {"reading", "continue"}:
        reason += " In-progress titles are weighted cautiously."
    score = max(1.0, min(5.0, score))
    return _tier_from_score(score), round(score, 2), len(all_scores), reason


def save_item(
    user_id: int,
    novel: dict[str, Any],
    status: str | None = None,
    personal_rating: int | None = None,
) -> dict[str, Any]:
    if status is not None and status not in VALID_STATUSES:
        raise ValueError("Invalid status")
    if personal_rating is not None and personal_rating not in range(1, 6):
        raise ValueError("Rating must be between 1 and 5")
    novel_id = novel.get("id")
    if novel_id is None:
        raise ValueError("This novel cannot be saved because it has no identifier")
    with connection() as conn:
        existing = conn.execute(
            "SELECT * FROM library_items WHERE user_id=? AND novel_id=?",
            (user_id, novel_id),
        ).fetchone()
    effective_status = status or (existing["status"] if existing else "plan_to_read")
    rating_for_prediction = (
        personal_rating
        if personal_rating is not None
        else (existing["personal_rating"] if existing else None)
    )
    tags = novel.get("tags") or []
    prediction, score, sample, reason = predict(
        user_id, tags, effective_status, novel_id
    )
    if rating_for_prediction is not None:
        prediction = _tier_from_score(float(rating_for_prediction))
        score = float(rating_for_prediction)
        reason = f"Your {rating_for_prediction}/5 rating is direct placement feedback."
    timestamp = now()
    with connection() as conn:
        if existing:
            position = _next_position(conn, user_id, prediction)
            conn.execute(
                """UPDATE library_items SET title=?,author=?,synopsis=?,tags_json=?,cover_url=?,status=?,personal_rating=COALESCE(?,personal_rating),
                predicted_tier=?,prediction_score=?,prediction_reason=?,tier=CASE WHEN tier_source='suggested' THEN ? ELSE tier END,
                tier_position=CASE WHEN tier_source='suggested' THEN ? ELSE tier_position END,updated_at=? WHERE user_id=? AND novel_id=?""",
                (
                    novel.get("title", "Untitled"),
                    novel.get("author", ""),
                    novel.get("synopsis", ""),
                    json.dumps(tags),
                    novel.get("cover_url"),
                    effective_status,
                    personal_rating,
                    prediction,
                    score,
                    reason,
                    prediction,
                    position,
                    timestamp,
                    user_id,
                    novel_id,
                ),
            )
            if status is not None:
                _event(
                    conn, user_id, novel_id, "status_changed", status=effective_status
                )
            if personal_rating is not None:
                _event(
                    conn, user_id, novel_id, "rating_changed", rating=personal_rating
                )
        else:
            position = _next_position(conn, user_id, prediction)
            conn.execute(
                """INSERT INTO library_items
                (user_id,novel_id,title,author,synopsis,tags_json,cover_url,status,personal_rating,tier,tier_source,tier_position,predicted_tier,prediction_score,prediction_reason,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,'suggested',?,?,?,?,?,?)""",
                (
                    user_id,
                    novel_id,
                    novel.get("title", "Untitled"),
                    novel.get("author", ""),
                    novel.get("synopsis", ""),
                    json.dumps(tags),
                    novel.get("cover_url"),
                    effective_status,
                    personal_rating,
                    prediction,
                    position,
                    prediction,
                    score,
                    reason,
                    timestamp,
                    timestamp,
                ),
            )
            _event(
                conn,
                user_id,
                novel_id,
                "added_to_library",
                status=effective_status,
                rating=personal_rating,
                suggested_tier=prediction,
            )
        row = conn.execute(
            "SELECT * FROM library_items WHERE user_id=? AND novel_id=?",
            (user_id, novel_id),
        ).fetchone()
    if personal_rating is not None or (
        status is not None
        and existing
        and (
            existing["tier_source"] != "suggested"
            or existing["personal_rating"] is not None
        )
    ):
        refresh_suggested_items(user_id, exclude_novel_id=novel_id)
        with connection() as conn:
            row = conn.execute(
                "SELECT * FROM library_items WHERE user_id=? AND novel_id=?",
                (user_id, novel_id),
            ).fetchone()
    item = _row_to_item(row)
    item["prediction_sample_size"] = sample
    return item


def set_tier(
    user_id: int, novel_id: int, tier: str | None, confirm_prediction: bool = False
) -> dict[str, Any]:
    if tier is not None and tier not in VALID_TIERS:
        raise ValueError("Invalid tier")
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM library_items WHERE user_id=? AND novel_id=?",
            (user_id, novel_id),
        ).fetchone()
        if not row:
            raise KeyError(novel_id)
        selected = (tier or row["predicted_tier"]) if confirm_prediction else tier
        source = ("confirmed" if confirm_prediction else "chosen") if selected else None
        conn.execute(
            "UPDATE library_items SET tier=?,tier_source=?,tier_position=?,updated_at=? WHERE user_id=? AND novel_id=?",
            (
                selected,
                source,
                _next_position(conn, user_id, selected) if selected else None,
                now(),
                user_id,
                novel_id,
            ),
        )
        _event(
            conn,
            user_id,
            novel_id,
            "tier_confirmed" if confirm_prediction else "tier_changed",
            tier=selected,
        )
        result = conn.execute(
            "SELECT * FROM library_items WHERE user_id=? AND novel_id=?",
            (user_id, novel_id),
        ).fetchone()
    refresh_suggested_items(user_id)
    return _row_to_item(result)


def move_item(
    user_id: int, novel_id: int, tier: str, ordered_novel_ids: list[int]
) -> dict[str, Any]:
    if tier not in VALID_TIERS:
        raise ValueError("Invalid tier")
    with connection() as conn:
        item = conn.execute(
            "SELECT tier FROM library_items WHERE user_id=? AND novel_id=?",
            (user_id, novel_id),
        ).fetchone()
        if not item:
            raise KeyError(novel_id)
        expected = [
            r[0]
            for r in conn.execute(
                "SELECT novel_id FROM library_items WHERE user_id=? AND tier=? AND novel_id!=?",
                (user_id, tier, novel_id),
            )
        ]
        order = [int(value) for value in ordered_novel_ids]
        if (
            novel_id not in order
            or set(order) != set(expected + [novel_id])
            or len(order) != len(set(order))
        ):
            raise ValueError("Tier order does not match saved titles")
        conn.execute(
            "UPDATE library_items SET tier=?,tier_source='chosen',updated_at=? WHERE user_id=? AND novel_id=?",
            (tier, now(), user_id, novel_id),
        )
        for position, item_id in enumerate(order):
            conn.execute(
                "UPDATE library_items SET tier_position=? WHERE user_id=? AND novel_id=?",
                (position, user_id, item_id),
            )
        _repair_tier_positions(conn, user_id)
        _event(
            conn,
            user_id,
            novel_id,
            "tier_moved",
            tier=tier,
            position=order.index(novel_id),
        )
        result = conn.execute(
            "SELECT * FROM library_items WHERE user_id=? AND novel_id=?",
            (user_id, novel_id),
        ).fetchone()
    refresh_suggested_items(user_id)
    return _row_to_item(result)


def refresh_suggested_items(user_id: int, exclude_novel_id: int | None = None) -> None:
    with connection() as conn:
        rows = conn.execute(
            "SELECT novel_id,tags_json,status FROM library_items WHERE user_id=? AND tier_source='suggested'",
            (user_id,),
        ).fetchall()
    for row in rows:
        if row["novel_id"] == exclude_novel_id:
            continue
        tier, score, _, reason = predict(
            user_id, json.loads(row["tags_json"]), row["status"], row["novel_id"]
        )
        with connection() as conn:
            current = conn.execute(
                "SELECT tier,tier_position FROM library_items WHERE user_id=? AND novel_id=?",
                (user_id, row["novel_id"]),
            ).fetchone()
            pos = (
                current["tier_position"]
                if current["tier"] == tier
                else _next_position(conn, user_id, tier)
            )
            conn.execute(
                "UPDATE library_items SET tier=?,tier_position=?,predicted_tier=?,prediction_score=?,prediction_reason=?,updated_at=? WHERE user_id=? AND novel_id=? AND tier_source='suggested'",
                (tier, pos, tier, score, reason, now(), user_id, row["novel_id"]),
            )
    with connection() as conn:
        _repair_tier_positions(conn, user_id)


def list_items(user_id: int, status: str | None = None) -> list[dict[str, Any]]:
    with connection() as conn:
        sql = "SELECT * FROM library_items WHERE user_id=?"
        params = [user_id]
        if status:
            sql += " AND status=?"
            params.append(status)
        rows = conn.execute(sql + " ORDER BY updated_at DESC", params).fetchall()
    from covers import is_cached

    items = [_row_to_item(row) for row in rows]
    for item in items:
        item["cover_url"] = _catalogue_cover_url(item.get("cover_url"))
        item["cover_cached"] = bool(item["cover_url"]) and is_cached(item["novel_id"])
    return items


def sync_catalogue_metadata(novels: list[dict[str, Any]]) -> int:
    """Refresh saved copies after catalogue enrichment without touching reader state."""
    changed = 0
    with connection() as conn:
        for novel in novels:
            novel_id = novel.get("id")
            if novel_id is None:
                continue
            synopsis = (
                "" if novel.get("hand_authored") else str(novel.get("synopsis") or "")
            )
            cursor = conn.execute(
                """
                UPDATE library_items SET
                    title=?,
                    author=CASE WHEN ?!='' THEN ? ELSE author END,
                    synopsis=?,
                    tags_json=?,
                    cover_url=CASE WHEN ?!='' THEN ? ELSE cover_url END
                WHERE novel_id=?
            """,
                (
                    novel.get("title") or "Untitled",
                    novel.get("author") or "",
                    novel.get("author") or "",
                    synopsis,
                    json.dumps(novel.get("tags") or []),
                    novel.get("cover_url") or "",
                    novel.get("cover_url") or "",
                    novel_id,
                ),
            )
            changed += cursor.rowcount
    return changed


def profile(user_id: int) -> dict[str, Any]:
    items = list_items(user_id)
    statuses = Counter(item["status"] for item in items)
    tiers = Counter(item["tier"] for item in items if item["tier"])
    tags = Counter(
        tag for item in items if item["tier"] in {"S", "A"} for tag in item["tags"]
    )
    with connection() as conn:
        feedback = conn.execute(
            """SELECT COUNT(*) FROM library_items WHERE user_id=? AND (
            personal_rating IS NOT NULL OR (tier IS NOT NULL AND COALESCE(tier_source,'')!='suggested')
        )""",
            (user_id,),
        ).fetchone()[0]
        events = conn.execute(
            "SELECT COUNT(*) FROM activity_events WHERE user_id=?", (user_id,)
        ).fetchone()[0]
    return {
        "library_count": len(items),
        "status_counts": dict(statuses),
        "tier_counts": dict(tiers),
        "favorite_tags": [tag for tag, _ in tags.most_common(8)],
        "feedback_count": feedback,
        "event_count": events,
    }
