"""
Regex redaction — mirrors packages/shared/src/redact.ts.

Applied to every blob before persist. Disable globally via
``SPOOL_REDACT=off``. Each rule replaces matches with a tagged
placeholder so redactions are visible in the stored bytes.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import List, Tuple


def _placeholder(name: str) -> str:
    return f"«spool:redacted:{name}»"


@dataclass(frozen=True)
class RedactionRule:
    name: str
    pattern: "re.Pattern[str]"


DEFAULT_RULES: List[RedactionRule] = [
    RedactionRule("anthropic-key", re.compile(r"sk-ant-[a-zA-Z0-9_\-]{20,}")),
    RedactionRule("openai-key", re.compile(r"sk-(?:proj-)?[a-zA-Z0-9_\-]{20,}")),
    RedactionRule("github-token", re.compile(r"gh[pous]_[A-Za-z0-9]{36,}")),
    RedactionRule("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    RedactionRule("bearer", re.compile(r"Bearer\s+[A-Za-z0-9_\-.=]{20,}")),
    RedactionRule(
        "private-key",
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----"
            r"[\s\S]*?"
            r"-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----"
        ),
    ),
]


def redact_string(
    text: str, rules: List[RedactionRule] = DEFAULT_RULES
) -> Tuple[str, List[Tuple[str, int]]]:
    """
    Apply rules to ``text``. Returns ``(redacted_text, counts)`` where
    ``counts`` is a list of ``(rule_name, count)`` for every rule that
    matched at least once.
    """
    if os.environ.get("SPOOL_REDACT") == "off":
        return text, []
    out = text
    counts: List[Tuple[str, int]] = []
    for rule in rules:
        new_out, n = rule.pattern.subn(_placeholder(rule.name), out)
        if n > 0:
            counts.append((rule.name, n))
        out = new_out
    return out, counts


def redact_bytes(
    buf: bytes, rules: List[RedactionRule] = DEFAULT_RULES
) -> Tuple[bytes, List[Tuple[str, int]]]:
    text = buf.decode("utf-8", errors="replace")
    redacted, counts = redact_string(text, rules)
    return redacted.encode("utf-8"), counts
