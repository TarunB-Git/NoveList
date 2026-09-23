#!/usr/bin/env python3
"""Reset a local account password from the deployment host.

This recovery tool requires filesystem access to the self-hosted deployment and
invalidates the account's current recovery code.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from accounts import _hash_password  # noqa: E402
from collection import connection  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Reset a NoveList account password")
    parser.add_argument("username", help="Account username")
    args = parser.parse_args()

    password = getpass.getpass("New password (10+ characters): ")
    confirmation = getpass.getpass("Confirm new password: ")
    if password != confirmation:
        parser.error("Passwords do not match")
    if len(password) < 10:
        parser.error("Password must be at least 10 characters")

    with connection() as conn:
        user = conn.execute(
            "SELECT id FROM users WHERE username=?", (args.username.strip().lower(),)
        ).fetchone()
        if not user:
            parser.error("Account not found")
        conn.execute(
            "UPDATE users SET password_hash=?,recovery_hash=NULL WHERE id=?",
            (_hash_password(password), user["id"]),
        )
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
    print("Password reset. Existing sessions have been signed out.")


if __name__ == "__main__":
    main()
