import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hunkCounts,
  isUnifiedDiff,
  lineCount,
  rewriteDiffHeaders,
  shellWriteTargets,
  stripViewNumbering,
} from "./file_changes.ts";

test("rewriteDiffHeaders: git a/<abs> b/<abs> headers become repo-relative; body lines untouched", () => {
  const d = "\ndiff --git a/home/u/repo/x.js b/home/u/repo/x.js\n--- a/home/u/repo/x.js\n+++ b/home/u/repo/x.js\n@@ -1 +1 @@\n-/home/u/repo/x.js\n+y\n";
  assert.equal(
    rewriteDiffHeaders(d, "/home/u/repo/x.js", "x.js"),
    "\ndiff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-/home/u/repo/x.js\n+y\n",
  );
  assert.equal(rewriteDiffHeaders(d, "x.js", "x.js"), d);
});

test("stripViewNumbering: real 'N. ' format incl. empty lines; refuses non-numbered input", () => {
  // Observed shape: empty lines are "6. " (trailing space); content keeps
  // its own indentation after the single separator space.
  assert.equal(stripViewNumbering("1. a\n2. \n3.   indented\n4. "), "a\n\n  indented\n");
  assert.equal(stripViewNumbering("1."), "");
  assert.equal(stripViewNumbering(""), "");
  // "10. x" must not lose the leading digit of a line like "1. 0. x".
  assert.equal(stripViewNumbering("1. 0. x"), "0. x");
  // Directory listings / truncation notices are not file images.
  assert.equal(stripViewNumbering("README.md\nsrc\n"), undefined);
  assert.equal(stripViewNumbering("1. a\n... (truncated)"), undefined);
});

test("hunkCounts / isUnifiedDiff: count +/- inside hunks only, across files", () => {
  const d =
    "\ndiff --git a/x b/x\nindex 0000000..0000000 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+extra\n c\n" +
    "diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-old\n+new\n";
  assert.equal(isUnifiedDiff(d), true);
  assert.deepEqual(hunkCounts(d), { added: 3, removed: 2 });
  assert.equal(isUnifiedDiff("File /x updated with changes."), false);
  assert.equal(isUnifiedDiff("--- not a diff\n+++ either"), false);
});

test("lineCount: trailing newline does not add a line; empty is 0", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a"), 1);
  assert.equal(lineCount("a\n"), 1);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\r\nb"), 2);
});

test("shellWriteTargets: redirect targets parsed from the command, confirmed by shellToolInfo.possiblePaths", () => {
  const info = (possiblePaths: string[], flag = true) => ({
    possiblePaths,
    hasWriteFileRedirection: flag,
  });
  assert.deepEqual(
    shellWriteTargets("npm start > /tmp/b.log 2>&1 &", info(["/tmp/b.log", "start"])),
    ["/tmp/b.log"],
  );
  assert.deepEqual(
    shellWriteTargets("echo hi >> notes.md; echo x > /dev/null", info(["/repo/notes.md", "/dev/null"])),
    ["/repo/notes.md"],
  );
  assert.deepEqual(
    shellWriteTargets("cat > \"/repo/a b.md\" <<'EOF'\nx\nEOF", info(["/repo/a b.md"])),
    ["/repo/a b.md"],
  );
  // CLI did not flag a write → nothing, even with a `>` in the text.
  assert.deepEqual(shellWriteTargets("grep '>' file", info(["file"], false)), []);
  // Flagged but the target is not among possiblePaths → nothing (caller
  // falls back to the generic stub).
  assert.deepEqual(shellWriteTargets("cmd > out.txt", info(["cmd"])), []);
  // 2>&1 and here-strings are not file targets.
  assert.deepEqual(shellWriteTargets("cmd 2>&1 <<< 'x'", info(["cmd"])), []);
  assert.deepEqual(shellWriteTargets("cmd > x", undefined), []);
});
