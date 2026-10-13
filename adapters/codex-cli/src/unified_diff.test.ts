import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUnifiedDiff, parseUnifiedDiff } from "./unified_diff.ts";

test("applies the real Codex append hunk (add a line after the only line)", () => {
  // Verbatim from the 2026-08-04 rollout's second FileChange item.
  const before = "parity probe v1\n";
  const diff = "@@ -1 +1,2 @@\n parity probe v1\n+edited by codex\n";
  assert.equal(applyUnifiedDiff(before, diff), "parity probe v1\nedited by codex\n");
});

test("applies a replace hunk with surrounding context", () => {
  const before = "a\nb\nc\nd\n";
  const diff = "@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d\n";
  assert.equal(applyUnifiedDiff(before, diff), "a\nB\nc\nd\n");
});

test("applies multiple hunks in order with shifting offsets", () => {
  const before = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const diff = [
    "@@ -1,3 +1,4 @@",
    " l1",
    "+inserted",
    " l2",
    " l3",
    "@@ -10,3 +11,2 @@",
    " l10",
    "-l11",
    " l12",
    "",
  ].join("\n");
  const expected =
    ["l1", "inserted", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", "l12"].join("\n") +
    "\n";
  assert.equal(applyUnifiedDiff(before, diff), expected);
});

test("handles pure deletion to empty and insertion into empty", () => {
  assert.equal(applyUnifiedDiff("only\n", "@@ -1 +0,0 @@\n-only\n"), "");
  assert.equal(applyUnifiedDiff("", "@@ -0,0 +1,2 @@\n+x\n+y\n"), "x\ny\n");
});

test("honors the no-newline-at-end-of-file marker on both sides", () => {
  // Old file lacked a trailing newline; new one has it.
  assert.equal(
    applyUnifiedDiff("a\nb", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n"),
    "a\nb\n",
  );
  // New file lacks a trailing newline.
  assert.equal(
    applyUnifiedDiff("a\nb\n", "@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n"),
    "a\nc",
  );
});

test("skips ---/+++ file headers before the first hunk", () => {
  const diff = "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n";
  assert.equal(applyUnifiedDiff("old\n", diff), "new\n");
});

test("tolerates a drifted hunk offset when the context is unique", () => {
  const before = "x\ny\nz\ntarget\nw\n";
  // Declared at line 1 but the context really lives at line 4.
  const diff = "@@ -1,2 +1,2 @@\n-target\n+TARGET\n w\n";
  assert.equal(applyUnifiedDiff(before, diff), "x\ny\nz\nTARGET\nw\n");
});

test("returns undefined when the context does not match anywhere", () => {
  const before = "parity probe v1\nrewritten by sed\n";
  const diff = "@@ -1,2 +1,2 @@\n parity probe v1\n-edited by codex\n+edited again\n";
  assert.equal(applyUnifiedDiff(before, diff), undefined);
});

test("returns undefined on an unparseable diff", () => {
  assert.equal(applyUnifiedDiff("a\n", "not a diff"), undefined);
  assert.equal(applyUnifiedDiff("a\n", "@@ -1 +1 @@\n?junk\n"), undefined);
  assert.equal(parseUnifiedDiff("@@ -1 +1 @@\n?junk\n"), undefined);
});

test("parse exposes hunk structure", () => {
  const hunks = parseUnifiedDiff("@@ -3,2 +3,3 @@\n a\n+b\n c\n")!;
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.oldStart, 3);
  assert.deepEqual(hunks[0]!.oldLines, ["a", "c"]);
  assert.deepEqual(hunks[0]!.newLines, ["a", "b", "c"]);
  assert.equal(hunks[0]!.newNoEol, false);
});
