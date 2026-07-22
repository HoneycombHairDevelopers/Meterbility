import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CLI-boundary tests for `meter capture` — spawn the real entry point
 * the way a Claude Code hook does (JSON payload on stdin) and assert
 * the two contracts the unit tests can't reach:
 *
 *   1. stdin plumbing: the payload is parsed and acted on, and --json
 *      reports what happened.
 *   2. do-no-harm: capture exits 0 even when the store is unusable —
 *      a capture failure must never surface as a hook failure in the
 *      user's agent session.
 *
 * Each spawn pays the tsx cold-start (~1-2s); kept to a minimum.
 */

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

function runCapture(args: string[], opts: { home: string; stdin: string }) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "packages/cli/src/index.ts", "capture", ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, METERBILITY_HOME: opts.home },
      input: opts.stdin,
      encoding: "utf-8",
      timeout: 60_000,
    },
  );
}

test("capture CLI: hook-style stdin payload primes and reports via --json", () => {
  const home = mkdtempSync(join(tmpdir(), "meter-capcli-"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "meter-capcli-root-")));
  writeFileSync(join(root, "a.txt"), "hello\n");
  try {
    const res = runCapture(["pre", "--json"], {
      home,
      stdin: JSON.stringify({ cwd: root, session_id: "s1", tool_name: "Bash" }),
    });
    assert.equal(res.status, 0, res.stderr);
    const summary = JSON.parse(res.stdout.trim().split("\n").pop()!);
    assert.equal(summary.root, root);
    assert.equal(summary.primed, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture CLI: exits 0 even when the store is unusable (do-no-harm)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "meter-capcli-broken-"));
  // METERBILITY_HOME nested under a regular FILE — Store.open cannot
  // mkdir, so everything past payload parsing throws.
  const blocker = join(scratch, "blocker");
  writeFileSync(blocker, "not a directory");
  try {
    const res = runCapture(["post"], {
      home: join(blocker, "nested"),
      stdin: JSON.stringify({ cwd: scratch, session_id: "s1", tool_name: "Bash" }),
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}`);
    assert.match(res.stderr, /meter capture post:/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("capture CLI: unknown phase exits 0 (a typo'd hook must never block the tool)", () => {
  // From a PreToolUse hook, exit code 2 means BLOCK THE TOOL CALL —
  // a misconfigured hook command must report to stderr and stand
  // aside, not freeze every Bash call in the session.
  const home = mkdtempSync(join(tmpdir(), "meter-capcli-phase-"));
  try {
    const res = runCapture(["sideways"], { home, stdin: "{}" });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /unknown phase/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
