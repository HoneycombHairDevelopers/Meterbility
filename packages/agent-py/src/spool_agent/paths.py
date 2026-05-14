"""
Path helpers — mirror packages/shared/src/paths.ts.

The Python SDK writes into the same ``$SPOOL_HOME`` directory as the JS
SDK, the CLI, and the web UI. SPOOL_HOME defaults to ``~/.spool``.
"""

from __future__ import annotations

import os
from pathlib import Path


def spool_home() -> Path:
    """Return the Spool data directory (env override: ``SPOOL_HOME``)."""
    override = os.environ.get("SPOOL_HOME")
    if override:
        return Path(override)
    return Path.home() / ".spool"


def db_path() -> Path:
    return spool_home() / "spool.db"


def blob_root() -> Path:
    return spool_home() / "blobs"


def blob_path(sha: str) -> Path:
    """Sharded content-addressed path: ``$SPOOL_HOME/blobs/aa/bb/<sha>``."""
    if len(sha) < 4:
        raise ValueError(f"invalid sha256: {sha!r}")
    return blob_root() / sha[:2] / sha[2:4] / sha
