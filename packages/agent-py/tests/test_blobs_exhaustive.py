"""
Tier 13 — exhaustive coverage of ``spool_agent.blobs`` (BlobStore) and
``spool_agent.hashing`` (sha256, canonical_json, hash_json), plus
cross-language hash + blob compat with the TS collector.

Mirrors TS Tier 5 (``packages/collector/src/blobs.exhaustive.test.ts``)
for the surface the Python SDK exposes (it has no `isProbablyText`
heuristic — the contract is "everything text-redacts unless you pass
``skip_redact=True``", and callers with binary content MUST set the
flag). The cross-language hash tests pin the foundation of
content-addressed storage: a Python SHA must equal a TS SHA for the
same logical content, or the cross-SDK blob store breaks.

Sections:
  1. BlobStore put/get round-trip + dedup (10 tests)
  2. redaction_log + atomic-write + binary semantics (9 tests)
  3. hashing.py (sha256, canonical_json, hash_json) (5 tests)
  4. Cross-language hash + on-disk blob compat (8 tests)
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, List

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent
sys.path.insert(0, str(HERE.parent / "src"))

from spool_agent.blobs import BlobStore  # noqa: E402
from spool_agent.hashing import canonical_json, hash_json, sha256  # noqa: E402
from spool_agent.paths import blob_path, blob_root  # noqa: E402
from spool_agent.store import Store  # noqa: E402


class IsolatedStore(unittest.TestCase):
    """Per-test SPOOL_HOME + a fresh Store + BlobStore."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_home = os.environ.get("SPOOL_HOME")
        os.environ["SPOOL_HOME"] = self._tmp.name
        self.store = Store.open()
        self.bs: BlobStore = self.store.blobs

    def tearDown(self) -> None:
        try:
            self.store.close()
        except Exception:
            pass
        if self._prev_home is None:
            os.environ.pop("SPOOL_HOME", None)
        else:
            os.environ["SPOOL_HOME"] = self._prev_home
        self._tmp.cleanup()

    def _redaction_rows(self, sha: str) -> List[tuple]:
        return self.store.db.execute(
            "SELECT rule, count FROM redaction_log WHERE blob_ref = ?", (sha,)
        ).fetchall()


ANTHROPIC_SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA"


# ─────────────────────────────────────────────────────────────────────
# Section 1 — put/get round-trip + dedup (10 tests)
# ─────────────────────────────────────────────────────────────────────


class TestBlobRoundTrip(IsolatedStore):
    def test_put_string_get_string_round_trip(self) -> None:
        sha = self.bs.put_string("hello, world\n")
        self.assertEqual(self.bs.get_string(sha), "hello, world\n")

    def test_put_json_round_trips_via_get_string(self) -> None:
        sha = self.bs.put_json({"a": 1, "b": [2, 3]})
        # put_json doesn't sort keys — bytes-as-written.
        text = self.bs.get_string(sha)
        self.assertEqual(json.loads(text), {"a": 1, "b": [2, 3]})

    def test_put_bytes_with_skip_redact_round_trips_byte_exact(self) -> None:
        payload = bytes(range(256))  # full byte range, definitely binary
        sha = self.bs.put_bytes(payload, skip_redact=True)
        self.assertEqual(self.bs.get_bytes(sha), payload)

    def test_get_bytes_on_missing_sha_raises_filenotfound(self) -> None:
        with self.assertRaises(FileNotFoundError):
            self.bs.get_bytes("0" * 64)

    def test_get_string_on_missing_sha_raises_filenotfound(self) -> None:
        with self.assertRaises(FileNotFoundError):
            self.bs.get_string("0" * 64)

    def test_try_get_string_returns_none_on_missing_sha(self) -> None:
        self.assertIsNone(self.bs.try_get_string("0" * 64))

    def test_same_content_twice_yields_same_sha(self) -> None:
        a = self.bs.put_string("dedup me\n")
        b = self.bs.put_string("dedup me\n")
        self.assertEqual(a, b)

    def test_put_string_and_put_bytes_of_same_payload_yield_same_sha(self) -> None:
        a = self.bs.put_string("equivalence")
        b = self.bs.put_bytes(b"equivalence", skip_redact=True)
        self.assertEqual(a, b, "text path equivalence between put_string and put_bytes")

    def test_one_byte_diff_yields_different_sha(self) -> None:
        a = self.bs.put_string("hello")
        b = self.bs.put_string("hello!")
        self.assertNotEqual(a, b)

    def test_empty_content_has_canonical_sha(self) -> None:
        # SHA-256 of empty input is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        sha = self.bs.put_string("", skip_redact=True)
        self.assertEqual(
            sha,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )


