import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type { Run, Step, TokenUsage } from "@spool/shared";
import { Store } from "./store.ts";
import {
  aggregateTokens,
  findBaselineByManifest,
  getBaselineTree,
  getIngestOffset,
  getRun,
  getRunBySessionId,
  getStep,
  getStepBySequence,
  insertAnnotation,
  insertBaselineTree,
  insertFork,
  insertRun,
  insertStep,
  listAnnotations,
  listForks,
  listRuns,
  listSteps,
  recordContextSnapshot,
  resolveSnapshotBlobRef,
  setIngestOffset,
  setRunBaselineTree,
  setRunProbeState,
  setRunStatus,
  updateRunTotals,
  upsertAgent,
  upsertProjectByCwd,
} from "./queries.ts";

/**
 * Tier 8 — exhaustive direct coverage of `queries.ts`, the data-access
 * layer the entire collector + adapters + server depend on.
 *
 * Existing test files exercise these functions indirectly through their
 * own happy-path workflows: `file_changes.test.ts` scaffolds runs and
 * steps just to test FileChange ops, `baseline.test.ts` does the same
 * for baseline trees, etc. None of them target query correctness for
 * filter combinators, NULL handling, prefix resolution, or idempotency
 * head-on. This file does.
 *
 * Twelve sections mirror the 11 functional clusters in queries.ts,
 * plus a Section 12 of fast-check properties for the pure-logic
 * `aggregateTokens` reducer and the filter-subset invariants on
 * `listRuns`.
 */

// ─── Test fixtures ──────────────────────────────────────────────────

interface Ctx {
  home: string;
  store: Store;
  cleanup(): void;
}

function freshCtx(): Ctx {
  const home = mkdtempSync(join(tmpdir(), "spool-queries-exh-"));
  process.env.SPOOL_HOME = home;
  const store = Store.open({ path: join(home, "spool.db") });
  return {
    home,
    store,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/** Build a minimal Run row with the given overrides. */
function mkRun(
  projectId: string,
  agentId: string,
  overrides: Partial<Run> = {},
): Run {
  return {
    run_id: `run_${randomUUID()}`,
    agent_id: agentId,
    project_id: projectId,
    source_runtime: "claude-code",
    title: "test run",
    status: "in_progress",
    started_at: new Date().toISOString(),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
    ...overrides,
  };
}

/** Build a minimal Step row. */
function mkStep(
  runId: string,
  sequence: number,
  overrides: Partial<Step> = {},
): Step {
  return {
    step_id: `stp_${randomUUID()}`,
    run_id: runId,
    sequence,
    timestamp: new Date(Date.now() + sequence * 1000).toISOString(),
    model: "claude-opus-4-7",
    context_snapshot_id: "snap_x",
    decision_ref: "blob_dec",
    action: { kind: "tool_call", tool_name: "Edit" },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: [],
    status: "ok",
    ...overrides,
  };
}

/* ====================================================================
 * Section 1 — Project + Agent (5 tests)
 * Idempotency contract: upsert is the public surface; calling twice
 * must return the same row, not create a duplicate.
 * ==================================================================== */

test("upsertProjectByCwd: creates on first call, returns same row on second call (idempotent)", () => {
  const c = freshCtx();
  try {
    const first = upsertProjectByCwd(c.store, "/tmp/proj-a", "proj-a");
    const second = upsertProjectByCwd(c.store, "/tmp/proj-a", "proj-a");
    assert.equal(first.project_id, second.project_id, "same project_id");
    assert.equal(first.cwd, "/tmp/proj-a");
    assert.equal(first.name, "proj-a");
  } finally {
    c.cleanup();
  }
});

test("upsertProjectByCwd: distinct cwds create distinct projects", () => {
  const c = freshCtx();
  try {
    const a = upsertProjectByCwd(c.store, "/tmp/proj-a", "proj-a");
    const b = upsertProjectByCwd(c.store, "/tmp/proj-b", "proj-b");
    assert.notEqual(a.project_id, b.project_id);
  } finally {
    c.cleanup();
  }
});

test("upsertProjectByCwd: name change on existing cwd does NOT mint a new row", () => {
  // Pins the contract: cwd is the identity, name is metadata.
  const c = freshCtx();
  try {
    const first = upsertProjectByCwd(c.store, "/tmp/proj-rename", "original");
    const second = upsertProjectByCwd(c.store, "/tmp/proj-rename", "renamed");
    assert.equal(
      first.project_id,
      second.project_id,
      "same row across name change",
    );
  } finally {
    c.cleanup();
  }
});

test("upsertAgent: creates on first call, idempotent on (project, name)", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/agent-test", "p");
    const first = upsertAgent(c.store, proj.project_id, "claude-code");
    const second = upsertAgent(c.store, proj.project_id, "claude-code");
    assert.equal(first.agent_id, second.agent_id);
    assert.equal(first.name, "claude-code");
  } finally {
    c.cleanup();
  }
});

