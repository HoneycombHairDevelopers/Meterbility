import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store, listRuns } from "@spool-ai/collector";
import { ingestSession } from "@spool-ai/claude-code-adapter";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Turn 6 — `spool files` CLI tests.
 *
 * Strategy: ingest a real session through the same path the
 * adapter tests use, then shell out to the actual CLI binary so the
 * test exercises Commander registration, argument parsing, and the
 * action implementation end-to-end. The store and stripped-down
 * CLAUDE_HOME live under tmpdir; no global state escapes the test.
 *
 * `spool inspect --show files` is exercised via the same subprocess
 * so the `--show` enum extension can't silently regress.
 */

// TEST_DIR resolves to packages/cli/src; the CLI entry sits alongside as
// index.ts. Repo root is three levels up.
const CLI_ENTRY = resolve(TEST_DIR, "index.ts");
const REPO_ROOT = resolve(TEST_DIR, "../../..");

function freshStore(): { home: string; store: Store } {
  const home = mkdtempSync(join(tmpdir(), "spool-files-cli-"));
  process.env.SPOOL_HOME = home;
  const store = Store.open({ path: join(home, "spool.db") });
  return { home, store };
}

function writeRepo(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "spool-files-cli-repo-"));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function writeSession(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-files-cli-sess-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function memoryBackupReader(map: Record<string, string>) {
  return async (sessionId: string, backupFileName: string) => {
    const key = `${sessionId}/${backupFileName}`;
    return map[key] !== undefined ? Buffer.from(map[key], "utf-8") : undefined;
  };
}

/** Run the actual CLI binary in a subprocess. Returns {stdout, stderr, status}. */
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

/**
 * Builds the canonical fixture every test in this file uses: a fake
 * project with two source files, a Claude session that edits one of
 * them, ingest done, and the SPOOL_HOME pre-populated so the
 * subprocess CLI sees real data.
 */
async function setupFixture(): Promise<{
  home: string;
  runId: string;
  repoCwd: string;
  claudeHome: string;
}> {
  const { home, store } = freshStore();
  const repoCwd = writeRepo({
    "src/greet.ts": "function greet() { return 'hi'; }\n",
    "README.md": "# repo\n",
  });
  const session = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-cli-fix", timestamp: "2026-05-15T00:00:00Z",
      cwd: repoCwd,
      message: { role: "user", content: "rename greet" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-cli-fix", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      snapshot: {
        messageId: "a1",
        trackedFileBackups: {
          "src/greet.ts": { backupFileName: "bak-greet" },
        },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-cli-fix", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_e", name: "Edit",
          input: {
            file_path: join(repoCwd, "src/greet.ts"),
            old_string: "greet",
            new_string: "hello",
          },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  const sessionPath = writeSession(session);
  await ingestSession(store, sessionPath, {
    readBackup: memoryBackupReader({
      "sess-cli-fix/bak-greet": "function greet() { return 'hi'; }\n",
    }),
  });
  const runs = listRuns(store);
  const runId = runs[0]!.run_id;
  store.close();
  // The CLI subprocess will re-open via SPOOL_HOME. CLAUDE_HOME points
  // at an empty dir so anything Claude-specific the CLI might try (like
  // doctor) finds an isolated state.
  const claudeHome = mkdtempSync(join(tmpdir(), "spool-files-cli-claude-"));
  return { home, runId, repoCwd, claudeHome };
}

// ─── Default summary mode ────────────────────────────────────────────

test("spool files <run> renders the cumulative summary with header, row, and footer", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId], {
    SPOOL_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
  // Header — runtime + step + file counts.
  assert.match(r.stdout, /RUN  /);
  assert.match(r.stdout, /claude-code · 1 step · 1 file touched/);
  // Per-file row.
  assert.match(r.stdout, /M  src\/greet\.ts/);
  assert.match(r.stdout, /\+1\s+−1/);
  // Footer totals + baseline.
  assert.match(r.stdout, /Final \+1 −1/);
  assert.match(r.stdout, /Baseline:/);
});

test("spool files <run> --json emits structured output with the expected fields", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId, "--json"], {
    SPOOL_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as {
    run_id: string;
    source_runtime: string;
    step_count: number;
    files_touched: number;
    lines_added_total: number;
    lines_removed_total: number;
    files: Array<{ path: string; op: string; lines_added: number }>;
    baseline?: { baseline_tree_id: string };
  };
  assert.equal(parsed.source_runtime, "claude-code");
  assert.equal(parsed.step_count, 1);
  assert.equal(parsed.files_touched, 1);
  assert.equal(parsed.lines_added_total, 1);
  assert.equal(parsed.lines_removed_total, 1);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]!.path, "src/greet.ts");
  assert.equal(parsed.files[0]!.op, "modify");
  // Baseline was captured because the cwd existed during ingest.
  assert.ok(parsed.baseline?.baseline_tree_id);
});

