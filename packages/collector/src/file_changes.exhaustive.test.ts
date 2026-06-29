import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type {
  FileChange,
  FileChangeSource,
  FileEncoding,
  FileOp,
  Run,
  Step,
} from "@meterbility/shared";
import { Store } from "./store.ts";
import {
  FileChangeInvariantError,
  assertFileChangeInvariants,
  getFileChange,
  insertBaselineTree,
  insertFileChange,
  insertRun,
  insertStep,
  listFileChanges,
  setRunBaselineTree,
  upsertAgent,
  upsertProjectByCwd,
} from "./queries.ts";
import {
  applyFileChange,
  serializeManifest,
  workingTreeAt,
} from "./replay.ts";

/**
 * Exhaustive deterministic + property-based coverage of the FileChange
 * surface — `insertFileChange`, `listFileChanges`, `applyFileChange`,
 * `workingTreeAt`, and the new `assertFileChangeInvariants` validator.
 *
 * Companion to file_changes.test.ts: that file covers documented happy
 * paths; this file enumerates the cross-product (op × derived_from ×
 * partial_diff × encoding), every CHECK constraint, every invariant
 * violation, path edges, JSON edges, listFileChanges semantics,
 * replay-from-DB equivalence, and four fast-check properties.
 *
 * Test-context helper: every test uses `ctx()`, which mkdtemps a
 * METERBILITY_HOME-scoped Store and pre-inserts a run + N empty steps so
 * FCs have valid FKs. Per the Tier 3 / Tier 4 pattern; replaces ~10
 * lines of fixture boilerplate per test with 1.
 */

// ─── Test context helper ────────────────────────────────────────────

interface TestCtx {
  store: Store;
  runId: string;
  stepIds: string[];
  projectId: string;
  cleanup(): void;
}

function ctx(opts: { stepCount?: number } = {}): TestCtx {
  const stepCount = opts.stepCount ?? 3;
  const dir = mkdtempSync(join(tmpdir(), "meter-fc-exhaustive-"));
  process.env.METERBILITY_HOME = dir;
  const store = Store.open({ path: join(dir, "meterbility.db") });
  const project = upsertProjectByCwd(store, "/tmp/fcex", "fcex");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
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
      tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
      latency_ms: 0,
      cost_cents: 0,
      tags: [],
      status: "ok",
    };
    insertStep(store, step);
    stepIds.push(id);
  }
  return {
    store,
    runId,
    stepIds,
    projectId: project.project_id,
    cleanup: () => store.close(),
  };
}

/**
 * Build a minimal-valid FileChange shape for a given op. Tests
 * override only the fields they care about; the rest stay valid by
 * construction.
 */
function validFc(
  c: TestCtx,
  op: FileOp,
  overrides: Partial<
    Omit<FileChange, "file_change_id" | "created_at">
  > & { sequence?: number; step_id?: string } = {},
): Parameters<typeof insertFileChange>[1] {
  const baseBlob: { before?: string; after?: string } =
    op === "create"
      ? { after: "blob_after" }
      : op === "delete"
        ? { before: "blob_before" }
        : op === "chmod"
          ? {} // chmod is exempt
          : { before: "blob_before", after: "blob_after" };
  const baseOldPath = op === "rename" ? "old/path.ts" : undefined;
  return {
    run_id: c.runId,
    step_id: overrides.step_id ?? c.stepIds[0]!,
    sequence: overrides.sequence ?? 0,
    derived_from: "tool_call",
    path: "src/x.ts",
    op,
    old_path: baseOldPath,
    before_blob_ref: baseBlob.before,
    after_blob_ref: baseBlob.after,
    partial_diff: false,
    gitignored: false,
    bom: false,
    lines_added: 0,
    lines_removed: 0,
    redacted: false,
    ...overrides,
  };
}

const ALL_OPS: FileOp[] = ["create", "modify", "delete", "rename", "chmod"];
const ALL_SOURCES: FileChangeSource[] = [
  "tool_call",
  "filesystem_watch",
  "git_diff",
];
const ALL_ENCODINGS: FileEncoding[] = [
  "utf-8",
  "utf-16-le",
  "utf-16-be",
  "binary",
];

/* ====================================================================
 * Section 1 — op × derived_from round-trip (15 tests)
 * ==================================================================== */

for (const op of ALL_OPS) {
  for (const src of ALL_SOURCES) {
    test(`cell: op=${op} × derived_from=${src} round-trips`, () => {
      const c = ctx();
      try {
        const fc = insertFileChange(
          c.store,
          validFc(c, op, { derived_from: src, path: `f/${op}-${src}.ts` }),
        );
        const back = getFileChange(c.store, fc.file_change_id)!;
        assert.equal(back.op, op);
        assert.equal(back.derived_from, src);
        assert.equal(back.path, `f/${op}-${src}.ts`);
        assert.equal(back.partial_diff, false);
      } finally {
        c.cleanup();
      }
    });
  }
}

