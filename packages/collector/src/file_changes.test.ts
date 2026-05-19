import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Run, Step } from "@spool/shared";
import { Store } from "./store.ts";
import {
  upsertProjectByCwd,
  upsertAgent,
  insertRun,
  insertStep,
  insertFileChange,
  listFileChanges,
  getFileChange,
  insertBaselineTree,
  getBaselineTree,
  findBaselineByManifest,
  setRunBaselineTree,
  setRunProbeState,
  getRun,
} from "./queries.ts";
import {
  serializeManifest,
  parseManifest,
  loadBaselineTree,
  workingTreeAt,
  applyFileChange,
} from "./replay.ts";

function fresh(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-fc-test-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

/** Build the project + agent + run + N empty steps that the tests need. */
function scaffold(
  store: Store,
  stepCount: number,
): { runId: string; stepIds: string[]; projectId: string } {
  const project = upsertProjectByCwd(store, "/tmp/fctest", "fctest");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
    title: "fc test",
    status: "in_progress",
    started_at: new Date().toISOString(),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
  };
  insertRun(store, run);
  const stepIds: string[] = [];
  for (let i = 0; i < stepCount; i++) {
    const id = `stp_${randomUUID()}`;
    const step: Step = {
      step_id: id,
      run_id: runId,
      sequence: i,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      model: "claude-opus-4-7",
      context_snapshot_id: "snap_x",
      decision_ref: "blob_x",
      action: { kind: "tool_call", tool_name: "Edit" },
      outcome: { status: "ok" },
      tokens: {
        input: 0,
        output: 0,
        cached_read: 0,
        cache_creation: 0,
      },
      latency_ms: 0,
      cost_cents: 0,
      tags: [],
      status: "ok",
    };
    insertStep(store, step);
    stepIds.push(id);
  }
  return { runId, stepIds, projectId: project.project_id };
}

// ─── insertFileChange / getFileChange round-trip ─────────────────────

test("insertFileChange round-trips every field", async () => {
  const store = fresh();
  const { runId, stepIds } = scaffold(store, 1);
  const fc = insertFileChange(store, {
    run_id: runId,
    step_id: stepIds[0]!,
    sequence: 0,
    tool_call_id: "tu_abc",
    derived_from: "tool_call",
    path: "src/auth.ts",
    op: "modify",
    before_blob_ref: "blob_before",
    after_blob_ref: "blob_after",
    partial_diff: false,
    gitignored: false,
    patch_text: "@@ -1,2 +1,3 @@\n hi\n+new line\n bye\n",
    patch_format: "unified",
    encoding: "utf-8",
    bom: false,
    line_endings: "lf",
    mime: "application/typescript",
    language: "typescript",
    size_before: 100,
    size_after: 110,
    line_count_before: 5,
    line_count_after: 6,
    lines_added: 1,
    lines_removed: 0,
    mode_before: 0o100644,
    mode_after: 0o100644,
    source_tool_name: "Edit",
    source_tool_input: { old_string: "hi\nbye", new_string: "hi\nnew line\nbye" },
    redacted: false,
    normalizer_notes: { rename_collapsed: false },
  });
  assert.ok(fc.file_change_id.startsWith("fc_"));
  const fetched = getFileChange(store, fc.file_change_id);
  assert.ok(fetched);
  // Spot-check every category of field — JSON, enum, boolean, optional.
  assert.equal(fetched!.path, "src/auth.ts");
  assert.equal(fetched!.op, "modify");
  assert.equal(fetched!.derived_from, "tool_call");
  assert.equal(fetched!.partial_diff, false);
  assert.equal(fetched!.bom, false);
  assert.equal(fetched!.lines_added, 1);
  assert.deepEqual(fetched!.source_tool_input, {
    old_string: "hi\nbye",
    new_string: "hi\nnew line\nbye",
  });
  assert.deepEqual(fetched!.normalizer_notes, { rename_collapsed: false });
  store.close();
});

