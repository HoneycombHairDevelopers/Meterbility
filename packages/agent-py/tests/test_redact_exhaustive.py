"""
Tier 10 — exhaustive coverage of ``spool_agent.redact`` + cross-language
parity with the TS redactor at ``packages/shared/src/redact.ts``.

Three layers, mirroring TS Tier 1 (``redact.combinatorial.test.ts`` and
``redact.properties.test.ts``):

  1. Combinatorial cross-product: 6 rules × 6 scenarios.
  2. Cross-rule interactions: rule ordering, placeholder inertness.
  3. Property-style tests via hand-rolled iteration (no `hypothesis`
     dependency so the Python SDK suite keeps its zero-install footprint).
  4. Cross-language compat: invoke the TS redactor via `node tsx/esm`
     and assert identical output bytes + redaction logs for the same
     inputs. Pins the wire-format contract both SDKs depend on.

Each layer mirrors the TS work line-for-line where possible so a future
audit can diff the test rosters and confirm parity.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Dict, List, Tuple

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent  # packages/agent-py/tests → repo root
sys.path.insert(0, str(HERE.parent / "src"))

from spool_agent.redact import (  # noqa: E402
    DEFAULT_RULES,
    redact_bytes,
    redact_string,
)

# ─── Fake-but-shape-correct sample secrets per rule ────────────────────
# Same shapes as the TS Tier 1 fixtures so cross-language compat works
# on identical inputs.

SAMPLES: Dict[str, str] = {
    "anthropic-key": "sk-ant-api03-aaaaaaaaaaaaaaaaaaaa",
    "openai-key": "sk-proj-bbbbbbbbbbbbbbbbbbbb",
    "github-token": "ghp_cccccccccccccccccccccccccccccccccccc",
    "aws-access-key": "AKIAIOSFODNN7EXAMPLE",
    "bearer": "Bearer ddddddddddddddddddddddd",
    "private-key": (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1\n"
        "Pt8Qp4N4nvKBu+IZ9PMcN1zV7Z6OQ3xXrGGqv7sCAwEAAQJAIJLixBy2qpFo\n"
        "-----END RSA PRIVATE KEY-----"
    ),
    # v0.3 extensions — kept byte-identical to the TS Tier 1 SAMPLES so
    # the cross-language compat layer below has stable shared fixtures.
    "slack-token": "xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx",
    "jwt": (
        "eyJhbGciOiJIUzI1NiJ9"
        ".eyJzdWIiOiIxMjM0NTY3ODkwIn0"
        ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    ),
    "stripe-live-key": "sk_live_eeeeeeeeeeeeeeeeeeeeeeeeeeee",
    # env-secret nukes the whole KEY=value line; sample is the full match.
    "env-secret": "DATABASE_PASSWORD=hunter2longvaluefortesting",
}

# Plain text with no secret-shaped substrings. Used as both the
# no-match decoy and the wrapper for single-match scenarios.
PLAIN_PROSE = (
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n"
    "Filename: report.txt, version 1.2.3, build #4567.\n"
)

RULE_NAMES = [r.name for r in DEFAULT_RULES]


class IsolatedRedactEnv(unittest.TestCase):
    """Each test starts with SPOOL_REDACT unset so the redactor's
    default-on behavior is reliable."""

    def setUp(self) -> None:
        self._prev = os.environ.get("SPOOL_REDACT")
        if "SPOOL_REDACT" in os.environ:
            del os.environ["SPOOL_REDACT"]

    def tearDown(self) -> None:
        if self._prev is not None:
            os.environ["SPOOL_REDACT"] = self._prev
        elif "SPOOL_REDACT" in os.environ:
            del os.environ["SPOOL_REDACT"]


# ─────────────────────────────────────────────────────────────────────
# Section 1 — Combinatorial: 6 rules × 6 scenarios = 36 cells
# Plus a 7th column for cross-rule fan-out and placeholder safety.
# Each cell is one test method on this class.
# ─────────────────────────────────────────────────────────────────────


class TestRedactCombinatorial(IsolatedRedactEnv):
    """6 × 6 grid + cross-rule interactions, mirroring TS Tier 1."""

    # ── Scenario helpers ─────────────────────────────────────────────

    def _assert_cell(
        self,
        rule_name: str,
        scenario_name: str,
        text: str,
        expected_count: int,
        spool_redact_off: bool = False,
    ) -> None:
        """Generic cell-checker. Asserts (a) count for this rule matches
        ``expected_count``, (b) when expected_count > 0 the raw secret
        does NOT survive and the placeholder appears N times, (c) when
        expected_count == 0 the output equals the input verbatim."""
        secret = SAMPLES[rule_name]
        if spool_redact_off:
            os.environ["SPOOL_REDACT"] = "off"
        out, counts = redact_string(text)
        by_rule = dict(counts)
        actual = by_rule.get(rule_name, 0)
        self.assertEqual(
            actual,
            expected_count,
            f"{rule_name} × {scenario_name}: expected {expected_count}, got {actual}",
        )
        if expected_count > 0:
            placeholder = f"«spool:redacted:{rule_name}»"
            self.assertEqual(
                out.count(placeholder),
                expected_count,
                f"placeholder count mismatch for {rule_name}",
            )
            self.assertNotIn(
                secret, out, f"raw secret leaked for {rule_name}"
            )
        else:
            self.assertEqual(
                out, text, "no-match case should leave input verbatim"
            )

    # ── Six scenarios × six rules ────────────────────────────────────

    def test_anthropic_no_match(self) -> None:
        self._assert_cell("anthropic-key", "no match (decoy)", PLAIN_PROSE, 0)

    def test_anthropic_single_match(self) -> None:
        self._assert_cell(
            "anthropic-key",
            "single match in middle",
            f"prefix {SAMPLES['anthropic-key']} suffix\n",
            1,
        )

    def test_anthropic_adjacent_matches(self) -> None:
        self._assert_cell(
            "anthropic-key",
            "adjacent matches",
            f"{SAMPLES['anthropic-key']} {SAMPLES['anthropic-key']}\n",
            2,
        )

    def test_anthropic_start_of_buffer(self) -> None:
        self._assert_cell(
            "anthropic-key",
            "match at start",
            f"{SAMPLES['anthropic-key']} trailing prose here",
            1,
        )

    def test_anthropic_multiline(self) -> None:
        self._assert_cell(
            "anthropic-key",
            "multi-line",
            f"line1: {SAMPLES['anthropic-key']}\nline2 prose\nline3: {SAMPLES['anthropic-key']}\n",
            2,
        )

    def test_anthropic_spool_redact_off(self) -> None:
        self._assert_cell(
            "anthropic-key",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['anthropic-key']} suffix\n",
            0,
            spool_redact_off=True,
        )

    def test_openai_no_match(self) -> None:
        self._assert_cell("openai-key", "no match (decoy)", PLAIN_PROSE, 0)

    def test_openai_single_match(self) -> None:
        self._assert_cell(
            "openai-key",
            "single match in middle",
            f"prefix {SAMPLES['openai-key']} suffix\n",
            1,
        )

    def test_openai_adjacent_matches(self) -> None:
        self._assert_cell(
            "openai-key",
            "adjacent matches",
            f"{SAMPLES['openai-key']} {SAMPLES['openai-key']}\n",
            2,
        )

    def test_openai_start_of_buffer(self) -> None:
        self._assert_cell(
            "openai-key",
            "match at start",
            f"{SAMPLES['openai-key']} trailing prose here",
            1,
        )

    def test_openai_multiline(self) -> None:
        self._assert_cell(
            "openai-key",
            "multi-line",
            f"line1: {SAMPLES['openai-key']}\nline2 prose\nline3: {SAMPLES['openai-key']}\n",
            2,
        )

    def test_openai_spool_redact_off(self) -> None:
        self._assert_cell(
            "openai-key",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['openai-key']} suffix\n",
            0,
            spool_redact_off=True,
        )

    def test_github_no_match(self) -> None:
        self._assert_cell("github-token", "no match (decoy)", PLAIN_PROSE, 0)

    def test_github_single_match(self) -> None:
        self._assert_cell(
            "github-token",
            "single match in middle",
            f"prefix {SAMPLES['github-token']} suffix\n",
            1,
        )

    def test_github_adjacent_matches(self) -> None:
        self._assert_cell(
            "github-token",
            "adjacent matches",
            f"{SAMPLES['github-token']} {SAMPLES['github-token']}\n",
            2,
        )

    def test_github_start_of_buffer(self) -> None:
        self._assert_cell(
            "github-token",
            "match at start",
            f"{SAMPLES['github-token']} trailing prose here",
            1,
        )

    def test_github_multiline(self) -> None:
        self._assert_cell(
            "github-token",
            "multi-line",
            f"line1: {SAMPLES['github-token']}\nline2 prose\nline3: {SAMPLES['github-token']}\n",
            2,
        )

    def test_github_spool_redact_off(self) -> None:
        self._assert_cell(
            "github-token",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['github-token']} suffix\n",
            0,
            spool_redact_off=True,
        )

    def test_aws_no_match(self) -> None:
        self._assert_cell("aws-access-key", "no match (decoy)", PLAIN_PROSE, 0)

    def test_aws_single_match(self) -> None:
        self._assert_cell(
            "aws-access-key",
            "single match in middle",
            f"prefix {SAMPLES['aws-access-key']} suffix\n",
            1,
        )

    def test_aws_adjacent_matches(self) -> None:
        self._assert_cell(
            "aws-access-key",
            "adjacent matches",
            f"{SAMPLES['aws-access-key']} {SAMPLES['aws-access-key']}\n",
            2,
        )

    def test_aws_start_of_buffer(self) -> None:
        self._assert_cell(
            "aws-access-key",
            "match at start",
            f"{SAMPLES['aws-access-key']} trailing prose here",
            1,
        )

    def test_aws_multiline(self) -> None:
        self._assert_cell(
            "aws-access-key",
            "multi-line",
            f"line1: {SAMPLES['aws-access-key']}\nline2 prose\nline3: {SAMPLES['aws-access-key']}\n",
            2,
        )

    def test_aws_spool_redact_off(self) -> None:
        self._assert_cell(
            "aws-access-key",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['aws-access-key']} suffix\n",
            0,
            spool_redact_off=True,
        )

    def test_bearer_no_match(self) -> None:
        self._assert_cell("bearer", "no match (decoy)", PLAIN_PROSE, 0)

    def test_bearer_single_match(self) -> None:
        self._assert_cell(
            "bearer",
            "single match in middle",
            f"prefix {SAMPLES['bearer']} suffix\n",
            1,
        )

    def test_bearer_adjacent_matches(self) -> None:
        self._assert_cell(
            "bearer",
            "adjacent matches",
            f"{SAMPLES['bearer']} {SAMPLES['bearer']}\n",
            2,
        )

    def test_bearer_start_of_buffer(self) -> None:
        self._assert_cell(
            "bearer",
            "match at start",
            f"{SAMPLES['bearer']} trailing prose here",
            1,
        )

    def test_bearer_multiline(self) -> None:
        self._assert_cell(
            "bearer",
            "multi-line",
            f"line1: {SAMPLES['bearer']}\nline2 prose\nline3: {SAMPLES['bearer']}\n",
            2,
        )

    def test_bearer_spool_redact_off(self) -> None:
        self._assert_cell(
            "bearer",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['bearer']} suffix\n",
            0,
            spool_redact_off=True,
        )

    def test_private_key_no_match(self) -> None:
        self._assert_cell("private-key", "no match (decoy)", PLAIN_PROSE, 0)

    def test_private_key_single_match(self) -> None:
        self._assert_cell(
            "private-key",
            "single match in middle",
            f"prefix {SAMPLES['private-key']} suffix\n",
            1,
        )

    def test_private_key_adjacent_matches(self) -> None:
        self._assert_cell(
            "private-key",
            "adjacent matches",
            f"{SAMPLES['private-key']} {SAMPLES['private-key']}\n",
            2,
        )

    def test_private_key_start_of_buffer(self) -> None:
        self._assert_cell(
            "private-key",
            "match at start",
            f"{SAMPLES['private-key']} trailing prose here",
            1,
        )

    def test_private_key_multiline(self) -> None:
        self._assert_cell(
            "private-key",
            "multi-line",
            f"line1: {SAMPLES['private-key']}\nline2 prose\nline3: {SAMPLES['private-key']}\n",
            2,
        )

    def test_private_key_spool_redact_off(self) -> None:
        self._assert_cell(
            "private-key",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['private-key']} suffix\n",
            0,
            spool_redact_off=True,
        )

    # ── v0.3 extensions: slack-token × 6 scenarios ────────────────────

    def test_slack_no_match(self) -> None:
        self._assert_cell("slack-token", "no match (decoy)", PLAIN_PROSE, 0)

    def test_slack_single_match(self) -> None:
        self._assert_cell(
            "slack-token",
            "single match in middle",
            f"prefix {SAMPLES['slack-token']} suffix\n",
            1,
        )

    def test_slack_adjacent_matches(self) -> None:
        self._assert_cell(
            "slack-token",
            "adjacent matches",
            f"{SAMPLES['slack-token']} {SAMPLES['slack-token']}\n",
            2,
        )

    def test_slack_start_of_buffer(self) -> None:
        self._assert_cell(
            "slack-token",
            "match at start",
            f"{SAMPLES['slack-token']} trailing prose here",
            1,
        )

    def test_slack_multiline(self) -> None:
        self._assert_cell(
            "slack-token",
            "multi-line",
            f"line1: {SAMPLES['slack-token']}\nline2 prose\nline3: {SAMPLES['slack-token']}\n",
            2,
        )

    def test_slack_spool_redact_off(self) -> None:
        self._assert_cell(
            "slack-token",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['slack-token']} suffix\n",
            0,
            spool_redact_off=True,
        )

    # ── v0.3 extensions: jwt × 6 scenarios ────────────────────────────

    def test_jwt_no_match(self) -> None:
        self._assert_cell("jwt", "no match (decoy)", PLAIN_PROSE, 0)

    def test_jwt_single_match(self) -> None:
        self._assert_cell(
            "jwt",
            "single match in middle",
            f"prefix {SAMPLES['jwt']} suffix\n",
            1,
        )

    def test_jwt_adjacent_matches(self) -> None:
        self._assert_cell(
            "jwt",
            "adjacent matches",
            f"{SAMPLES['jwt']} {SAMPLES['jwt']}\n",
            2,
        )

    def test_jwt_start_of_buffer(self) -> None:
        self._assert_cell(
            "jwt",
            "match at start",
            f"{SAMPLES['jwt']} trailing prose here",
            1,
        )

    def test_jwt_multiline(self) -> None:
        self._assert_cell(
            "jwt",
            "multi-line",
            f"line1: {SAMPLES['jwt']}\nline2 prose\nline3: {SAMPLES['jwt']}\n",
            2,
        )

    def test_jwt_spool_redact_off(self) -> None:
        self._assert_cell(
            "jwt",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['jwt']} suffix\n",
            0,
            spool_redact_off=True,
        )

    # ── v0.3 extensions: stripe-live-key × 6 scenarios ────────────────

    def test_stripe_no_match(self) -> None:
        self._assert_cell("stripe-live-key", "no match (decoy)", PLAIN_PROSE, 0)

    def test_stripe_single_match(self) -> None:
        self._assert_cell(
            "stripe-live-key",
            "single match in middle",
            f"prefix {SAMPLES['stripe-live-key']} suffix\n",
            1,
        )

    def test_stripe_adjacent_matches(self) -> None:
        self._assert_cell(
            "stripe-live-key",
            "adjacent matches",
            f"{SAMPLES['stripe-live-key']} {SAMPLES['stripe-live-key']}\n",
            2,
        )

    def test_stripe_start_of_buffer(self) -> None:
        self._assert_cell(
            "stripe-live-key",
            "match at start",
            f"{SAMPLES['stripe-live-key']} trailing prose here",
            1,
        )

    def test_stripe_multiline(self) -> None:
        self._assert_cell(
            "stripe-live-key",
            "multi-line",
            f"line1: {SAMPLES['stripe-live-key']}\nline2 prose\nline3: {SAMPLES['stripe-live-key']}\n",
            2,
        )

    def test_stripe_spool_redact_off(self) -> None:
        self._assert_cell(
            "stripe-live-key",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['stripe-live-key']} suffix\n",
            0,
            spool_redact_off=True,
        )

    # ── v0.3 extensions: env-secret × 6 scenarios ─────────────────────

    def test_env_secret_no_match(self) -> None:
        self._assert_cell("env-secret", "no match (decoy)", PLAIN_PROSE, 0)

    def test_env_secret_single_match(self) -> None:
        self._assert_cell(
            "env-secret",
            "single match in middle",
            f"prefix {SAMPLES['env-secret']} suffix\n",
            1,
        )

    def test_env_secret_adjacent_matches(self) -> None:
        self._assert_cell(
            "env-secret",
            "adjacent matches",
            f"{SAMPLES['env-secret']} {SAMPLES['env-secret']}\n",
            2,
        )

    def test_env_secret_start_of_buffer(self) -> None:
        self._assert_cell(
            "env-secret",
            "match at start",
            f"{SAMPLES['env-secret']} trailing prose here",
            1,
        )

    def test_env_secret_multiline(self) -> None:
        self._assert_cell(
            "env-secret",
            "multi-line",
            f"line1: {SAMPLES['env-secret']}\nline2 prose\nline3: {SAMPLES['env-secret']}\n",
            2,
        )

    def test_env_secret_spool_redact_off(self) -> None:
        self._assert_cell(
            "env-secret",
            "SPOOL_REDACT=off",
            f"prefix {SAMPLES['env-secret']} suffix\n",
            0,
            spool_redact_off=True,
        )


# ─────────────────────────────────────────────────────────────────────
# Section 2 — Cross-rule interactions (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestRedactCrossRule(IsolatedRedactEnv):
    """Three interaction cases that aren't (rule × scenario)."""

    def test_multiple_distinct_rules_fire_on_one_buffer(self) -> None:
        text = (
            "Authorization: "
            + SAMPLES["bearer"]
            + "\nANTHROPIC_API_KEY="
            + SAMPLES["anthropic-key"]
            + "\nAWS_ACCESS_KEY_ID="
            + SAMPLES["aws-access-key"]
            + "\n"
        )
        out, counts = redact_string(text)
        by_rule = dict(counts)
        self.assertEqual(by_rule.get("bearer"), 1, "bearer counted once")
        self.assertEqual(
            by_rule.get("anthropic-key"), 1, "anthropic counted once"
        )
        self.assertEqual(
            by_rule.get("aws-access-key"), 1, "aws counted once"
        )
        self.assertNotIn(SAMPLES["bearer"], out)
        self.assertNotIn(SAMPLES["anthropic-key"], out)
        self.assertNotIn(SAMPLES["aws-access-key"], out)

    def test_anthropic_wins_over_openai_superset_pattern(self) -> None:
        """The openai-key regex `sk-(?:proj-)?[a-zA-Z0-9_-]{20,}` is a
        superset of the anthropic-key regex `sk-ant-[a-zA-Z0-9_-]{20,}`.
        Because anthropic-key appears first in DEFAULT_RULES, its replace
        runs first and the openai pattern has nothing left to match. If
        rule order ever changes, this test catches it."""
        text = f"token={SAMPLES['anthropic-key']}\n"
        out, counts = redact_string(text)
        by_rule = dict(counts)
        self.assertEqual(by_rule.get("anthropic-key"), 1, "anthropic fires")
        self.assertIsNone(
            by_rule.get("openai-key"),
            "openai does NOT fire on anthropic-shaped key",
        )

    def test_placeholder_is_inert_redact_redact_x_equals_redact_x(
        self,
    ) -> None:
        """Idempotence smoke: applying redact a second time to its own
        output produces no further changes."""
        text = (
            f"key1={SAMPLES['anthropic-key']}\n"
            f"key2={SAMPLES['openai-key']}\n"
            f"{SAMPLES['bearer']}\n"
            f"creds={SAMPLES['github-token']}\n"
            f"{SAMPLES['aws-access-key']}\n"
            f"{SAMPLES['private-key']}\n"
            # v0.3 extensions — same idempotence contract.
            f"slack={SAMPLES['slack-token']}\n"
            f"auth={SAMPLES['jwt']}\n"
            f"pay={SAMPLES['stripe-live-key']}\n"
            f"{SAMPLES['env-secret']}\n"
        )
        once, _ = redact_string(text)
        twice, twice_counts = redact_string(once)
        self.assertEqual(twice, once, "second pass is a no-op")
        self.assertEqual(
            twice_counts, [], "second pass fires no rules"
        )