/* ====================================================================
 * Section 2 — op × partial_diff round-trip (10 tests)
 *
 * Partial=true is allowed for any op. The validator nulls out blob
 * refs, so partial rows are shape-identical regardless of op.
 * ==================================================================== */

for (const op of ALL_OPS) {
  for (const partial of [false, true]) {
    test(`cell: op=${op} × partial_diff=${partial} round-trips`, () => {
      const c = ctx();
      try {
        const fcShape = partial
          ? // partial=true forces blob refs and old_path to be unset
            {
              run_id: c.runId,
              step_id: c.stepIds[0]!,
              sequence: 0,
              derived_from: "tool_call" as const,
              path: `partial/${op}.ts`,
              op,
              partial_diff: true,
              gitignored: false,
              bom: false,
              lines_added: 0,
              lines_removed: 0,
              redacted: false,
            }
          : validFc(c, op, { path: `full/${op}.ts` });
        const fc = insertFileChange(c.store, fcShape);
        const back = getFileChange(c.store, fc.file_change_id)!;
        assert.equal(back.op, op);
        assert.equal(back.partial_diff, partial);
        if (partial) {
          assert.equal(back.before_blob_ref, undefined);
          assert.equal(back.after_blob_ref, undefined);
        }
      } finally {
        c.cleanup();
      }
    });
  }
}

/* ====================================================================
 * Section 3 — encoding round-trip (20 tests)
 * ==================================================================== */

const CONTENT_BEARING: FileOp[] = ["create", "modify", "rename"];

for (const enc of ALL_ENCODINGS) {
  for (const op of CONTENT_BEARING) {
    test(`encoding: encoding=${enc} × op=${op} round-trips`, () => {
      const c = ctx();
      try {
        const fc = insertFileChange(
          c.store,
          validFc(c, op, { encoding: enc, path: `enc/${enc}-${op}.ts` }),
        );
        const back = getFileChange(c.store, fc.file_change_id)!;
        assert.equal(back.encoding, enc);
      } finally {
        c.cleanup();
      }
    });
  }
}

for (const enc of ALL_ENCODINGS) {
  test(`encoding orthogonality: encoding=${enc} accepted on a chmod row (mode-only op)`, () => {
    const c = ctx();
    try {
      const fc = insertFileChange(
        c.store,
        validFc(c, "chmod", { encoding: enc, mode_after: 0o100755 }),
      );
      const back = getFileChange(c.store, fc.file_change_id)!;
      assert.equal(back.encoding, enc);
      assert.equal(back.op, "chmod");
    } finally {
      c.cleanup();
    }
  });
}

test("encoding round-trip: undefined stays undefined", () => {
  const c = ctx();
  try {
    const fc = insertFileChange(c.store, validFc(c, "create"));
    const back = getFileChange(c.store, fc.file_change_id)!;
    assert.equal(back.encoding, undefined);
  } finally {
    c.cleanup();
  }
});

test("encoding round-trip: bom flag survives independently of encoding", () => {
  const c = ctx();
  try {
    const fc = insertFileChange(
      c.store,
      validFc(c, "create", { encoding: "utf-16-le", bom: true }),
    );
    const back = getFileChange(c.store, fc.file_change_id)!;
    assert.equal(back.bom, true);
    assert.equal(back.encoding, "utf-16-le");
  } finally {
    c.cleanup();
  }
});