test("upsertAgent: same agent name in distinct projects creates distinct agents", () => {
  const c = freshCtx();
  try {
    const projA = upsertProjectByCwd(c.store, "/tmp/agent-a", "a");
    const projB = upsertProjectByCwd(c.store, "/tmp/agent-b", "b");
    const agentA = upsertAgent(c.store, projA.project_id, "claude-code");
    const agentB = upsertAgent(c.store, projB.project_id, "claude-code");
    assert.notEqual(agentA.agent_id, agentB.agent_id);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 2 — Run lifecycle (5 tests)
 * insertRun + getRun + setRunStatus.
 * ==================================================================== */

test("insertRun + getRun: full Run shape round-trips", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/rt", "rt");
    const agent = upsertAgent(c.store, proj.project_id, "claude-code");
    const run = mkRun(proj.project_id, agent.agent_id, {
      title: "round trip",
      tags: ["a", "b"],
      cwd: "/tmp/rt",
    });
    insertRun(c.store, run);
    const fetched = getRun(c.store, run.run_id);
    assert.ok(fetched, "exact id resolves");
    assert.equal(fetched.run_id, run.run_id);
    assert.equal(fetched.title, "round trip");
    assert.deepEqual(fetched.tags, ["a", "b"]);
    assert.equal(fetched.cwd, "/tmp/rt");
  } finally {
    c.cleanup();
  }
});

test("getRun: prefix lookup resolves a unique short id", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/prefix", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    // First 12 chars (the CLI display form)
    const short = run.run_id.slice(0, 12);
    const fetched = getRun(c.store, short);
    assert.ok(fetched, "prefix lookup succeeded");
    assert.equal(fetched!.run_id, run.run_id);
  } finally {
    c.cleanup();
  }
});

test("getRun: prefix shorter than 6 chars returns undefined (anti-collision floor)", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/short", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    // 5 chars — below the floor.
    const tooShort = run.run_id.slice(0, 5);
    const fetched = getRun(c.store, tooShort);
    assert.equal(fetched, undefined, "below-floor prefix rejected");
  } finally {
    c.cleanup();
  }
});

test("getRun: completely unknown id returns undefined", () => {
  const c = freshCtx();
  try {
    const fetched = getRun(c.store, "run_does_not_exist_anywhere");
    assert.equal(fetched, undefined);
  } finally {
    c.cleanup();
  }
});

test("setRunStatus: transitions status; caller-provided endedAt persists", () => {
  // Contract: setRunStatus does NOT auto-stamp ended_at. The optional
  // 4th argument carries the timestamp. Higher-level callers (the close
  // route, sealStaleRuns) stamp it themselves. Document here so a future
  // refactor that adds auto-stamping doesn't silently change semantics.
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/seal", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    // No endedAt: status updates, ended_at stays null
    setRunStatus(c.store, run.run_id, "ok");
    let after = getRun(c.store, run.run_id);
    assert.equal(after!.status, "ok");
    assert.equal(
      after!.ended_at,
      undefined,
      "no auto-stamp when endedAt omitted",
    );
    // With endedAt: column is set
    const stamp = "2026-05-19T12:34:56Z";
    setRunStatus(c.store, run.run_id, "error", stamp);
    after = getRun(c.store, run.run_id);
    assert.equal(after!.status, "error");
    assert.equal(after!.ended_at, stamp);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 3 — listRuns filter combinators (7 tests)
 * The highest-value section: every read path in the app goes through
 * one of these filter shapes. Pin each filter independently AND a few
 * combined intersections.
 * ==================================================================== */

test("listRuns: no filter, no runs → empty array", () => {
  const c = freshCtx();
  try {
    assert.deepEqual(listRuns(c.store), []);
  } finally {
    c.cleanup();
  }
});

test("listRuns: ordered by started_at DESC (newest first)", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/order", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const oldRun = mkRun(proj.project_id, agent.agent_id, {
      started_at: "2024-01-01T00:00:00Z",
      title: "old",
    });
    const newRun = mkRun(proj.project_id, agent.agent_id, {
      started_at: "2026-01-01T00:00:00Z",
      title: "new",
    });
    insertRun(c.store, oldRun);
    insertRun(c.store, newRun);
    const list = listRuns(c.store);
    assert.equal(list[0]!.title, "new", "newest first");
    assert.equal(list[1]!.title, "old", "oldest last");
  } finally {
    c.cleanup();
  }
});