# ─────────────────────────────────────────────────────────────────────
# Section 3 — Property-style tests (hand-rolled iterations)
# ─────────────────────────────────────────────────────────────────────

# Bounded alphabets per the Tier 1 lesson: build strings from a known
# character set so we don't accidentally produce a secret in the
# "padding" position.
SECRET_ARBS = [
    lambda i: f"sk-ant-api03-{'a' * (20 + (i % 20))}",
    lambda i: f"sk-proj-{'b' * (20 + (i % 20))}",
    lambda i: f"ghp_{'c' * (36 + (i % 12))}",
    lambda i: f"AKIA{'D' * 16}",  # fixed length per regex
    lambda i: f"Bearer {'e' * (20 + (i % 20))}",
]

INNOCUOUS_CHARS = "abcdefijlmnopqrtuvwxyz0123456789 .,\n"


def _innocuous(i: int) -> str:
    """Return a deterministic, secret-free string of length-ish ~i."""
    # Pick chars by index modulo alphabet — avoids `sk-`, `ghp_`, `AKIA`,
    # `Bearer ` and `-----BEGIN` by construction.
    n = (i * 7 + 3) % 80 + 1
    return "".join(INNOCUOUS_CHARS[(i + k * 5) % len(INNOCUOUS_CHARS)] for k in range(n))