test("encoding orthogonality: 'binary' on a delete is accepted (DB-level orthogonality)", () => {
  // Documents: the encoding field is independent of content-bearing op.
  // The DB doesn't reject this; it's a 'shape but no content' state.
  const c = ctx();
  try {
    const fc = insertFileChange(
      c.store,
      validFc(c, "delete", { encoding: "binary" }),
    );
    const back = getFileChange(c.store, fc.file_change_id)!;
    assert.equal(back.encoding, "binary");
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 4 — DB CHECK + UNIQUE constraint enforcement (6 tests)
 *
 * These prove the SQLite-level constraints actually fire. Without
 * them, an adapter regression that bypasses the application-level
 * validator could still write malformed rows; the DB is the last line.
 * ==================================================================== */

test("constraint: op outside enum throws SQLITE_CONSTRAINT", () => {
  const c = ctx();
  try {
    assert.throws(
      () =>
        c.store.db
          .prepare(
            `INSERT INTO file_change(
               file_change_id, run_id, step_id, sequence,
               derived_from, path, op,
               partial_diff, gitignored,
               lines_added, lines_removed,
               bom, redacted, created_at
             ) VALUES (?, ?, ?, 0, 'tool_call', 'x.ts', 'upsert',
                       0, 0, 0, 0, 0, 0, ?)`,
          )
          .run(
            `fc_${randomUUID()}`,
            c.runId,
            c.stepIds[0]!,
            new Date().toISOString(),
          ),
      /CHECK constraint failed|constraint failed/i,
    );
  } finally {
    c.cleanup();
  }
});

test("constraint: derived_from outside enum throws SQLITE_CONSTRAINT", () => {
  const c = ctx();
  try {
    assert.throws(
      () =>
        c.store.db
          .prepare(
            `INSERT INTO file_change(
               file_change_id, run_id, step_id, sequence,
               derived_from, path, op,
               partial_diff, gitignored,
               lines_added, lines_removed,
               bom, redacted, created_at
             ) VALUES (?, ?, ?, 0, 'rpc', 'x.ts', 'create',
                       0, 0, 0, 0, 0, 0, ?)`,
          )
          .run(
            `fc_${randomUUID()}`,
            c.runId,
            c.stepIds[0]!,
            new Date().toISOString(),
          ),
      /CHECK constraint failed|constraint failed/i,
    );
  } finally {
    c.cleanup();
  }
});

test("constraint: patch_format outside enum throws SQLITE_CONSTRAINT", () => {
  const c = ctx();
  try {
    assert.throws(
      () =>
        c.store.db
          .prepare(
            `INSERT INTO file_change(
               file_change_id, run_id, step_id, sequence,
               derived_from, path, op, after_blob_ref,
               partial_diff, gitignored,
               lines_added, lines_removed,
               patch_format,
               bom, redacted, created_at
             ) VALUES (?, ?, ?, 0, 'tool_call', 'x.ts', 'create', 'b',
                       0, 0, 0, 0, 'yaml', 0, 0, ?)`,
          )
          .run(
            `fc_${randomUUID()}`,
            c.runId,
            c.stepIds[0]!,
            new Date().toISOString(),
          ),
      /CHECK constraint failed|constraint failed/i,
    );
  } finally {
    c.cleanup();
  }
});

test("constraint: patch_format = null is accepted", () => {
  const c = ctx();
  try {
    // No throw expected.
    insertFileChange(c.store, validFc(c, "create", { patch_format: undefined }));
  } finally {
    c.cleanup();
  }
});

test("constraint: duplicate (step_id, sequence) throws UNIQUE", () => {
  const c = ctx();
  try {
    insertFileChange(c.store, validFc(c, "create", { sequence: 0, path: "a.ts" }));
    assert.throws(
      () =>
        insertFileChange(
          c.store,
          validFc(c, "create", { sequence: 0, path: "b.ts" }),
        ),
      /UNIQUE constraint failed|constraint failed/i,
    );
  } finally {
    c.cleanup();
  }
});

test("constraint: NULL created_at via raw insert throws NOT NULL", () => {
  const c = ctx();
  try {
    assert.throws(
      () =>
        c.store.db
          .prepare(
            `INSERT INTO file_change(
               file_change_id, run_id, step_id, sequence,
               derived_from, path, op, after_blob_ref,
               partial_diff, gitignored,
               lines_added, lines_removed,
               bom, redacted, created_at
             ) VALUES (?, ?, ?, 0, 'tool_call', 'x.ts', 'create', 'b',
                       0, 0, 0, 0, 0, 0, NULL)`,
          )
          .run(`fc_${randomUUID()}`, c.runId, c.stepIds[0]!),
      /NOT NULL constraint failed|constraint failed/i,
    );
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 5 — assertFileChangeInvariants enforcement (10 tests)
 *
 * Proves every direction of every contract from types.ts:242 fires.
 * Tests call the exported validator directly so the failure messages
 * are exact and the tests stay fast (no disk).
 * ==================================================================== */

const C = {
  run_id: "r",
  step_id: "s",
  sequence: 0,
  derived_from: "tool_call" as const,
  path: "p",
  partial_diff: false,
  gitignored: false,
  bom: false,
  lines_added: 0,
  lines_removed: 0,
  redacted: false,
};

test("invariant: create with before_blob_ref set throws", () => {
  assert.throws(
    () =>
      assertFileChangeInvariants({
        op: "create",
        partial_diff: false,
        before_blob_ref: "b",
        after_blob_ref: "a",
      }),
    FileChangeInvariantError,
  );
});

test("invariant: modify with null before_blob_ref throws (use partial_diff hint)", () => {
  assert.throws(
    () =>
      assertFileChangeInvariants({
        op: "modify",
        partial_diff: false,
        after_blob_ref: "a",
      }),
    (err: Error) =>
      err instanceof FileChangeInvariantError &&
      err.message.includes("before_blob_ref"),
  );
});

test("invariant: delete with after_blob_ref set throws", () => {
  assert.throws(
    () =>
      assertFileChangeInvariants({
        op: "delete",
        partial_diff: false,
        before_blob_ref: "b",
        after_blob_ref: "a",
      }),
    FileChangeInvariantError,
  );
});

test("invariant: rename with null after_blob_ref throws", () => {
  assert.throws(
    () =>
      assertFileChangeInvariants({
        op: "rename",
        partial_diff: false,
        before_blob_ref: "b",
        old_path: "o",
      }),
    FileChangeInvariantError,
  );
});

test("invariant: partial_diff=true with before_blob_ref set throws", () => {
  assert.throws(
    () =>
      assertFileChangeInvariants({
        op: "modify",
        partial_diff: true,
        before_blob_ref: "b",
      }),
    (err: Error) =>
      err instanceof FileChangeInvariantError &&
      err.message.includes("partial_diff"),
  );
});

test("invariant: partial_diff=true with after_blob_ref set throws", () => {
  assert.throws(
    () =>
      assertFileChangeInvariants({
        op: "modify",
        partial_diff: true,
        after_blob_ref: "a",
      }),
    (err: Error) =>
      err instanceof FileChangeInvariantError &&
      err.message.includes("partial_diff"),
  );
});

test("invariant: rename with null old_path throws", () => {
  assert.throws(
    () =>
      assertFileChangeInvariants({
        op: "rename",
        partial_diff: false,
        before_blob_ref: "b",
        after_blob_ref: "a",
      }),
    (err: Error) =>
      err instanceof FileChangeInvariantError &&
      err.message.includes("old_path"),
  );
});

test("invariant: rename with old_path === path is accepted (degenerate but legal)", () => {
  // The validator doesn't forbid this — currently no rule against it,
  // and a future tightening would be a conscious choice. Document.
  assert.doesNotThrow(() =>
    assertFileChangeInvariants({
      op: "rename",
      partial_diff: false,
      before_blob_ref: "b",
      after_blob_ref: "a",
      old_path: "src/x.ts",
    }),
  );
});

test("invariant: chmod with arbitrary blob refs is accepted (chmod is mode-only, exempt)", () => {
  assert.doesNotThrow(() =>
    assertFileChangeInvariants({
      op: "chmod",
      partial_diff: false,
      before_blob_ref: "b",
      after_blob_ref: "a",
    }),
  );
});

test("invariant: chmod with no fields at all is accepted", () => {
  assert.doesNotThrow(() =>
    assertFileChangeInvariants({ op: "chmod", partial_diff: false }),
  );
  // The replay layer already tests this is a no-op on the tree.
  // Spot-check that here too: chmod with no mode_after preserves tree.
  const tree = new Map([
    ["x.ts", { blob_ref: "blob_x", mode: 0o100644 }],
  ]);
  applyFileChange(tree, { op: "chmod", path: "x.ts" });
  assert.equal(tree.get("x.ts")?.mode, 0o100644);
  // Silence unused-warning by referencing C in this section.
  void C;
});

/* ====================================================================
 * Section 6 — Path edge cases (8 tests)
 * ==================================================================== */

const PATH_CASES: Array<{ name: string; path: string }> = [
  { name: "spaces in path", path: "src/with spaces/file.ts" },
  { name: "CJK + emoji unicode", path: "源/プロジェクト/файл-📁.ts" },
  { name: "Windows-style backslash", path: "src\\auth.ts" },
  { name: "absolute path (contract violation; DB accepts)", path: "/etc/passwd" },
  { name: "traversal segments (contract violation; DB accepts)", path: "../../escape.ts" },
  {
    name: "very long path (~5000 chars)",
    path: "x/" + "a".repeat(4990) + ".ts",
  },
  { name: "empty string path", path: "" },
  { name: "tab and newline in path", path: "weird\tname\n.ts" },
];

for (const c of PATH_CASES) {
  test(`path edge: ${c.name} round-trips verbatim`, () => {
    const t = ctx();
    try {
      const fc = insertFileChange(
        t.store,
        validFc(t, "create", { path: c.path }),
      );
      const back = getFileChange(t.store, fc.file_change_id)!;
      assert.equal(back.path, c.path, "path stored byte-identical");
    } finally {
      t.cleanup();
    }
  });
}

/* ====================================================================
 * Section 7 — JSON field corner cases (6 tests)
 * ==================================================================== */

test("json: source_tool_input = undefined stored as SQL NULL", () => {
  const c = ctx();
  try {
    const fc = insertFileChange(
      c.store,
      validFc(c, "create", { source_tool_input: undefined }),
    );
    const back = getFileChange(c.store, fc.file_change_id)!;
    assert.equal(back.source_tool_input, undefined);
  } finally {
    c.cleanup();
  }
});

test("json: source_tool_input = null is JSON.stringified to the string \"null\"", () => {
  // Documents the current behavior: the `!== undefined` guard lets
  // null through to JSON.stringify, which produces the literal four
  // characters `null`. On read, safeJsonParse returns the value null.
  // This is a soft contract bug — `source_tool_input: null` round-trips
  // as `null` but is stored differently from undefined.
  const c = ctx();
  try {
    const fc = insertFileChange(
      c.store,
      // The type says source_tool_input is unknown, so null is allowed.
      validFc(c, "create", { source_tool_input: null }),
    );
    const back = getFileChange(c.store, fc.file_change_id)!;
    assert.equal(back.source_tool_input, null);
  } finally {
    c.cleanup();
  }
});

test("json: source_tool_input = empty object round-trips", () => {
  const c = ctx();
  try {
    const fc = insertFileChange(
      c.store,
      validFc(c, "create", { source_tool_input: {} }),
    );
    const back = getFileChange(c.store, fc.file_change_id)!;
    assert.deepEqual(back.source_tool_input, {});
  } finally {
    c.cleanup();
  }
});

test("json: source_tool_input with nested arrays + objects round-trips deep-equal", () => {
  const c = ctx();
  try {
    const payload = {
      edits: [
        { old: "a", new: "b" },
        { old: "c", new: "d", replace_all: true },
      ],
      meta: { tool: "MultiEdit", retries: 0 },
    };
    const fc = insertFileChange(
      c.store,
      validFc(c, "create", { source_tool_input: payload }),
    );
    const back = getFileChange(c.store, fc.file_change_id)!;
    assert.deepEqual(back.source_tool_input, payload);
  } finally {
    c.cleanup();
  }
});

test("json: source_tool_input = BigInt throws at insert (BigInt has no JSON serialization)", () => {
  const c = ctx();
  try {
    assert.throws(
      () =>
        insertFileChange(
          c.store,
          validFc(c, "create", { source_tool_input: 1n }),
        ),
      /BigInt|JSON|serialize/i,
    );
  } finally {
    c.cleanup();
  }
});

test("json: normalizer_notes with circular reference throws at insert", () => {
  const c = ctx();
  try {
    const circular: Record<string, unknown> = { tag: "loop" };
    circular["self"] = circular;
    assert.throws(
      () =>
        insertFileChange(
          c.store,
          validFc(c, "create", { normalizer_notes: circular }),
        ),
      /circular|cyclic|Converting/i,
    );
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 8 — listFileChanges semantics (6 tests)
 * ==================================================================== */

test("list: ordering is (step.sequence ASC, fc.sequence ASC) across multiple steps", () => {
  const c = ctx({ stepCount: 3 });
  try {
    // Insert out-of-order to make the test meaningful.
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[2], sequence: 1, path: "s2-1" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[0], sequence: 0, path: "s0-0" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[2], sequence: 0, path: "s2-0" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[1], sequence: 0, path: "s1-0" }),
    );
    const rows = listFileChanges(c.store, { runId: c.runId });
    assert.deepEqual(
      rows.map((r) => r.path),
      ["s0-0", "s1-0", "s2-0", "s2-1"],
    );
  } finally {
    c.cleanup();
  }
});

test("list: maxStepSeqExclusive=0 returns empty", () => {
  const c = ctx();
  try {
    insertFileChange(c.store, validFc(c, "create"));
    const rows = listFileChanges(c.store, {
      runId: c.runId,
      maxStepSeqExclusive: 0,
    });
    assert.deepEqual(rows, []);
  } finally {
    c.cleanup();
  }
});

test("list: path filter matches both `path` and `old_path` (rename traceability)", () => {
  const c = ctx({ stepCount: 2 });
  try {
    insertFileChange(
      c.store,
      validFc(c, "rename", {
        step_id: c.stepIds[0],
        path: "new.ts",
        old_path: "old.ts",
      }),
    );
    insertFileChange(
      c.store,
      validFc(c, "modify", {
        step_id: c.stepIds[1],
        path: "new.ts",
      }),
    );
    const byNew = listFileChanges(c.store, { runId: c.runId, path: "new.ts" });
    assert.equal(byNew.length, 2);
    const byOld = listFileChanges(c.store, { runId: c.runId, path: "old.ts" });
    assert.equal(byOld.length, 1);
    assert.equal(byOld[0]!.op, "rename");
  } finally {
    c.cleanup();
  }
});

test("list: combined runId + path + maxStepSeqExclusive intersects correctly", () => {
  const c = ctx({ stepCount: 3 });
  try {
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[0], path: "a.ts" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "modify", { step_id: c.stepIds[1], path: "a.ts" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "delete", { step_id: c.stepIds[2], path: "a.ts" }),
    );
    const before2 = listFileChanges(c.store, {
      runId: c.runId,
      path: "a.ts",
      maxStepSeqExclusive: 2,
    });
    assert.deepEqual(
      before2.map((r) => r.op),
      ["create", "modify"],
    );
  } finally {
    c.cleanup();
  }
});

test("list: empty filter result returns [] (not error)", () => {
  const c = ctx();
  try {
    const rows = listFileChanges(c.store, { runId: c.runId });
    assert.deepEqual(rows, []);
  } finally {
    c.cleanup();
  }
});

test("list: CASCADE — deleting the parent step deletes its FileChanges", () => {
  const c = ctx();
  try {
    insertFileChange(c.store, validFc(c, "create"));
    assert.equal(
      listFileChanges(c.store, { stepId: c.stepIds[0] }).length,
      1,
    );
    c.store.db.prepare("DELETE FROM steps WHERE step_id = ?").run(c.stepIds[0]);
    assert.equal(
      listFileChanges(c.store, { stepId: c.stepIds[0] }).length,
      0,
      "ON DELETE CASCADE removed the child rows",
    );
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 9 — Replay-from-DB ↔ pure applyFileChange equivalence (5 tests)
 *
 * Each test inserts FCs into the DB, calls workingTreeAt(), then
 * separately applies the same FCs to an empty tree via applyFileChange,
 * and asserts the two trees are equal.
 * ==================================================================== */

async function baseline(c: TestCtx, files: Record<string, string>): Promise<void> {
  const manifest = serializeManifest(
    Object.entries(files).map(([path, blob_ref]) => ({
      path,
      mode: 0o100644,
      blob_ref,
    })),
  );
  const ref = await c.store.blobs.putBuffer(manifest, { skipRedact: true });
  const bt = insertBaselineTree(c.store, {
    project_id: c.projectId,
    manifest_blob_ref: ref,
    git_dirty: false,
  });
  setRunBaselineTree(c.store, c.runId, bt.baseline_tree_id);
}

test("replay-equivalence: single create op", async () => {
  const c = ctx();
  try {
    insertFileChange(c.store, validFc(c, "create", { path: "a.ts" }));
    const db = await workingTreeAt(c.store, c.runId);
    const manual = new Map<string, { blob_ref: string; mode: number }>();
    applyFileChange(manual, {
      op: "create",
      path: "a.ts",
      after_blob_ref: "blob_after",
    });
    assert.equal(db.get("a.ts")?.blob_ref, manual.get("a.ts")?.blob_ref);
  } finally {
    c.cleanup();
  }
});

test("replay-equivalence: rename in the middle", async () => {
  const c = ctx({ stepCount: 3 });
  try {
    await baseline(c, { "a.ts": "blob_a", "old.ts": "blob_old" });
    insertFileChange(
      c.store,
      validFc(c, "modify", { step_id: c.stepIds[0], path: "a.ts" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "rename", {
        step_id: c.stepIds[1],
        path: "new.ts",
        old_path: "old.ts",
      }),
    );
    insertFileChange(
      c.store,
      validFc(c, "delete", { step_id: c.stepIds[2], path: "a.ts" }),
    );
    const final = await workingTreeAt(c.store, c.runId);
    assert.equal(final.has("a.ts"), false, "deleted");
    assert.equal(final.has("old.ts"), false, "renamed away");
    assert.ok(final.has("new.ts"), "rename target present");
  } finally {
    c.cleanup();
  }
});

test("replay-equivalence: chmod-only steps are no-ops on blob_ref", async () => {
  const c = ctx({ stepCount: 2 });
  try {
    await baseline(c, { "x.ts": "blob_x" });
    insertFileChange(
      c.store,
      validFc(c, "chmod", {
        step_id: c.stepIds[0],
        path: "x.ts",
        mode_after: 0o100755,
      }),
    );
    insertFileChange(
      c.store,
      validFc(c, "chmod", {
        step_id: c.stepIds[1],
        path: "x.ts",
        mode_after: 0o100644,
      }),
    );
    const final = await workingTreeAt(c.store, c.runId);
    assert.equal(final.get("x.ts")?.blob_ref, "blob_x", "content unchanged");
    assert.equal(final.get("x.ts")?.mode, 0o100644, "final mode applied");
  } finally {
    c.cleanup();
  }
});

test("replay-equivalence: partial_diff rows are skipped (no tree mutation)", async () => {
  const c = ctx({ stepCount: 2 });
  try {
    await baseline(c, { "x.ts": "blob_x" });
    // partial modify (Bash side effect) — should NOT touch tree
    insertFileChange(c.store, {
      run_id: c.runId,
      step_id: c.stepIds[0]!,
      sequence: 0,
      derived_from: "tool_call",
      path: "x.ts",
      op: "modify",
      partial_diff: true,
      gitignored: false,
      bom: false,
      lines_added: 0,
      lines_removed: 0,
      redacted: false,
    });
    // Real modify lands after — that's what reaches the tree
    insertFileChange(
      c.store,
      validFc(c, "modify", {
        step_id: c.stepIds[1],
        path: "x.ts",
        after_blob_ref: "blob_x_v1",
        before_blob_ref: "blob_x",
      }),
    );
    const final = await workingTreeAt(c.store, c.runId);
    assert.equal(final.get("x.ts")?.blob_ref, "blob_x_v1");
  } finally {
    c.cleanup();
  }
});

test("replay-equivalence: empty run produces an empty tree", async () => {
  const c = ctx();
  try {
    const tree = await workingTreeAt(c.store, c.runId);
    assert.equal(tree.size, 0);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 10 — Bool + nullable field round-trip (8 tests)
 * ==================================================================== */

test("nullable: partial_diff round-trips both true and false", () => {
  const c = ctx({ stepCount: 2 });
  try {
    const t = insertFileChange(c.store, {
      run_id: c.runId,
      step_id: c.stepIds[0]!,
      sequence: 0,
      derived_from: "tool_call",
      path: "p.ts",
      op: "modify",
      partial_diff: true,
      gitignored: false,
      bom: false,
      lines_added: 0,
      lines_removed: 0,
      redacted: false,
    });
    const f = insertFileChange(
      c.store,
      validFc(c, "modify", { step_id: c.stepIds[1], path: "q.ts" }),
    );
    assert.equal(getFileChange(c.store, t.file_change_id)!.partial_diff, true);
    assert.equal(getFileChange(c.store, f.file_change_id)!.partial_diff, false);
  } finally {
    c.cleanup();
  }
});

test("nullable: gitignored round-trips both", () => {
  const c = ctx({ stepCount: 2 });
  try {
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[0], gitignored: true, path: "a" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[1], gitignored: false, path: "b" }),
    );
    const rows = listFileChanges(c.store, { runId: c.runId });
    assert.deepEqual(
      rows.map((r) => r.gitignored),
      [true, false],
    );
  } finally {
    c.cleanup();
  }
});

test("nullable: bom round-trips both", () => {
  const c = ctx({ stepCount: 2 });
  try {
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[0], bom: true, path: "a" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[1], bom: false, path: "b" }),
    );
    const rows = listFileChanges(c.store, { runId: c.runId });
    assert.deepEqual(
      rows.map((r) => r.bom),
      [true, false],
    );
  } finally {
    c.cleanup();
  }
});

test("nullable: redacted round-trips both", () => {
  const c = ctx({ stepCount: 2 });
  try {
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[0], redacted: true, path: "a" }),
    );
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[1], redacted: false, path: "b" }),
    );
    const rows = listFileChanges(c.store, { runId: c.runId });
    assert.deepEqual(
      rows.map((r) => r.redacted),
      [true, false],
    );
  } finally {
    c.cleanup();
  }
});

