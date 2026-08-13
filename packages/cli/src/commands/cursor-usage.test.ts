import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CLI-boundary test for `meter cursor-usage` — argument validation
 * happens BEFORE any store open or network call, exiting 2 (usage
 * error) rather than 1 (runtime failure). One spawn covers both bad
 * shapes to keep the tsx cold-start cost down.
 */

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

function runCursorUsage(args: string[], home: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "packages/cli/src/index.ts", "cursor-usage", ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, METERBILITY_HOME: home },
      encoding: "utf-8",
      timeout: 60_000,
    },
  );
}

test("cursor-usage CLI: --days 0 and --days abc exit 2 before touching store/network", () => {
  const home = mkdtempSync(join(tmpdir(), "meter-curusage-"));
  try {
    const zero = runCursorUsage(["--days", "0"], home);
    assert.equal(zero.status, 2, zero.stderr);
    assert.match(zero.stderr, /invalid --days/);

    const abc = runCursorUsage(["--days", "abc"], home);
    assert.equal(abc.status, 2, abc.stderr);
    assert.match(abc.stderr, /invalid --days/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
