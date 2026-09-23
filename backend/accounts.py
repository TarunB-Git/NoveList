"""Local account and session helpers for the self-hosted service."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request

from collection import connection, now


SESSION_DAYS = 30


def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"{salt.hex()}${derived.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, value = stored.split("$", 1)
        return hmac.compare_digest(
            _hash_password(password, bytes.fromhex(salt_hex)).split("$", 1)[1], value
        )
    except ValueError:
        return False


def initialise_accounts() -> None:
    username = os.getenv("ADMIN_USERNAME", "admin").strip().lower()
    password = os.getenv("ADMIN_PASSWORD")
    with connection() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL, recovery_hash TEXT, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
        """)
        user_columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
        if "recovery_hash" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN recovery_hash TEXT")
        conn.execute("DELETE FROM sessions WHERE expires_at<=?", (now(),))
        if not conn.execute("SELECT 1 FROM users WHERE id=1").fetchone():
            if not password:
                raise RuntimeError("Set ADMIN_PASSWORD before the first server start")
            conn.execute(
                "INSERT INTO users (id,username,password_hash,role,created_at) VALUES (1,?,?,?,?)",
                (username, _hash_password(password), "admin", now()),
            )


def register(username: str, password: str) -> dict:
    username = username.strip().lower()
    if (
        not 3 <= len(username) <= 32
        or not username.replace("_", "").replace("-", "").isalnum()
    ):
        raise ValueError("Use 3–32 letters, numbers, hyphens, or underscores")
    if len(password) < 10:
        raise ValueError("Use a password with at least 10 characters")
    recovery_code = secrets.token_urlsafe(18)
    with connection() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO users (username,password_hash,recovery_hash,role,created_at) VALUES (?,?,?,?,?)",
                (
                    username,
                    _hash_password(password),
                    _hash_recovery_code(recovery_code),
                    "member",
                    now(),
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("That username is already in use") from exc
        return {
            "id": cursor.lastrowid,
            "username": username,
            "role": "member",
            "recovery_code": recovery_code,
        }


def _hash_recovery_code(value: str) -> str:
    return hashlib.sha256(value.strip().encode()).hexdigest()


def login(username: str, password: str) -> dict:
    with connection() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE username=?", (username.strip().lower(),)
        ).fetchone()
        if not user or not _verify_password(password, user["password_hash"]):
            raise ValueError("Incorrect username or password")
        token = secrets.token_urlsafe(32)
        expires = (
            (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS))
            .replace(microsecond=0)
            .isoformat()
        )
        conn.execute(
            "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), user["id"], expires, now()),
        )
        return {
            "token": token,
            "user": {
                "id": user["id"],
                "username": user["username"],
                "role": user["role"],
            },
        }


def logout(token: str) -> None:
    with connection() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE token_hash=?",
            (hashlib.sha256(token.encode()).hexdigest(),),
        )


def change_password(user_id: int, current_password: str, new_password: str) -> None:
    if len(new_password) < 10:
        raise ValueError("Use a password with at least 10 characters")
    with connection() as conn:
        row = conn.execute(
            "SELECT password_hash FROM users WHERE id=?", (user_id,)
        ).fetchone()
        if not row or not _verify_password(current_password, row["password_hash"]):
            raise ValueError("Current password is incorrect")
        conn.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (_hash_password(new_password), user_id),
        )
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


def rotate_recovery_code(user_id: int) -> str:
    recovery_code = secrets.token_urlsafe(18)
    with connection() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
            raise ValueError("Account not found")
        conn.execute(
            "UPDATE users SET recovery_hash=? WHERE id=?",
            (_hash_recovery_code(recovery_code), user_id),
        )
    return recovery_code


def reset_password(username: str, recovery_code: str, new_password: str) -> str:
    if len(new_password) < 10:
        raise ValueError("Use a password with at least 10 characters")
    supplied_hash = _hash_recovery_code(recovery_code)
    with connection() as conn:
        row = conn.execute(
            "SELECT id,recovery_hash FROM users WHERE username=?",
            (username.strip().lower(),),
        ).fetchone()
        if (
            not row
            or not row["recovery_hash"]
            or not hmac.compare_digest(supplied_hash, row["recovery_hash"])
        ):
            raise ValueError("The username or recovery code is incorrect")
        replacement = secrets.token_urlsafe(18)
        conn.execute(
            "UPDATE users SET password_hash=?,recovery_hash=? WHERE id=?",
            (_hash_password(new_password), _hash_recovery_code(replacement), row["id"]),
        )
        conn.execute("DELETE FROM sessions WHERE user_id=?", (row["id"],))
    return replacement


def user_from_request(request: Request) -> dict:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(401, "Sign in to use your library")
    token = header[7:]
    with connection() as conn:
        row = conn.execute(
            """SELECT users.id,users.username,users.role FROM sessions JOIN users ON users.id=sessions.user_id
                            WHERE sessions.token_hash=? AND sessions.expires_at>?""",
            (hashlib.sha256(token.encode()).hexdigest(), now()),
        ).fetchone()
    if not row:
        raise HTTPException(401, "Your session has expired")
    return dict(row)


def require_admin(user: dict) -> None:
    if user["role"] != "admin":
        raise HTTPException(403, "Administrator access required")