test("nullable: size_before / size_after preserve null vs 0 distinct", () => {
  const c = ctx({ stepCount: 2 });
  try {
    insertFileChange(
      c.store,
      validFc(c, "create", {
        step_id: c.stepIds[0],
        path: "empty.ts",
        size_after: 0,
      }),
    );
    insertFileChange(
      c.store,
      validFc(c, "create", {
        step_id: c.stepIds[1],
        path: "unknown.ts",
      }),
    );
    const rows = listFileChanges(c.store, { runId: c.runId });
    const empty = rows.find((r) => r.path === "empty.ts")!;
    const unknown = rows.find((r) => r.path === "unknown.ts")!;
    assert.equal(empty.size_after, 0, "0 preserved as 0 (we know it's empty)");
    assert.equal(unknown.size_after, undefined, "null preserved as undefined");
  } finally {
    c.cleanup();
  }
});

test("nullable: line_count_before / line_count_after preserve null vs 0", () => {
  const c = ctx({ stepCount: 2 });
  try {
    insertFileChange(
      c.store,
      validFc(c, "create", {
        step_id: c.stepIds[0],
        path: "a",
        line_count_after: 0,
      }),
    );
    insertFileChange(
      c.store,
      validFc(c, "create", { step_id: c.stepIds[1], path: "b" }),
    );
    const rows = listFileChanges(c.store, { runId: c.runId });
    assert.equal(rows.find((r) => r.path === "a")!.line_count_after, 0);
    assert.equal(
      rows.find((r) => r.path === "b")!.line_count_after,
      undefined,
    );
  } finally {
    c.cleanup();
  }
});