test("insertFileChange minimal payload (no optional metadata) survives round-trip", async () => {
  const store = fresh();
  const { runId, stepIds } = scaffold(store, 1);
  // Minimum-required shape per the invariant validator: op='create'
  // needs `after_blob_ref`. Everything else (tool_call_id, patch_text,
  // encoding, line_endings, etc.) stays optional and should come back
  // as undefined.
  const fc = insertFileChange(store, {
    run_id: runId,
    step_id: stepIds[0]!,
    sequence: 0,
    derived_from: "tool_call",
    path: "x.txt",
    op: "create",
    after_blob_ref: "blob_x_after",
    partial_diff: false,
    gitignored: false,
    bom: false,
    lines_added: 0,
    lines_removed: 0,
    redacted: false,
  });
  const fetched = getFileChange(store, fc.file_change_id)!;
  assert.equal(fetched.tool_call_id, undefined);
  assert.equal(fetched.before_blob_ref, undefined);
  assert.equal(fetched.after_blob_ref, "blob_x_after");
  assert.equal(fetched.patch_text, undefined);
  assert.equal(fetched.encoding, undefined);
  assert.equal(fetched.source_tool_input, undefined);
  assert.equal(fetched.normalizer_notes, undefined);
  store.close();
});

// ─── listFileChanges filter combinations ─────────────────────────────

test("listFileChanges filters by runId, stepId, path, and step-sequence", async () => {
  const store = fresh();
  const { runId, stepIds } = scaffold(store, 3);
  // step 0: modify auth.ts, create lib/x.ts
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[0]!, sequence: 0,
    derived_from: "tool_call", path: "src/auth.ts", op: "modify",
    before_blob_ref: "blob_auth_v0", after_blob_ref: "blob_auth_v1",
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 1, lines_removed: 0, redacted: false,
  });
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[0]!, sequence: 1,
    derived_from: "tool_call", path: "src/lib/x.ts", op: "create",
    after_blob_ref: "blob_x_v0",
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 10, lines_removed: 0, redacted: false,
  });
  // step 1: rename old.ts → new.ts (content preserved across rename)
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[1]!, sequence: 0,
    derived_from: "tool_call", path: "src/new.ts", old_path: "src/old.ts",
    op: "rename",
    before_blob_ref: "blob_old", after_blob_ref: "blob_old",
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 0, lines_removed: 0, redacted: false,
  });
  // step 2: delete auth.ts
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[2]!, sequence: 0,
    derived_from: "tool_call", path: "src/auth.ts", op: "delete",
    before_blob_ref: "blob_auth_v1",
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 0, lines_removed: 5, redacted: false,
  });

  // No filter → all four, ordered by (step.seq, fc.seq)
  const all = listFileChanges(store, { runId });
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((f) => f.op), ["modify", "create", "rename", "delete"]);

  // By step
  assert.equal(listFileChanges(store, { stepId: stepIds[0]! }).length, 2);
  assert.equal(listFileChanges(store, { stepId: stepIds[1]! }).length, 1);

  // By path — matches both `path` and `old_path` (for rename traceability)
  const authHistory = listFileChanges(store, { runId, path: "src/auth.ts" });
  assert.deepEqual(authHistory.map((f) => f.op), ["modify", "delete"]);
  const oldPath = listFileChanges(store, { runId, path: "src/old.ts" });
  assert.equal(oldPath.length, 1);
  assert.equal(oldPath[0]!.op, "rename");

  // maxStepSeqExclusive — only step.sequence < N qualifies
  const beforeStep2 = listFileChanges(store, { runId, maxStepSeqExclusive: 2 });
  assert.deepEqual(beforeStep2.map((f) => f.op), ["modify", "create", "rename"]);
  const justBaseline = listFileChanges(store, { runId, maxStepSeqExclusive: 0 });
  assert.equal(justBaseline.length, 0);
  store.close();
});

// ─── baseline_tree CRUD + dedup ──────────────────────────────────────

