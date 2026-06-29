"""
Thin SQLite wrapper — opens ``$METERBILITY_HOME/meterbility.db``, ensures the schema
is bootstrapped (idempotent), and exposes the underlying connection plus
a ``BlobStore`` bound to it.

Mirrors packages/collector/src/store.ts in spirit, but without the
better-sqlite3 sync-API conveniences. Python's stdlib ``sqlite3`` works
fine — and is already sync — so we just use it directly.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Optional

from .blobs import BlobStore
from .paths import db_path, meter_home
from .schema import ensure_schema


class Store:
    def __init__(self, db: sqlite3.Connection, blobs: BlobStore) -> None:
        self.db = db
        self.blobs = blobs
        self._closed = False

    @classmethod
    def open(cls, *, path: Optional[str] = None) -> "Store":
        """Open (or create) the Meterbility SQLite store. Idempotent."""
        meter_home().mkdir(parents=True, exist_ok=True)
        target = path or str(db_path())
        # ``check_same_thread=False`` — we don't share the connection
        # across threads, but better-sqlite3 (JS) also runs in WAL mode
        # so concurrent readers from the CLI are expected. WAL keeps
        # them isolated.
        conn = sqlite3.connect(target, isolation_level=None)
        conn.execute("PRAGMA foreign_keys = ON")
        ensure_schema(conn)
        return cls(conn, BlobStore(conn))

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.db.close()

    # context-manager sugar
    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