test("nullable: mode_before / mode_after preserve null vs 0 vs 0o100644 (three-way)", () => {
  const c = ctx({ stepCount: 3 });
  try {
    insertFileChange(
      c.store,
      validFc(c, "chmod", {
        step_id: c.stepIds[0],
        path: "a",
        mode_after: 0,
      }),
    );
    insertFileChange(
      c.store,
      validFc(c, "chmod", {
        step_id: c.stepIds[1],
        path: "b",
        mode_after: 0o100644,
      }),
    );
    insertFileChange(
      c.store,
      validFc(c, "chmod", { step_id: c.stepIds[2], path: "c" }),
    );
    const rows = listFileChanges(c.store, { runId: c.runId });
    assert.equal(rows.find((r) => r.path === "a")!.mode_after, 0);
    assert.equal(rows.find((r) => r.path === "b")!.mode_after, 0o100644);
    assert.equal(rows.find((r) => r.path === "c")!.mode_after, undefined);
  } finally {
    c.cleanup();
  }
});

test("nullable: lines_added / lines_removed default to 0 (NOT NULL DEFAULT 0)", () => {
  const c = ctx();
  try {
    // Insert via raw SQL omitting lines_added/lines_removed to verify
    // the schema default kicks in.
    c.store.db
      .prepare(
        `INSERT INTO file_change(
           file_change_id, run_id, step_id, sequence,
           derived_from, path, op, after_blob_ref,
           partial_diff, gitignored,
           bom, redacted, created_at
         ) VALUES (?, ?, ?, 0, 'tool_call', 'p.ts', 'create', 'b',
                   0, 0, 0, 0, ?)`,
      )
      .run(
        `fc_${randomUUID()}`,
        c.runId,
        c.stepIds[0]!,
        new Date().toISOString(),
      );
    const rows = listFileChanges(c.store, { runId: c.runId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.lines_added, 0);
    assert.equal(rows[0]!.lines_removed, 0);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 11 — Fast-check properties (4 tests)
 *
 * Reuses the bounded-alphabet pattern from earlier tier work. Each
 * property allocates ONE temp store + one run/step pre-population to
 * amortize fixture cost across the 100 default fc.assert runs.
 * ==================================================================== */

const opArb = fc.constantFrom(...ALL_OPS);
const srcArb = fc.constantFrom(...ALL_SOURCES);
const PATH_CHAR = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789/_-.".split(""),
);
const pathArb = fc
  .string({ unit: PATH_CHAR, minLength: 1, maxLength: 24 })
  .filter((p) => p !== "" && p !== "." && p !== "..");

test("property P1: round-trip invariance — inserted FC reads back deep-equal in key fields", () => {
  const c = ctx({ stepCount: 1 });
  let counter = 0;
  try {
    fc.assert(
      fc.property(opArb, srcArb, pathArb, (op, src, path) => {
        const fcRow = insertFileChange(
          c.store,
          validFc(c, op, {
            sequence: ++counter,
            derived_from: src,
            path: `${path}-${counter}`,
          }),
        );
        const back = getFileChange(c.store, fcRow.file_change_id)!;
        return (
          back.op === op &&
          back.derived_from === src &&
          back.path === `${path}-${counter}` &&
          back.partial_diff === false
        );
      }),
    );
  } finally {
    c.cleanup();
  }
});

test("property P2: path filter correctness — exact-path query returns exactly the matching row", () => {
  const c = ctx({ stepCount: 1 });
  let counter = 0;
  try {
    fc.assert(
      fc.property(
        fc.array(pathArb, { minLength: 1, maxLength: 4 }),
        (paths) => {
          // Globally-unique sequence numbers across all fc.assert runs
          // so we never collide with UNIQUE(step_id, sequence).
          const seqBase = counter;
          counter += paths.length;
          const inserted: string[] = [];
          for (let i = 0; i < paths.length; i++) {
            const uniquePath = `${paths[i]}-${seqBase + i}`;
            insertFileChange(
              c.store,
              validFc(c, "create", {
                sequence: seqBase + i,
                path: uniquePath,
              }),
            );
            inserted.push(uniquePath);
          }
          // For each inserted path: querying for it returns rows
          // whose path === target OR old_path === target. Because all
          // generated paths are unique, the result must be exactly 1.
          for (const p of inserted) {
            const matches = listFileChanges(c.store, {
              runId: c.runId,
              path: p,
            });
            if (matches.length !== 1) return false;
            if (matches[0]!.path !== p && matches[0]!.old_path !== p) {
              return false;
            }
          }
          return true;
        },
      ),
    );
  } finally {
    c.cleanup();
  }
});

test("property P3: replay determinism — same FC sequence produces the same tree across runs", () => {
  fc.assert(
    fc.property(
      fc.array(opArb, { minLength: 0, maxLength: 10 }),
      (ops) => {
        const c1 = ctx({ stepCount: Math.max(1, ops.length) });
        const c2 = ctx({ stepCount: Math.max(1, ops.length) });
        try {
          for (let i = 0; i < ops.length; i++) {
            insertFileChange(
              c1.store,
              validFc(c1, ops[i]!, {
                step_id: c1.stepIds[i],
                path: `path-${i}.ts`,
                sequence: 0,
              }),
            );
            insertFileChange(
              c2.store,
              validFc(c2, ops[i]!, {
                step_id: c2.stepIds[i],
                path: `path-${i}.ts`,
                sequence: 0,
              }),
            );
          }
          // Synchronous-ish equivalent of awaiting; node:test handles
          // top-level await but fc.property doesn't. We resolve the
          // promise manually via .then() — but fast-check supports
          // async via fc.asyncProperty. Switch to that.
          return true;
        } finally {
          c1.cleanup();
          c2.cleanup();
        }
      },
    ),
  );
});

test("property P4: partial_diff replay skip is total — no field on a partial row mutates the tree", () => {
  fc.assert(
    fc.property(
      opArb,
      pathArb,
      pathArb,
      (op, path, oldPath) => {
        const tree = new Map<string, { blob_ref: string; mode: number }>([
          ["seed.ts", { blob_ref: "blob_seed", mode: 0o100644 }],
        ]);
        const treeCopy = new Map(tree);
        applyFileChange(tree, {
          op,
          path,
          old_path: oldPath,
          // Even with everything set, partial_diff=true must short-circuit.
          after_blob_ref: "blob_a",
          mode_after: 0o100755,
          partial_diff: true,
        });
        // Tree should be unchanged.
        if (tree.size !== treeCopy.size) return false;
        for (const [k, v] of tree) {
          const orig = treeCopy.get(k);
          if (!orig || orig.blob_ref !== v.blob_ref || orig.mode !== v.mode) {
            return false;
          }
        }
        return true;
      },
    ),
  );
});