test("baseline_tree insert + get + findByManifest dedup contract", async () => {
  const store = fresh();
  const { projectId } = scaffold(store, 0);
  const bt = insertBaselineTree(store, {
    project_id: projectId,
    manifest_blob_ref: "sha_manifest_abc",
    git_head: "deadbeef",
    git_dirty: false,
  });
  assert.ok(bt.baseline_tree_id.startsWith("bt_"));
  const fetched = getBaselineTree(store, bt.baseline_tree_id)!;
  assert.equal(fetched.git_head, "deadbeef");
  assert.equal(fetched.git_dirty, false);
  // findByManifest is the dedup-aware lookup
  const same = findBaselineByManifest(store, projectId, "sha_manifest_abc");
  assert.equal(same?.baseline_tree_id, bt.baseline_tree_id);
  const miss = findBaselineByManifest(store, projectId, "sha_does_not_exist");
  assert.equal(miss, undefined);
  store.close();
});

test("setRunBaselineTree links a baseline to a run", async () => {
  const store = fresh();
  const { runId, projectId } = scaffold(store, 0);
  const bt = insertBaselineTree(store, {
    project_id: projectId,
    manifest_blob_ref: "sha_x",
    git_dirty: false,
  });
  setRunBaselineTree(store, runId, bt.baseline_tree_id);
  const run = getRun(store, runId);
  assert.equal(run?.baseline_tree_id, bt.baseline_tree_id);
  store.close();
});

test("setRunProbeState round-trips paused / resumed / null", async () => {
  const store = fresh();
  const { runId } = scaffold(store, 0);
  assert.equal(getRun(store, runId)!.probe_state, undefined);
  setRunProbeState(store, runId, "paused");
  assert.equal(getRun(store, runId)!.probe_state, "paused");
  setRunProbeState(store, runId, "resumed");
  assert.equal(getRun(store, runId)!.probe_state, "resumed");
  setRunProbeState(store, runId, null);
  assert.equal(getRun(store, runId)!.probe_state, undefined);
  store.close();
});

// ─── Manifest serialization round-trip ───────────────────────────────

test("serializeManifest produces sorted, dedup-friendly bytes", () => {
  // Input order: b.ts, a.ts. Output must put a.ts first (bytewise sort).
  const buf = serializeManifest([
    { path: "b.ts", mode: 0o100644, blob_ref: "blob_b" },
    { path: "a.ts", mode: 0o100755, blob_ref: "blob_a" },
  ]);
  // Two identical trees from different insertion orders must serialize
  // byte-identically — that's the whole dedup story.
  const reordered = serializeManifest([
    { path: "a.ts", mode: 0o100755, blob_ref: "blob_a" },
    { path: "b.ts", mode: 0o100644, blob_ref: "blob_b" },
  ]);
  assert.deepEqual(buf, reordered);
  // And the bytes parse back to the same logical entries.
  const parsed = parseManifest(buf);
  assert.deepEqual(parsed, [
    { path: "a.ts", mode: 0o100755, blob_ref: "blob_a" },
    { path: "b.ts", mode: 0o100644, blob_ref: "blob_b" },
  ]);
});

test("serializeManifest handles paths with spaces and unicode", () => {
  const entries = [
    { path: "src/with space.ts", mode: 0o100644, blob_ref: "blob_s" },
    { path: "src/résumé.md", mode: 0o100644, blob_ref: "blob_u" },
    { path: "src/中文.ts", mode: 0o100644, blob_ref: "blob_z" },
  ];
  const round = parseManifest(serializeManifest(entries));
  // Sorted output, but the set of paths matches.
  assert.deepEqual(
    round.map((e) => e.path).sort(),
    entries.map((e) => e.path).sort(),
  );
});

test("serializeManifest rejects paths containing NUL or newline", () => {
  assert.throws(
    () =>
      serializeManifest([
        { path: "bad\0path.ts", mode: 0o100644, blob_ref: "x" },
      ]),
    /illegal byte/,
  );
  assert.throws(
    () =>
      serializeManifest([
        { path: "two\nlines.ts", mode: 0o100644, blob_ref: "x" },
      ]),
    /illegal byte/,
  );
});

