import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store, listRuns } from "@meterbility/collector";
import { ingestSession } from "@meterbility/claude-code-adapter";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Turn 6 — `meter files` CLI tests.
 *
 * Strategy: ingest a real session through the same path the
 * adapter tests use, then shell out to the actual CLI binary so the
 * test exercises Commander registration, argument parsing, and the
 * action implementation end-to-end. The store and stripped-down
 * CLAUDE_HOME live under tmpdir; no global state escapes the test.
 *
 * `meter inspect --show files` is exercised via the same subprocess
 * so the `--show` enum extension can't silently regress.
 */

// TEST_DIR resolves to packages/cli/src; the CLI entry sits alongside as
// index.ts. Repo root is three levels up.
const CLI_ENTRY = resolve(TEST_DIR, "index.ts");
const REPO_ROOT = resolve(TEST_DIR, "../../..");

function freshStore(): { home: string; store: Store } {
  const home = mkdtempSync(join(tmpdir(), "meter-files-cli-"));
  process.env.METERBILITY_HOME = home;
  const store = Store.open({ path: join(home, "meterbility.db") });
  return { home, store };
}

function writeRepo(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "meter-files-cli-repo-"));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function writeSession(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "meter-files-cli-sess-"));
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
 * them, ingest done, and the METERBILITY_HOME pre-populated so the
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
  // The CLI subprocess will re-open via METERBILITY_HOME. CLAUDE_HOME points
  // at an empty dir so anything Claude-specific the CLI might try (like
  // doctor) finds an isolated state.
  const claudeHome = mkdtempSync(join(tmpdir(), "meter-files-cli-claude-"));
  return { home, runId, repoCwd, claudeHome };
}

// ─── Default summary mode ────────────────────────────────────────────