class TestRedactProperties(IsolatedRedactEnv):
    """Hand-rolled property iterations (no `hypothesis` dependency)."""

    N_ITERATIONS = 50

    def test_idempotence_redact_of_redact_is_no_op(self) -> None:
        """For any deterministic input, redact(redact(x)) == redact(x)."""
        for i in range(self.N_ITERATIONS):
            parts: List[str] = []
            for j in range(1 + (i % 4)):
                if (i + j) % 2 == 0:
                    parts.append(_innocuous(i + j))
                else:
                    parts.append(SECRET_ARBS[(i + j) % len(SECRET_ARBS)](i))
            text = "\n".join(parts)
            once, _ = redact_string(text)
            twice, twice_counts = redact_string(once)
            self.assertEqual(twice, once, f"iter {i}: second pass changed text")
            self.assertEqual(
                twice_counts, [], f"iter {i}: second pass fired rules"
            )

    def test_after_redaction_no_rule_pattern_matches_output(self) -> None:
        """The security-critical invariant: after redaction, no rule's
        regex matches the output."""
        for i in range(self.N_ITERATIONS):
            parts: List[str] = []
            for j in range(1 + (i % 3)):
                parts.append(SECRET_ARBS[(i + j) % len(SECRET_ARBS)](i))
                parts.append(_innocuous(i + j + 1))
            text = " ".join(parts)
            out, _ = redact_string(text)
            for rule in DEFAULT_RULES:
                self.assertIsNone(
                    rule.pattern.search(out),
                    f"iter {i}: rule {rule.name} matched output after redaction",
                )

    def test_per_rule_count_bounded_by_raw_input_match_count(self) -> None:
        """A rule should redact at most as many things as actually exist
        in the input. If it ever reports more, it's mid-string expansion
        — a bug we'd never see on hand-written single-secret tests."""
        for i in range(self.N_ITERATIONS):
            parts: List[str] = []
            for j in range(1 + (i % 4)):
                parts.append(SECRET_ARBS[(i + j) % len(SECRET_ARBS)](i))
            text = "\n".join(parts)
            _, counts = redact_string(text)
            for rule_name, count in counts:
                rule = next(r for r in DEFAULT_RULES if r.name == rule_name)
                standalone = len(rule.pattern.findall(text))
                self.assertLessEqual(
                    count,
                    standalone,
                    f"iter {i}: {rule_name} count {count} > standalone {standalone}",
                )

    def test_spool_redact_off_is_perfect_passthrough(self) -> None:
        """SPOOL_REDACT=off returns input verbatim with zero counts."""
        os.environ["SPOOL_REDACT"] = "off"
        for i in range(self.N_ITERATIONS):
            parts: List[str] = []
            for j in range(1 + (i % 3)):
                if (i + j) % 2 == 0:
                    parts.append(_innocuous(i + j))
                else:
                    parts.append(SECRET_ARBS[(i + j) % len(SECRET_ARBS)](i))
            text = "\n".join(parts)
            out, counts = redact_string(text)
            self.assertEqual(out, text, f"iter {i}: pass-through changed text")
            self.assertEqual(counts, [], f"iter {i}: counts non-empty when off")


