import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
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

const res = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", "--test", "--test-reporter=spec", ...files],
  { stdio: "inherit", env: process.env },
);
process.exit(res.status ?? 1);