test("meter files <run> renders the cumulative summary with header, row, and footer", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId], {
    METERBILITY_HOME: fx.home,
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

test("meter files <run> --json emits structured output with the expected fields", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId, "--json"], {
    METERBILITY_HOME: fx.home,
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

test("meter files <run> --at 0 scopes to one step's changes", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId, "--at", "0"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STEP #0/);
  assert.match(r.stdout, /1 file change\b/);
  assert.match(r.stdout, /M  src\/greet\.ts/);
});

test("meter files <run> --at 0 --json carries step_id and sequence", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId, "--at", "0", "--json"], {
    METERBILITY_HOME: fx.home,
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

test("meter files <run> --diff <path> prints a colorized unified diff", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", fx.runId, "--diff", "src/greet.ts"], {
    METERBILITY_HOME: fx.home,
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

test("meter files <run> --diff <path> --from/--to scopes the step window", async () => {
  const fx = await setupFixture();
  // The only change is at step 0; restricting to step 1+ should
  // show "no changes in window."
  const r = runCli(
    ["files", fx.runId, "--diff", "src/greet.ts", "--from", "1"],
    {
      METERBILITY_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no captured changes for this path in the chosen step window/);
});

// ─── Error paths ─────────────────────────────────────────────────────

test("meter files <unknown-run> exits 1 with a clear error", async () => {
  const fx = await setupFixture();
  const r = runCli(["files", "run_does_not_exist_at_all"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run not found/);
});

test("meter files <run> --diff <path> --from <bogus-step-id> exits 1 with step-not-found", async () => {
  // Non-numeric --from / --to inputs are validated strictly because
  // they're definitely user typos. Numeric inputs out of range are
  // accepted (treated as empty window) — that's the legitimate
  // "show me everything past step N" case the previous test covers.
  const fx = await setupFixture();
  const r = runCli(
    ["files", fx.runId, "--diff", "src/greet.ts", "--from", "stp_does_not_exist"],
    {
      METERBILITY_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /step not found: stp_does_not_exist/);
});

// ─── inspect --show files extension ──────────────────────────────────

test("meter inspect <run> --at 0 --show files lists the FileChange rows", async () => {
  const fx = await setupFixture();
  const r = runCli(
    ["inspect", fx.runId, "--at", "0", "--show", "files"],
    {
      METERBILITY_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /files/);
  assert.match(r.stdout, /1 change/);
  assert.match(r.stdout, /M  src\/greet\.ts/);
});

test("meter inspect <run> --at 0 --show files --diff inlines the unified diff", async () => {
  const fx = await setupFixture();
  const r = runCli(
    ["inspect", fx.runId, "--at", "0", "--show", "files", "--diff"],
    {
      METERBILITY_HOME: fx.home,
      CLAUDE_HOME: fx.claudeHome,
      NO_COLOR: "1",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  // Same diff body the standalone `meter files --diff` would print.
  assert.match(r.stdout, /-function greet/);
  assert.match(r.stdout, /\+function hello/);
});

// ─── Empty / no-capture cases ────────────────────────────────────────

test("meter files <run> on a baseline-less run with no FileChanges gives a helpful empty message", async () => {
  // Build a fresh store with a manually-inserted run that has no
  // FileChanges and no baseline. The "no file changes" message
  // should fire AND mention `meter init`.
  const { home, store } = freshStore();
  const claudeHome = mkdtempSync(join(tmpdir(), "meter-empty-cli-"));
  // Need a real run row. Use the queries layer directly to keep the
  // fixture minimal.
  const { upsertProjectByCwd, upsertAgent, insertRun } = await import(
    "@meterbility/collector"
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
    METERBILITY_HOME: home,
    CLAUDE_HOME: claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no file changes captured for this run/);
  // The hint about `meter init` only fires when there's no baseline,
  // which is also true here.
  assert.match(r.stdout, /meter init/);
});

// ─── Range summary mode: --from/--to without --diff ──────────────────
//
// meter-live design §5 (docs/designs/meter-live-front-door.md): the
// all-files step-window summary. Fixture is built directly against the
// store — range semantics need multiple steps plus a synthetic-band
// step at a controlled timestamp, which is awkward to stage through a
// transcript.

async function setupRangeFixture(): Promise<{
  home: string;
  runId: string;
  claudeHome: string;
}> {
  const { home, store } = freshStore();
  const { upsertProjectByCwd, upsertAgent, insertRun, insertStep, insertFileChange } =
    await import("@meterbility/collector");
  const { randomUUID } = await import("node:crypto");

  const cwd = mkdtempSync(join(tmpdir(), "meter-files-range-cwd-"));
  const project = upsertProjectByCwd(store, cwd, "range-test");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  insertRun(store, {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
    status: "in_progress",
    started_at: "2026-08-19T10:00:00Z",
    cwd,
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 4,
    tags: [],
  });

  const mkStep = (sequence: number, timestamp: string, tool: string): string => {
    const id = `stp_${randomUUID()}`;
    insertStep(store, {
      step_id: id,
      run_id: runId,
      sequence,
      timestamp,
      model: "claude-opus-4-7",
      context_snapshot_id: "snap_r",
      decision_ref: "blob_dec",
      action: { kind: "tool_call", tool_name: tool },
      outcome: { status: "ok" },
      tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
      latency_ms: 0,
      cost_cents: 0,
      tags: [],
      status: "ok",
    });
    return id;
  };

  // Main band: steps 1..3, one minute apart. Synthetic hook band: seq
  // 100000, timestamped BETWEEN steps 2 and 3 so a [2,3] window maps
  // it in by wall clock and a [1,1] window maps it out.
  const s1 = mkStep(1, "2026-08-19T10:00:00Z", "Write");
  const s2 = mkStep(2, "2026-08-19T10:01:00Z", "Write");
  const s3 = mkStep(3, "2026-08-19T10:02:00Z", "Edit");
  const sBand = mkStep(100_000, "2026-08-19T10:01:30Z", "Bash");

  const blob = async (content: string): Promise<string> =>
    store.blobs.putBuffer(Buffer.from(content, "utf-8"));

  const aV1 = await blob("a1\na2\n");
  const aV2 = await blob("a1\nA2!\n");
  const bV1 = await blob("b1\nb2\nb3\n");
  const cV1 = await blob("c1\nc2\nc3\nc4\nc5\n");

  const base = {
    run_id: runId,
    gitignored: false,
    bom: false,
    redacted: false,
    partial_diff: false,
    encoding: "utf-8" as const,
    patch_format: "unified" as const,
  };
  insertFileChange(store, {
    ...base, step_id: s1, sequence: 0, derived_from: "tool_call",
    path: "src/a.ts", op: "create", after_blob_ref: aV1,
    lines_added: 2, lines_removed: 0, patch_text: "+a1\n+a2\n",
    source_tool_name: "Write",
  });
  insertFileChange(store, {
    ...base, step_id: s2, sequence: 0, derived_from: "tool_call",
    path: "src/b.ts", op: "create", after_blob_ref: bV1,
    lines_added: 3, lines_removed: 0, patch_text: "+b1\n+b2\n+b3\n",
    source_tool_name: "Write",
  });
  insertFileChange(store, {
    ...base, step_id: s3, sequence: 0, derived_from: "tool_call",
    path: "src/a.ts", op: "modify", before_blob_ref: aV1, after_blob_ref: aV2,
    lines_added: 1, lines_removed: 1, patch_text: "-a2\n+A2!\n",
    source_tool_name: "Edit",
  });
  insertFileChange(store, {
    ...base, step_id: sBand, sequence: 1000, derived_from: "filesystem_watch",
    path: "scripts/c.sh", op: "create", after_blob_ref: cV1,
    lines_added: 5, lines_removed: 0, patch_text: "+c1\n+c2\n+c3\n+c4\n+c5\n",
  });

  store.close();
  const claudeHome = mkdtempSync(join(tmpdir(), "meter-files-range-claude-"));
  return { home, runId, claudeHome };
}

test("files --from N: window runs to the latest main-band step and includes band rows by wall clock", async () => {
  const fx = await setupRangeFixture();
  const r = runCli(["files", fx.runId, "--from", "2"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RANGE {2}steps 2–3/);
  assert.match(r.stdout, /to current step/);
  // In window: b.ts (step 2), a.ts modify (step 3), c.sh (hook band at
  // 10:01:30, inside the [10:01:00, 10:02:00] wall-clock span).
  assert.match(r.stdout, /src\/b\.ts/);
  assert.match(r.stdout, /src\/a\.ts/);
  assert.match(r.stdout, /scripts\/c\.sh/);
  assert.match(r.stdout, /\(hook\)/);
  assert.match(r.stdout, /1 band-attributed change included/);
  // a.ts shows only the step-3 modify (+1 −1), not the step-1 create.
  assert.match(r.stdout, /M {2}src\/a\.ts/);
  // Totals: 3+1+5 added, 1 removed.
  assert.match(r.stdout, /Window \+9 −1/);
});

test("files --from/--to: a [1,1] window excludes later steps and wall-clock-excludes the band row", async () => {
  const fx = await setupRangeFixture();
  const r = runCli(["files", fx.runId, "--from", "1", "--to", "1"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /src\/a\.ts/);
  assert.doesNotMatch(r.stdout, /src\/b\.ts/);
  assert.doesNotMatch(r.stdout, /scripts\/c\.sh/);
  assert.match(r.stdout, /A {2}src\/a\.ts/); // step-1 create, not the later modify
  assert.match(r.stdout, /Window \+2 −0/);
});

test("files --from N --main-band-only: band row excluded with a visible footer count", async () => {
  const fx = await setupRangeFixture();
  const r = runCli(["files", fx.runId, "--from", "2", "--main-band-only"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /scripts\/c\.sh/);
  assert.match(r.stdout, /1 band-attributed change excluded \(--main-band-only\)/);
  assert.match(r.stdout, /Window \+4 −1/);
});

test("files --at combined with --from/--to errors with exit 2", async () => {
  const fx = await setupRangeFixture();
  const r = runCli(["files", fx.runId, "--at", "2", "--from", "1"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--at cannot be combined with --from\/--to/);
});

test("files --from greater than --to errors with exit 2", async () => {
  const fx = await setupRangeFixture();
  const r = runCli(["files", fx.runId, "--from", "3", "--to", "1"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--from \(3\) must be <= --to \(1\)/);
});

test("files --from past the end of the run yields an empty window, not an error", async () => {
  const fx = await setupRangeFixture();
  const r = runCli(["files", fx.runId, "--from", "50"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no captured changes in this step window/);
});

test("files --from 1 (whole run) --json emits the range structure with band_sources", async () => {
  const fx = await setupRangeFixture();
  const r = runCli(["files", fx.runId, "--from", "1", "--json"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
    NO_COLOR: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as {
    from: number;
    to: number;
    to_is_current: boolean;
    main_band_only: boolean;
    band_changes_included: number;
    band_changes_excluded: number;
    files_touched: number;
    lines_added_total: number;
    lines_removed_total: number;
    files: Array<{ path: string; band_sources?: string[]; change_count: number }>;
  };
  assert.equal(parsed.from, 1);
  assert.equal(parsed.to, 3);
  assert.equal(parsed.to_is_current, true);
  assert.equal(parsed.main_band_only, false);
  assert.equal(parsed.band_changes_included, 1);
  assert.equal(parsed.band_changes_excluded, 0);
  assert.equal(parsed.files_touched, 3);
  assert.equal(parsed.lines_added_total, 11);
  assert.equal(parsed.lines_removed_total, 1);
  const cRow = parsed.files.find((f) => f.path === "scripts/c.sh");
  assert.deepEqual(cRow?.band_sources, ["hook"]);
  const aRow = parsed.files.find((f) => f.path === "src/a.ts");
  assert.equal(aRow?.change_count, 2, "both a.ts changes collapse into one path row");
});
