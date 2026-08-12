import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CLI-boundary tests for `meter cursor-hook` — spawn the real entry
 * point the way Cursor does (JSON payload on stdin) and pin the
 * fail-open contract the unit tests can't reach: the process ALWAYS
 * exits 0 and, for events that might be permission-gated (including
 * unparseable payloads whose event is unknown), always answers
 * {"continue": true} on stdout so the user's agent is never blocked.
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

function runCursorHook(opts: { home: string; stdin: string }) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "packages/cli/src/index.ts", "cursor-hook"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, METERBILITY_HOME: opts.home },
      input: opts.stdin,
      encoding: "utf-8",
      timeout: 60_000,
    },
  );
}

test("cursor-hook CLI: malformed JSON stdin exits 0 and still answers continue", () => {
  const home = mkdtempSync(join(tmpdir(), "meter-curhook-"));
  try {
    const res = runCursorHook({ home, stdin: "this is {{{ not json" });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      res.stdout.includes('"continue":true'),
      `always-respond contract: stdout was ${JSON.stringify(res.stdout)}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