test("parseManifest tolerates empty buffer and missing trailing newline", () => {
  assert.deepEqual(parseManifest(Buffer.alloc(0)), []);
  const noTrailingNl = Buffer.concat([
    Buffer.from("a.ts", "utf-8"),
    Buffer.from([0x00]),
    Buffer.from("33188", "utf-8"), // 0o100644
    Buffer.from([0x00]),
    Buffer.from("blob_a", "utf-8"),
  ]);
  const parsed = parseManifest(noTrailingNl);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.path, "a.ts");
});

// ─── workingTreeAt — the spec's §3.6 algorithm ───────────────────────

test("workingTreeAt: unknown run returns empty tree", async () => {
  const store = fresh();
  const tree = await workingTreeAt(store, "run_does_not_exist");
  assert.equal(tree.size, 0);
  store.close();
});

test("workingTreeAt: baseline-only run returns the baseline as-is", async () => {
  const store = fresh();
  const { runId, projectId } = scaffold(store, 0);
  const manifest = serializeManifest([
    { path: "src/a.ts", mode: 0o100644, blob_ref: "blob_a" },
    { path: "src/b.ts", mode: 0o100644, blob_ref: "blob_b" },
  ]);
  const ref = await store.blobs.putBuffer(manifest, { skipRedact: true });
  const bt = insertBaselineTree(store, {
    project_id: projectId,
    manifest_blob_ref: ref,
    git_dirty: false,
  });
  setRunBaselineTree(store, runId, bt.baseline_tree_id);
  const tree = await workingTreeAt(store, runId);
  assert.equal(tree.size, 2);
  assert.equal(tree.get("src/a.ts")?.blob_ref, "blob_a");
  assert.equal(tree.get("src/b.ts")?.mode, 0o100644);
  store.close();
});

test("workingTreeAt: create / modify / delete / rename / chmod compose correctly", async () => {
  const store = fresh();
  const { runId, stepIds, projectId } = scaffold(store, 5);
  // Baseline: a.ts, old.ts, perms.ts
  const manifest = serializeManifest([
    { path: "a.ts", mode: 0o100644, blob_ref: "blob_a_v0" },
    { path: "old.ts", mode: 0o100644, blob_ref: "blob_old" },
    { path: "perms.ts", mode: 0o100644, blob_ref: "blob_perms" },
  ]);
  const ref = await store.blobs.putBuffer(manifest, { skipRedact: true });
  const bt = insertBaselineTree(store, {
    project_id: projectId, manifest_blob_ref: ref, git_dirty: false,
  });
  setRunBaselineTree(store, runId, bt.baseline_tree_id);

  // step 0: modify a.ts
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[0]!, sequence: 0,
    derived_from: "tool_call", path: "a.ts", op: "modify",
    before_blob_ref: "blob_a_v0", after_blob_ref: "blob_a_v1",
    mode_after: 0o100644,
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 1, lines_removed: 0, redacted: false,
  });
  // step 1: create b.ts
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[1]!, sequence: 0,
    derived_from: "tool_call", path: "b.ts", op: "create",
    after_blob_ref: "blob_b", mode_after: 0o100644,
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 5, lines_removed: 0, redacted: false,
  });
  // step 2: rename old.ts → new.ts (content preserved across rename)
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[2]!, sequence: 0,
    derived_from: "tool_call", path: "new.ts", old_path: "old.ts", op: "rename",
    before_blob_ref: "blob_old", after_blob_ref: "blob_old",
    mode_after: 0o100644,
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 0, lines_removed: 0, redacted: false,
  });
  // step 3: chmod perms.ts (content unchanged, mode flips to 0o100755)
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[3]!, sequence: 0,
    derived_from: "tool_call", path: "perms.ts", op: "chmod",
    mode_before: 0o100644, mode_after: 0o100755,
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 0, lines_removed: 0, redacted: false,
  });
  // step 4: delete b.ts (added in step 1)
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[4]!, sequence: 0,
    derived_from: "tool_call", path: "b.ts", op: "delete",
    before_blob_ref: "blob_b",
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 0, lines_removed: 5, redacted: false,
  });

  // After all five steps:
  //   a.ts → blob_a_v1
  //   new.ts → blob_old (renamed from old.ts)
  //   perms.ts → blob_perms, mode 0o100755
  //   old.ts gone, b.ts gone
  const final = await workingTreeAt(store, runId);
  assert.equal(final.get("a.ts")?.blob_ref, "blob_a_v1");
  assert.equal(final.get("new.ts")?.blob_ref, "blob_old");
  assert.equal(final.has("old.ts"), false);
  assert.equal(final.has("b.ts"), false);
  assert.equal(final.get("perms.ts")?.mode, 0o100755);

  // Going into step 2 (rename), the tree should still have old.ts and b.ts
  // because only steps 0 and 1 have applied.
  const before2 = await workingTreeAt(store, runId, { stepSeq: 2 });
  assert.equal(before2.get("a.ts")?.blob_ref, "blob_a_v1"); // step 0 applied
  assert.equal(before2.get("b.ts")?.blob_ref, "blob_b");    // step 1 applied
  assert.equal(before2.has("old.ts"), true);               // step 2 not yet
  assert.equal(before2.has("new.ts"), false);

  // stepSeq=0 → baseline only
  const baseline = await workingTreeAt(store, runId, { stepSeq: 0 });
  assert.equal(baseline.get("a.ts")?.blob_ref, "blob_a_v0");
  assert.equal(baseline.has("b.ts"), false);
  assert.equal(baseline.has("new.ts"), false);
  assert.equal(baseline.get("perms.ts")?.mode, 0o100644);
  store.close();
});