# ─────────────────────────────────────────────────────────────────────
# Section 4 — Cross-language compat with the TS redactor
# Spawns node + tsx to call `redactString` from packages/shared/src/
# redact.ts, then asserts Python output exactly matches.
# ─────────────────────────────────────────────────────────────────────


def _ts_redact(text: str) -> Tuple[str, List[Tuple[str, int]]]:
    """Invoke the TS redactString on the given input. Returns the same
    shape as `redact_string` for direct comparison. Raises if Node /
    tsx aren't available (test layer handles skip)."""
    redact_module = REPO_ROOT / "packages" / "shared" / "src" / "redact.ts"
    if not redact_module.exists():
        raise FileNotFoundError(f"TS redact.ts not found at {redact_module}")
    # We pass the input on stdin (avoids argv quoting hell with newlines/
    # special chars in secrets). The TS snippet reads stdin → JSON.
    script = """
import { readFileSync } from "node:fs";
import { redactString } from "%s";
const input = readFileSync(0, "utf-8");
const { text, redactions } = redactString(input);
process.stdout.write(JSON.stringify({ text, redactions }));
""" % redact_module.as_posix()
    # `node --import tsx/esm` requires tsx in node_modules. The script
    # imports redact.ts via absolute path so it doesn't depend on CWD.
    proc = subprocess.run(
        ["node", "--import", "tsx/esm", "--input-type=module", "-e", script],
        input=text,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"TS redact subprocess failed: {proc.stderr.strip()}"
        )
    parsed = json.loads(proc.stdout)
    counts = [(r["rule"], r["count"]) for r in parsed["redactions"]]
    return parsed["text"], counts


