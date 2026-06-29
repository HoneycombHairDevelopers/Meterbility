"""
Path helpers — mirror packages/shared/src/paths.ts.

The Python SDK writes into the same ``$METERBILITY_HOME`` directory as the JS
SDK, the CLI, and the web UI. METERBILITY_HOME defaults to ``~/.meterbility``.
"""

from __future__ import annotations

import os
from pathlib import Path


def meter_home() -> Path:
    """Return the Meterbility data directory (env override: ``METERBILITY_HOME``)."""
    override = os.environ.get("METERBILITY_HOME")
    if override:
        return Path(override)
    return Path.home() / ".meter"


def db_path() -> Path:
    return meter_home() / "meterbility.db"


def blob_root() -> Path:
    return meter_home() / "blobs"


def blob_path(sha: str) -> Path:
    """Sharded content-addressed path: ``$METERBILITY_HOME/blobs/aa/bb/<sha>``."""
    if len(sha) < 4:
        raise ValueError(f"invalid sha256: {sha!r}")
    return blob_root() / sha[:2] / sha[2:4] / sha