# ─────────────────────────────────────────────────────────────────────
# Section 2 — redaction_log + atomic-write + binary semantics (9 tests)
# ─────────────────────────────────────────────────────────────────────


class TestRedactionLogAndAtomicWrite(IsolatedStore):
    def test_text_with_secret_redacted_and_log_row_created(self) -> None:
        sha = self.bs.put_string(f"key={ANTHROPIC_SECRET}\n")
        stored = self.bs.get_string(sha)
        self.assertNotIn(ANTHROPIC_SECRET, stored, "raw secret must not survive")
        self.assertIn("«spool:redacted:anthropic-key»", stored)
        rows = self._redaction_rows(sha)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], ("anthropic-key", 1))

    def test_text_without_secret_unchanged_and_no_log_row(self) -> None:
        sha = self.bs.put_string("nothing scary here\n")
        self.assertEqual(self.bs.get_string(sha), "nothing scary here\n")
        self.assertEqual(self._redaction_rows(sha), [])

    def test_skip_redact_true_preserves_secret_and_writes_no_log_row(self) -> None:
        text = f"raw={ANTHROPIC_SECRET}"
        sha = self.bs.put_string(text, skip_redact=True)
        self.assertEqual(self.bs.get_string(sha), text)
        self.assertEqual(self._redaction_rows(sha), [])

    def test_multiple_rules_fire_yield_multiple_log_rows(self) -> None:
        text = (
            f"anthropic={ANTHROPIC_SECRET}\n"
            f"aws=AKIAIOSFODNN7EXAMPLE\n"
            f"ghp=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
        )
        sha = self.bs.put_string(text)
        rule_names = {r[0] for r in self._redaction_rows(sha)}
        self.assertIn("anthropic-key", rule_names)
        self.assertIn("aws-access-key", rule_names)
        self.assertIn("github-token", rule_names)

    def test_repeated_secret_yields_count_equal_to_occurrences(self) -> None:
        text = (f"x={ANTHROPIC_SECRET}\n") * 5
        sha = self.bs.put_string(text)
        rows = self._redaction_rows(sha)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], ("anthropic-key", 5))

    def test_no_tmp_file_lingers_after_successful_put(self) -> None:
        """Atomic-rename contract: the .tmp- file used during write
        must be consumed by os.replace and not left behind."""
        self.bs.put_string("anything")
        # Scan the entire blob root for any .tmp- file.
        leftover = list(blob_root().rglob(".tmp-*"))
        self.assertEqual(leftover, [], f"leftover tmp files: {leftover}")

    def test_repeated_put_of_same_content_does_not_replace_file(self) -> None:
        """Dedup contract: writing identical content twice short-circuits
        before the second os.replace. The first file's mtime is stable."""
        sha = self.bs.put_string("dedup contract")
        path = blob_path(sha)
        mtime_first = path.stat().st_mtime_ns
        # Force a 5ms pause so any second-write mtime would differ.
        import time
        time.sleep(0.005)
        sha2 = self.bs.put_string("dedup contract")
        self.assertEqual(sha, sha2)
        mtime_second = path.stat().st_mtime_ns
        self.assertEqual(
            mtime_first,
            mtime_second,
            "dedup short-circuits before os.replace",
        )

    def test_put_bytes_round_trips_binary_with_skip_redact(self) -> None:
        # Synthetic font-like binary: header + NUL padding + random tail.
        header = bytes([0x77, 0x4F, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00])
        padding = bytes(512)  # all NULs
        tail = os.urandom(256)
        payload = header + padding + tail
        sha = self.bs.put_bytes(payload, skip_redact=True)
        self.assertEqual(self.bs.get_bytes(sha), payload)

    def test_put_bytes_without_skip_redact_corrupts_invalid_utf8(self) -> None:
        """Documented contract: the Python BlobStore has no
        isProbablyText heuristic, so put_bytes ALWAYS decodes through
        UTF-8 (with errors='replace') before redacting. Binary bytes
        get U+FFFD replacement on decode → re-encoded bytes differ from
        the input. Callers with binary MUST pass skip_redact=True.

        This test pins the silent-corruption failure mode so a future
        contributor doesn't accidentally rely on byte-exact round-trip
        without skip_redact."""
        payload = bytes([0xFF, 0xFE, 0x00, 0xC0, 0xAF])  # invalid UTF-8
        sha = self.bs.put_bytes(payload, skip_redact=False)
        stored = self.bs.get_bytes(sha)
        # Bytes are NOT preserved verbatim under the default redact path
        self.assertNotEqual(stored, payload, "documented corruption surface")