def _node_available() -> bool:
    """Skip-helper: cross-language tests need `node` on PATH."""
    return shutil.which("node") is not None


class TestRedactCrossLanguageCompat(IsolatedRedactEnv):
    """For each fixture, run both Python and TS redactors on the same
    input and assert their outputs are byte-identical. This pins the
    wire-format contract: any drift between the two SDKs would corrupt
    blobs that cross language boundaries."""

    @classmethod
    def setUpClass(cls) -> None:
        if not _node_available():
            raise unittest.SkipTest("node not on PATH; skipping compat tests")

    def _assert_compat(self, label: str, text: str) -> None:
        py_text, py_counts = redact_string(text)
        try:
            ts_text, ts_counts = _ts_redact(text)
        except (FileNotFoundError, RuntimeError) as e:
            self.skipTest(f"TS bridge unavailable: {e}")
        self.assertEqual(
            py_text,
            ts_text,
            f"{label}: text differs between Python and TS",
        )
        # Normalize count list ordering for comparison (both should be
        # rule-order, but defensive sort makes the failure message clear).
        self.assertEqual(
            sorted(py_counts),
            sorted(ts_counts),
            f"{label}: counts differ between Python and TS",
        )

    def test_compat_no_match(self) -> None:
        self._assert_compat("no match (innocuous prose)", PLAIN_PROSE)

    def test_compat_single_anthropic(self) -> None:
        self._assert_compat(
            "anthropic single", f"key={SAMPLES['anthropic-key']}\n"
        )

    def test_compat_multi_rule_mixed(self) -> None:
        text = (
            f"anthropic={SAMPLES['anthropic-key']}\n"
            f"github={SAMPLES['github-token']}\n"
            f"aws={SAMPLES['aws-access-key']}\n"
            f"{SAMPLES['bearer']}\n"
        )
        self._assert_compat("multi-rule mixed", text)

    def test_compat_repeated_same_secret(self) -> None:
        text = (f"x={SAMPLES['anthropic-key']}\n") * 5
        self._assert_compat("5× same anthropic secret", text)

    def test_compat_private_key_block(self) -> None:
        self._assert_compat(
            "private-key block",
            f"intro\n{SAMPLES['private-key']}\noutro\n",
        )

    def test_compat_unicode_padding(self) -> None:
        """Verify Python's str ↔ bytes UTF-8 round-trip matches TS's
        Buffer.from/toString — CJK + emoji shouldn't drift."""
        text = (
            f"プログラム📁 const x = '{SAMPLES['anthropic-key']}';\n"
            f"中文 emoji 🎉 {SAMPLES['github-token']}\n"
        )
        self._assert_compat("unicode + secrets", text)

    # ── v0.3 extensions: cross-lang compat for each new rule ──────────
    # Each test pins byte-identical output between the Python and TS
    # implementations of the same rule. Any drift fails immediately.

    def test_compat_slack_token(self) -> None:
        self._assert_compat(
            "slack token in middle",
            f"line: {SAMPLES['slack-token']}\n",
        )

    def test_compat_slack_webhook_url(self) -> None:
        self._assert_compat(
            "slack webhook url",
            "POST https://hooks.slack.com/services/T01ABCDEFGH/B01ABCDEFGH/abc123def456ghi789jkl012\n",
        )

    def test_compat_jwt(self) -> None:
        self._assert_compat(
            "naked jwt",
            f"cookie=auth_token={SAMPLES['jwt']};\n",
        )

    def test_compat_stripe_live_key(self) -> None:
        self._assert_compat(
            "stripe live key",
            f"STRIPE = '{SAMPLES['stripe-live-key']}'\n",
        )

    def test_compat_env_secret(self) -> None:
        self._assert_compat(
            "env secret line",
            f"{SAMPLES['env-secret']}\nLOG_LEVEL=INFO\n",
        )

    def test_compat_all_v03_rules_mixed(self) -> None:
        """One buffer with one match for each v0.3 rule. Pins that rule
        ordering + placeholder format stay byte-identical end-to-end."""
        text = (
            f"slack: {SAMPLES['slack-token']}\n"
            f"jwt: {SAMPLES['jwt']}\n"
            f"stripe: {SAMPLES['stripe-live-key']}\n"
            f"{SAMPLES['env-secret']}\n"
        )
        self._assert_compat("all v0.3 rules mixed", text)


if __name__ == "__main__":
    unittest.main()
