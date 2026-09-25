"""Paths for installation-owned state."""

from __future__ import annotations

import os
from pathlib import Path

_configured = os.getenv("NOVELIST_DATA_DIR", "").strip()
if _configured:
    requested = Path(_configured).expanduser()
    if not requested.is_absolute():
        raise ValueError("NOVELIST_DATA_DIR must be an absolute path")
    DATA_DIR = requested.resolve()
else:
    DATA_DIR = (Path(__file__).parent / "data").resolve()

INDEX_DIR = DATA_DIR / "index"
