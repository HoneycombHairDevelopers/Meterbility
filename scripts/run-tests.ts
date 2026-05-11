import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

let failed = 0;
for (const f of files) {
  const res = spawnSync("npx", ["tsx", f], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    failed += 1;
    console.error(`\n✖ FAILED: ${f}\n`);
  } else {
    console.log(`✔ ${f}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test file(s) passed`);
