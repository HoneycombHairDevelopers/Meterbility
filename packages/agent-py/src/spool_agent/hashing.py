"""
Content-addressing helpers — mirror packages/shared/src/hash.ts.

``canonical_json`` matches the JS implementation: sort object keys at
every level, no spaces, drop ``None`` only when the original would have
been ``undefined`` in JS. The JSON output is what gets SHA256'd, so this
must match byte-for-byte with the TS canonicalJson so that Python-side
and TS-side writes of the same logical value land at the same blob ref.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Union


def sha256(data: Union[bytes, str]) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> str:
    """
    Stable JSON serialization for content addressing.

    Matches the TS ``canonicalJson`` byte-for-byte:
      - sort_keys=True at every level
      - separators=(",", ":") — no whitespace
      - ensure_ascii=False — UTF-8 passes through
    """
    return json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )


def hash_json(value: Any) -> str:
    return sha256(canonical_json(value))