test("workingTreeAt: partial_diff FileChanges are skipped (no content to apply)", async () => {
  const store = fresh();
  const { runId, stepIds, projectId } = scaffold(store, 2);
  const manifest = serializeManifest([
    { path: "a.ts", mode: 0o100644, blob_ref: "blob_a" },
  ]);
  const ref = await store.blobs.putBuffer(manifest, { skipRedact: true });
  const bt = insertBaselineTree(store, {
    project_id: projectId, manifest_blob_ref: ref, git_dirty: false,
  });
  setRunBaselineTree(store, runId, bt.baseline_tree_id);
  // step 0: a Bash partial — no blob refs, no content change to tree.
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[0]!, sequence: 0,
    derived_from: "tool_call", source_tool_name: "Bash",
    path: "a.ts", op: "modify",
    partial_diff: true, // <- the flag
    gitignored: false, bom: false,
    lines_added: 0, lines_removed: 0, redacted: false,
  });
  // step 1: real edit lands
  insertFileChange(store, {
    run_id: runId, step_id: stepIds[1]!, sequence: 0,
    derived_from: "tool_call", source_tool_name: "Edit",
    path: "a.ts", op: "modify",
    before_blob_ref: "blob_a", after_blob_ref: "blob_a_real",
    mode_after: 0o100644,
    partial_diff: false, gitignored: false, bom: false,
    lines_added: 1, lines_removed: 0, redacted: false,
  });
  const tree = await workingTreeAt(store, runId);
  // The partial didn't overwrite baseline; the real edit did.
  assert.equal(tree.get("a.ts")?.blob_ref, "blob_a_real");
  store.close();
});

test("applyFileChange: chmod with no mode_after is a no-op (no zero-mode bug)", () => {
  const tree = new Map([
    ["x.ts", { blob_ref: "blob_x", mode: 0o100644 }],
  ]);
  applyFileChange(tree, { op: "chmod", path: "x.ts" });
  assert.equal(tree.get("x.ts")?.mode, 0o100644);
});

test("loadBaselineTree returns empty when manifest blob is missing", async () => {
  const store = fresh();
  const { projectId } = scaffold(store, 0);
  const bt = insertBaselineTree(store, {
    project_id: projectId,
    manifest_blob_ref: "sha_does_not_exist",
    git_dirty: false,
  });
  const tree = await loadBaselineTree(store, bt);
  assert.equal(tree.size, 0);
  store.close();
});