// ─── --at mode ───────────────────────────────────────────────────────

test("spool files <run> --at 0 scopes to one step's changes", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId, "--at", "0"], {
    SPOOL_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STEP #0/);
  assert.match(r.stdout, /1 file change\b/);
  assert.match(r.stdout, /M  src\/greet\.ts/);
});

test("spool files <run> --at 0 --json carries step_id and sequence", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId, "--at", "0", "--json"], {
    SPOOL_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as {
    sequence: number;
    step_id: string;
    files: Array<{ path: string; op: string }>;
  };
  assert.equal(parsed.sequence, 0);
  assert.ok(parsed.step_id.startsWith("stp_"));
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]!.path, "src/greet.ts");
});

// ─── --diff mode ─────────────────────────────────────────────────────

test("spool files <run> --diff <path> prints a colorized unified diff", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId, "--diff", "src/greet.ts"], {
    SPOOL_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DIFF  src\/greet\.ts/);
  assert.match(r.stdout, /@@ step #0/);
  // Patch body — the substitution we did
  assert.match(r.stdout, /-function greet/);
  assert.match(r.stdout, /\+function hello/);
});

test("spool files <run> --diff <path> --from/--to scopes the step window", async () => {
  const fx = await setupFixture();
  // The only change is at step 0; restricting to step 1+ should
  // show "no changes in window."
  const r = runCli(
    ["files", fx.runId, "--diff", "src/greet.ts", "--from", "1"],
    {
      SPOOL_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no captured changes for this path in the chosen step window/);
});

// ─── Error paths ─────────────────────────────────────────────────────

test("spool files <unknown-run> exits 1 with a clear error", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", "run_does_not_exist_at_all"], {
    SPOOL_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run not found/);
});

test("spool files <run> --diff <path> --from <bogus-step-id> exits 1 with step-not-found", async () => {
  // Non-numeric --from / --to inputs are validated strictly because
  // they're definitely user typos. Numeric inputs out of range are
  // accepted (treated as empty window) — that's the legitimate
  // "show me everything past step N" case the previous test covers.
  const fx = await setupFixture();
  const r = runCli(
    ["files", fx.runId, "--diff", "src/greet.ts", "--from", "stp_does_not_exist"],
    {
      SPOOL_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /step not found: stp_does_not_exist/);
});

// ─── inspect --show files extension ──────────────────────────────────

test("spool inspect <run> --at 0 --show files lists the FileChange rows", async () => {
  const fx = await setupFixture();
  const r = runCli(
    ["inspect", fx.runId, "--at", "0", "--show", "files"],
    {
      SPOOL_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /files/);
  assert.match(r.stdout, /1 change/);
  assert.match(r.stdout, /M  src\/greet\.ts/);
});

test("spool inspect <run> --at 0 --show files --diff inlines the unified diff", async () => {
  const fx = await setupFixture();
  const r = runCli(
    ["inspect", fx.runId, "--at", "0", "--show", "files", "--diff"],
    {
      SPOOL_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  // Same diff body the standalone `spool files --diff` would print.
  assert.match(r.stdout, /-function greet/);
  assert.match(r.stdout, /\+function hello/);
});

// ─── Empty / no-capture cases ────────────────────────────────────────

test("spool files <run> on a baseline-less run with no FileChanges gives a helpful empty message", async () => {
  // Build a fresh store with a manually-inserted run that has no
  // FileChanges and no baseline. The "no file changes" message
  // should fire AND mention `spool init`.
  const { home, store } = freshStore();
  const claudeHome = mkdtempSync(join(tmpdir(), "spool-empty-cli-"));
  // Need a real run row. Use the queries layer directly to keep the
  // fixture minimal.
  const { upsertProjectByCwd, upsertAgent, insertRun } = await import(
    "@spool-ai/collector"
  );
  const project = upsertProjectByCwd(store, "/tmp/empty-proj", "empty");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = "run_empty_smoke";
  insertRun(store, {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
    title: "no edits run",
    status: "ok",
    started_at: new Date().toISOString(),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
  });
  store.close();
  const r = runCli(["files", runId], {
    SPOOL_HOME: home,
    CLAUDE_HOME: claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no file changes captured for this run/);
  // The hint about `spool init` only fires when there's no baseline,
  // which is also true here.
  assert.match(r.stdout, /spool init/);
});