test("listRuns: limit caps the returned list size", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/limit", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    for (let i = 0; i < 5; i++) {
      insertRun(c.store, mkRun(proj.project_id, agent.agent_id));
    }
    assert.equal(listRuns(c.store, { limit: 2 }).length, 2);
    assert.equal(listRuns(c.store, { limit: 100 }).length, 5);
  } finally {
    c.cleanup();
  }
});

test("listRuns: status filter narrows to matching runs only", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/status", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    insertRun(c.store, mkRun(proj.project_id, agent.agent_id, { status: "ok" }));
    insertRun(
      c.store,
      mkRun(proj.project_id, agent.agent_id, { status: "error" }),
    );
    insertRun(
      c.store,
      mkRun(proj.project_id, agent.agent_id, { status: "in_progress" }),
    );
    assert.equal(listRuns(c.store, { status: "ok" }).length, 1);
    assert.equal(listRuns(c.store, { status: "error" }).length, 1);
    assert.equal(listRuns(c.store, { status: "in_progress" }).length, 1);
  } finally {
    c.cleanup();
  }
});

test("listRuns: containsTool filter matches via the steps subquery", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/tool", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const editRun = mkRun(proj.project_id, agent.agent_id);
    const bashRun = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, editRun);
    insertRun(c.store, bashRun);
    insertStep(
      c.store,
      mkStep(editRun.run_id, 0, {
        action: { kind: "tool_call", tool_name: "Edit" },
      }),
    );
    insertStep(
      c.store,
      mkStep(bashRun.run_id, 0, {
        action: { kind: "tool_call", tool_name: "Bash" },
      }),
    );
    const editOnly = listRuns(c.store, { containsTool: "Edit" });
    assert.equal(editOnly.length, 1);
    assert.equal(editOnly[0]!.run_id, editRun.run_id);
    const bashOnly = listRuns(c.store, { containsTool: "Bash" });
    assert.equal(bashOnly[0]!.run_id, bashRun.run_id);
  } finally {
    c.cleanup();
  }
});

test("listRuns: projectId filter scopes results to one project", () => {
  const c = freshCtx();
  try {
    const projA = upsertProjectByCwd(c.store, "/tmp/scope-a", "a");
    const projB = upsertProjectByCwd(c.store, "/tmp/scope-b", "b");
    const agent = upsertAgent(c.store, projA.project_id, "agent");
    const agentB = upsertAgent(c.store, projB.project_id, "agent");
    insertRun(c.store, mkRun(projA.project_id, agent.agent_id));
    insertRun(c.store, mkRun(projA.project_id, agent.agent_id));
    insertRun(c.store, mkRun(projB.project_id, agentB.agent_id));
    const aOnly = listRuns(c.store, { projectId: projA.project_id });
    assert.equal(aOnly.length, 2);
    const bOnly = listRuns(c.store, { projectId: projB.project_id });
    assert.equal(bOnly.length, 1);
  } finally {
    c.cleanup();
  }
});

test("listRuns: combined status + containsTool filter intersects (AND semantics)", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/combo", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    // run-1: ok + Edit
    const r1 = mkRun(proj.project_id, agent.agent_id, { status: "ok" });
    insertRun(c.store, r1);
    insertStep(
      c.store,
      mkStep(r1.run_id, 0, { action: { kind: "tool_call", tool_name: "Edit" } }),
    );
    // run-2: ok + Bash
    const r2 = mkRun(proj.project_id, agent.agent_id, { status: "ok" });
    insertRun(c.store, r2);
    insertStep(
      c.store,
      mkStep(r2.run_id, 0, { action: { kind: "tool_call", tool_name: "Bash" } }),
    );
    // run-3: error + Edit
    const r3 = mkRun(proj.project_id, agent.agent_id, { status: "error" });
    insertRun(c.store, r3);
    insertStep(
      c.store,
      mkStep(r3.run_id, 0, { action: { kind: "tool_call", tool_name: "Edit" } }),
    );
    const combo = listRuns(c.store, {
      status: "ok",
      containsTool: "Edit",
    });
    assert.equal(combo.length, 1, "AND intersects status + tool");
    assert.equal(combo[0]!.run_id, r1.run_id);
  } finally {
    c.cleanup();
  }
});
