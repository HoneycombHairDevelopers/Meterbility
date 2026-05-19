import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store, listRuns } from "@spool/collector";
import { ingestSession } from "@spool/claude-code-adapter";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(TEST_DIR, "index.ts");
const REPO_ROOT = resolve(TEST_DIR, "../../..");

/**
 * Regression guard for `spool inspect` rendering. The DEFAULT path
 * (without --pretty-print) must remain byte-stable so existing grep/jq
 * pipelines keep working. The --pretty-print path must emit the new
 * schema-aware layout for action/outcome/decision/cost while leaving
 * context/files alone.
 *
 * NO_COLOR=1 in every subprocess so the captured output is plain text.
 */

function runCli(
  args: string[],
  env: Record<string, string>,
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", CLI_ENTRY, ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, ...env },
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  };
}

async function setupFixture(): Promise<{
  home: string;
  runId: string;
  claudeHome: string;
}> {
  const home = mkdtempSync(join(tmpdir(), "spool-inspect-cli-"));
  process.env.SPOOL_HOME = home;
  const store = Store.open({ path: join(home, "spool.db") });

  const sessionDir = mkdtempSync(join(tmpdir(), "spool-inspect-sess-"));
  const sessionPath = join(sessionDir, "session.jsonl");
  const records = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-pp", timestamp: "2026-05-19T00:00:00Z",
      cwd: REPO_ROOT,
      message: { role: "user", content: "say hi" },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-pp", timestamp: "2026-05-19T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{ type: "text", text: "ok\nall done" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  writeFileSync(sessionPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await ingestSession(store, sessionPath, { readBackup: async () => undefined });
  const runs = listRuns(store);
  const runId = runs[0]!.run_id;
  store.close();
  const claudeHome = mkdtempSync(join(tmpdir(), "spool-inspect-claude-"));
  return { home, runId, claudeHome };
}

test("default inspect output (no --pretty-print) emits raw JSON for action/outcome/cost", async () => {
  const fx = await setupFixture();
  const r = runCli(["inspect", fx.runId, "--at", "0", "--show", "all"], {
    SPOOL_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
  // Raw JSON markers: 2-space indented braces and quoted keys.
  assert.match(r.stdout, /\n      "kind":/);
  assert.match(r.stdout, /\n      "status":/);
  assert.match(r.stdout, /\n      "tokens":/);
  assert.match(r.stdout, /\n      "cost_cents":/);
  // No pretty-mode markers should appear in default output.
  assert.doesNotMatch(r.stdout, /^action\b/m); // pretty's section header
  assert.doesNotMatch(r.stdout, /^cost\b/m);
});

test("--pretty-print routes action/outcome/decision/cost through schema-aware renderer", async () => {
  const fx = await setupFixture();
  const r = runCli(
    ["inspect", fx.runId, "--at", "0", "--show", "all", "--pretty-print"],
    {
      SPOOL_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
  // Pretty section headers appear, indented two spaces from the run frame.
  assert.match(r.stdout, /\n  action\n/);
  assert.match(r.stdout, /\n  outcome\n/);
  assert.match(r.stdout, /\n  cost\n/);
  // Field-label lines (not JSON-shaped) should appear.
  assert.match(r.stdout, /\bkind\s+message\b/);
  assert.match(r.stdout, /\blatency\s+\d+ ms\b/);
  assert.match(r.stdout, /\bcost\s+\$\d/);
  // Multi-line text content should render as ┃ block, not literal \n.
  assert.match(r.stdout, /┃ ok/);
  assert.match(r.stdout, /┃ all done/);
  // Raw JSON braces should NOT appear in the action/outcome/cost bodies.
  // (They may still appear elsewhere — but the four tabs are pretty now.)
  assert.doesNotMatch(r.stdout, /\n      "kind":/);
});

test("--pretty-print --show context is a no-op for the context tab (bespoke renderer wins)", async () => {
  const fx = await setupFixture();
  const r = runCli(
    ["inspect", fx.runId, "--at", "0", "--show", "context", "--pretty-print"],
    {
      SPOOL_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
  // Context output should NOT have action/outcome/cost section headers
  // since they were not requested.
  assert.doesNotMatch(r.stdout, /\n  action\n/);
  assert.doesNotMatch(r.stdout, /\n  cost\n/);
  // It should still print something for context (or skip silently if no
  // snapshot blob — fixture above doesn't have a v0.3 snapshot, so this
  // primarily verifies the flag doesn't crash the CLI).
});
