"""
Content-addressed blob store — mirror packages/collector/src/blobs.ts.

Writes are atomic and write-once: if the file already exists at the
sharded path, we trust it (SHA collision is the universe's problem).
Every write passes through the regex redaction pass and emits one
``redaction_log`` row per rule that fired.
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from typing import Any, Optional

from .hashing import sha256
from .paths import blob_path, blob_root
from .redact import redact_bytes


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + (
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    )


class BlobStore:
    """Tiny content-addressed filesystem store backed by ``$METERBILITY_HOME/blobs``."""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    # ---- writes ----------------------------------------------------------

    def put_string(self, content: str, *, skip_redact: bool = False) -> str:
        return self.put_bytes(content.encode("utf-8"), skip_redact=skip_redact)

    def put_json(self, value: Any, *, skip_redact: bool = False) -> str:
        # NOTE: We use ensure_ascii=False so utf-8 round-trips cleanly.
        # We DO NOT sort keys here — content addressing of arbitrary JSON
        # blobs uses the bytes-as-written. Logical canonicalization only
        # matters for the snapshot id (see hashing.hash_json).
        text = json.dumps(value, ensure_ascii=False)
        return self.put_string(text, skip_redact=skip_redact)

    def put_bytes(self, buf: bytes, *, skip_redact: bool = False) -> str:
        if skip_redact:
            scrubbed = buf
            redactions: list = []
        else:
            scrubbed, redactions = redact_bytes(buf)
        sha = sha256(scrubbed)
        path = blob_path(sha)
        if path.exists():
            return sha
        path.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: tmpfile + rename. Prevents half-written blobs from
        # confusing the "exists → trust" check on the next call.
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(scrubbed)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        if redactions:
            now = _now_iso()
            cur = self._db.cursor()
            cur.executemany(
                "INSERT INTO redaction_log(blob_ref, rule, count, created_at) "
                "VALUES (?, ?, ?, ?)",
                [(sha, name, count, now) for name, count in redactions],
            )
            self._db.commit()
        return sha

    # ---- reads -----------------------------------------------------------

    def get_bytes(self, sha: str) -> bytes:
        return blob_path(sha).read_bytes()

    def get_string(self, sha: str) -> str:
        return self.get_bytes(sha).decode("utf-8")

    def try_get_string(self, sha: str) -> Optional[str]:
        try:
            return self.get_string(sha)
        except (FileNotFoundError, IsADirectoryError):
            return None

    def root_dir(self) -> str:
        return str(blob_root())