# ─────────────────────────────────────────────────────────────────────
# Section 3 — hashing.py (5 tests)
# ─────────────────────────────────────────────────────────────────────


class TestHashing(unittest.TestCase):
    def test_sha256_empty_input_well_known_vector(self) -> None:
        # The SHA-256 of empty input — known constant.
        self.assertEqual(
            sha256(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        self.assertEqual(
            sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )

    def test_sha256_bytes_str_equivalence(self) -> None:
        self.assertEqual(sha256("foo"), sha256(b"foo"))
        self.assertEqual(sha256("héllo"), sha256("héllo".encode("utf-8")))

    def test_canonical_json_sorts_keys_at_every_level(self) -> None:
        v = {"b": 1, "a": {"y": 2, "x": 1}}
        self.assertEqual(canonical_json(v), '{"a":{"x":1,"y":2},"b":1}')

    def test_canonical_json_no_whitespace_utf8_passthrough(self) -> None:
        v = {"name": "プログラム", "tags": ["café", "🎉"]}
        out = canonical_json(v)
        # No whitespace at all
        self.assertNotIn(" ", out)
        self.assertNotIn("\n", out)
        # Unicode passes through (not \u-escaped)
        self.assertIn("プログラム", out)
        self.assertIn("🎉", out)

    def test_hash_json_composes_canonical_then_sha256(self) -> None:
        v = {"b": 1, "a": 2}
        expected = sha256(canonical_json(v))
        self.assertEqual(hash_json(v), expected)


# ─────────────────────────────────────────────────────────────────────
# Section 4 — Cross-language hash + on-disk blob compat (8 tests)
# ─────────────────────────────────────────────────────────────────────


def _node_available() -> bool:
    return shutil.which("node") is not None


def _ts_sha256(text: str) -> str:
    """Compute SHA-256 via the TS sha256() helper."""
    script = """
import { sha256 } from "%s";
import { readFileSync } from "node:fs";
const input = readFileSync(0, "utf-8");
process.stdout.write(sha256(input));
""" % (
        (REPO_ROOT / "packages" / "shared" / "src" / "hash.ts").as_posix()
    )
    proc = subprocess.run(
        ["node", "--import", "tsx/esm", "--input-type=module", "-e", script],
        input=text,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS sha256 subprocess failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def _ts_hash_json(value: Any) -> str:
    """Compute hashJson via the TS hashJson() helper."""
    script = """
import { hashJson } from "%s";
import { readFileSync } from "node:fs";
const v = JSON.parse(readFileSync(0, "utf-8"));
process.stdout.write(hashJson(v));
""" % (
        (REPO_ROOT / "packages" / "shared" / "src" / "hash.ts").as_posix()
    )
    proc = subprocess.run(
        ["node", "--import", "tsx/esm", "--input-type=module", "-e", script],
        input=json.dumps(value),
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS hashJson subprocess failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def _ts_put_string_via_store(spool_home: Path, content: str) -> str:
    """Have the TS BlobStore put a string at the given SPOOL_HOME and
    return the SHA. Argv[1] = SPOOL_HOME, content comes via stdin."""
    script = """
import { Store } from "%s";
import { readFileSync } from "node:fs";
process.env.SPOOL_HOME = process.argv[1];
const store = Store.open();
const content = readFileSync(0, "utf-8");
const sha = await store.blobs.putString(content);
store.close();
process.stdout.write(sha);
""" % (
        (REPO_ROOT / "packages" / "collector" / "src" / "store.ts").as_posix()
    )
    proc = subprocess.run(
        [
            "node",
            "--import",
            "tsx/esm",
            "--input-type=module",
            "-e",
            script,
            "--",
            str(spool_home),
        ],
        input=content,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=20,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS Store put failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def _ts_get_string_via_store(spool_home: Path, sha: str) -> str:
    """Read a blob from the TS BlobStore by SHA."""
    script = """
import { Store } from "%s";
process.env.SPOOL_HOME = process.argv[1];
const store = Store.open();
const text = await store.blobs.getString(process.argv[2]);
store.close();
process.stdout.write(text);
""" % (
        (REPO_ROOT / "packages" / "collector" / "src" / "store.ts").as_posix()
    )
    proc = subprocess.run(
        [
            "node",
            "--import",
            "tsx/esm",
            "--input-type=module",
            "-e",
            script,
            "--",
            str(spool_home),
            sha,
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=20,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS Store get failed: {proc.stderr.strip()}")
    return proc.stdout


class TestCrossLanguageHashCompat(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not _node_available():
            raise unittest.SkipTest("node not on PATH; skipping compat tests")

    def _assert_sha_compat(self, label: str, text: str) -> None:
        py = sha256(text)
        try:
            ts = _ts_sha256(text)
        except RuntimeError as e:
            self.skipTest(f"TS bridge unavailable: {e}")
        self.assertEqual(py, ts, f"{label}: SHA-256 differs between Python and TS")

    def _assert_hash_json_compat(self, label: str, value: Any) -> None:
        py = hash_json(value)
        try:
            ts = _ts_hash_json(value)
        except RuntimeError as e:
            self.skipTest(f"TS bridge unavailable: {e}")
        self.assertEqual(py, ts, f"{label}: hash_json differs between Python and TS")

    # ── SHA-256 byte equivalence ─────────────────────────────────────

    def test_sha256_compat_ascii_text(self) -> None:
        self._assert_sha_compat("ascii", "hello, world\n")

    def test_sha256_compat_empty_string(self) -> None:
        self._assert_sha_compat("empty", "")

    def test_sha256_compat_unicode_text(self) -> None:
        self._assert_sha_compat("unicode", "プログラム 中文 🎉\n")

    # ── canonical_json + hash_json compat ────────────────────────────

    def test_hash_json_compat_simple_object(self) -> None:
        self._assert_hash_json_compat("simple", {"a": 1, "b": 2})

    def test_hash_json_compat_nested_keys_sort_at_every_level(self) -> None:
        # The bug we'd catch: a TS or Python impl that only sorts top-level
        # keys would produce different bytes here.
        self._assert_hash_json_compat(
            "nested",
            {"z": {"b": 1, "a": 2}, "a": [{"y": 1, "x": 2}, {"d": 3, "c": 4}]},
        )

    def test_hash_json_compat_unicode_passes_through(self) -> None:
        # Catches a `ensure_ascii=True` vs `ensure_ascii=False` mismatch.
        self._assert_hash_json_compat(
            "unicode",
            {"name": "プログラム", "emoji": "🎉", "ascii": "ok"},
        )

    # ── on-disk blob compat (Python → TS read, TS → Python read) ─────

    def test_python_puts_string_ts_reads_it_back(self) -> None:
        """The content-addressed blob store must be SDK-agnostic: bytes
        Python wrote must be readable by TS at the same SHA."""
        tmp = tempfile.TemporaryDirectory()
        prev_home = os.environ.get("SPOOL_HOME")
        os.environ["SPOOL_HOME"] = tmp.name
        try:
            store = Store.open()
            content = "cross-language blob payload\n"
            sha = store.blobs.put_string(content, skip_redact=True)
            store.close()
            # Now TS reads the same path.
            try:
                ts_text = _ts_get_string_via_store(Path(tmp.name), sha)
            except RuntimeError as e:
                self.skipTest(f"TS bridge unavailable: {e}")
            self.assertEqual(ts_text, content)
        finally:
            if prev_home is None:
                os.environ.pop("SPOOL_HOME", None)
            else:
                os.environ["SPOOL_HOME"] = prev_home
            tmp.cleanup()

    def test_ts_puts_string_python_reads_it_back(self) -> None:
        """The reverse direction: TS writes a blob, Python reads it back
        at the same SHA. Together with the previous test, pins the
        cross-SDK content-addressing contract in both directions."""
        tmp = tempfile.TemporaryDirectory()
        prev_home = os.environ.get("SPOOL_HOME")
        os.environ["SPOOL_HOME"] = tmp.name
        try:
            content = "ts-written cross-lang payload\n"
            try:
                sha = _ts_put_string_via_store(Path(tmp.name), content)
            except RuntimeError as e:
                self.skipTest(f"TS bridge unavailable: {e}")
            # Now Python reads at the same SHA via its own BlobStore.
            store = Store.open()
            try:
                py_text = store.blobs.get_string(sha)
            finally:
                store.close()
            self.assertEqual(py_text, content)
        finally:
            if prev_home is None:
                os.environ.pop("SPOOL_HOME", None)
            else:
                os.environ["SPOOL_HOME"] = prev_home
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
