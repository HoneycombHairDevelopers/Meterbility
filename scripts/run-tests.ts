import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Discover *.test.ts files under packages/ and adapters/, then hand them
 * to Node's built-in test runner in one call (Node 20+, spec reporter).
 * One process means one cold-start; the runner gives us a unified summary
 * and per-test pass/fail lines.
 */
const roots = ["packages", "adapters"];
const files: string[] = [];

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full);
    } else if (entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
}

for (const root of roots) walk(root);
files.sort();

if (files.length === 0) {
  console.log("no test files found");
  process.exit(0);
}

// Test files create fixture dirs via mkdtempSync(join(tmpdir(), ...)) and
// never remove them; left alone they accumulate until the disk fills. Every
// call goes through os.tmpdir(), which honors TMPDIR, so point the whole run
// at one run-scoped root and delete just that root when the run passes. On
// failure the root is kept so fixtures stay inspectable. A sibling sweep
// with the same shape lives in packages/server/src/e2e/serve-fixture.ts
// (E2E_HOME_PREFIX); keep their behavior aligned.
const RUN_ROOT_PREFIX = "meter-tests-";
const STALE_MS = 24 * 60 * 60 * 1000;

// EPERM means the pid exists but belongs to another user — that is alive,
// not gone. Only ESRCH proves the owner is dead. A sibling copy lives in
// packages/server/src/e2e/serve-fixture.ts; keep their behavior aligned.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

try {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(RUN_ROOT_PREFIX)) continue;
    const full = join(tmpdir(), entry);
    try {
      const pidMatch = /^(\d+)-/.exec(entry.slice(RUN_ROOT_PREFIX.length));
      if (pidMatch && isProcessAlive(Number(pidMatch[1]))) {
        continue; // that run is still going — never sweep it, whatever its age
      }
      // Dead owner or legacy dir: the age check preserves the keep-on-failure
      // inspection window before the root is reclaimed.
      if (Date.now() - statSync(full).mtimeMs > STALE_MS) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`tmp sweep: could not clean ${full}:`, err);
      }
    }
  }
} catch {
  // tmpdir unreadable — the hygiene sweep is best-effort, never blocks tests
}
const runTmp = mkdtempSync(join(tmpdir(), `${RUN_ROOT_PREFIX}${process.pid}-`));

const res = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", "--test", "--test-reporter=spec", ...files],
  {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: runTmp, TMP: runTmp, TEMP: runTmp },
  },
);

if (res.error) {
  // The runner never launched — surface the real error and don't keep an
  // empty root around pretending it holds fixtures.
  console.error(res.error);
  rmSync(runTmp, { recursive: true, force: true });
  process.exit(1);
}
if (res.status === 0) {
  rmSync(runTmp, { recursive: true, force: true });
} else {
  console.error(`test fixtures kept for inspection: ${runTmp}`);
}
process.exit(res.status ?? 1);
