import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type { Run, Step, TokenUsage } from "@meterbility/shared";
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
  const home = mkdtempSync(join(tmpdir(), "meter-queries-exh-"));
  process.env.METERBILITY_HOME = home;
  const store = Store.open({ path: join(home, "meterbility.db") });
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

/* ====================================================================
 * Section 4 — Step lifecycle (7 tests)
 * ==================================================================== */

test("insertStep + getStep: full Step shape round-trips", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/step-rt", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    const step = mkStep(run.run_id, 0, {
      tokens: { input: 100, output: 50, cached_read: 0, cache_creation: 0 },
      cost_cents: 5,
      tags: ["benchmark", "redo"],
    });
    insertStep(c.store, step);
    const fetched = getStep(c.store, step.step_id);
    assert.ok(fetched, "step round-trips");
    assert.equal(fetched.step_id, step.step_id);
    assert.equal(fetched.tokens.input, 100);
    assert.equal(fetched.cost_cents, 5);
    assert.deepEqual(fetched.tags, ["benchmark", "redo"]);
  } finally {
    c.cleanup();
  }
});

test("getStep: unknown id returns undefined", () => {
  const c = freshCtx();
  try {
    assert.equal(getStep(c.store, "stp_unknown"), undefined);
  } finally {
    c.cleanup();
  }
});

test("listSteps: returns steps in sequence ASC order regardless of insertion order", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/seq", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    insertStep(c.store, mkStep(run.run_id, 2));
    insertStep(c.store, mkStep(run.run_id, 0));
    insertStep(c.store, mkStep(run.run_id, 1));
    const steps = listSteps(c.store, run.run_id);
    assert.deepEqual(
      steps.map((s) => s.sequence),
      [0, 1, 2],
      "sorted by sequence ASC",
    );
  } finally {
    c.cleanup();
  }
});

test("listSteps: unknown run returns empty array (not error)", () => {
  const c = freshCtx();
  try {
    assert.deepEqual(listSteps(c.store, "run_unknown"), []);
  } finally {
    c.cleanup();
  }
});

test("getStepBySequence: finds step at exact (run, seq)", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/by-seq", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    const s0 = mkStep(run.run_id, 0);
    const s1 = mkStep(run.run_id, 1);
    insertStep(c.store, s0);
    insertStep(c.store, s1);
    const found = getStepBySequence(c.store, run.run_id, 1);
    assert.ok(found, "step at seq 1 found");
    assert.equal(found!.step_id, s1.step_id);
  } finally {
    c.cleanup();
  }
});

test("getStepBySequence: unknown sequence returns undefined", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/by-seq-miss", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    insertStep(c.store, mkStep(run.run_id, 0));
    assert.equal(getStepBySequence(c.store, run.run_id, 99), undefined);
  } finally {
    c.cleanup();
  }
});

test("recordContextSnapshot + resolveSnapshotBlobRef: round-trip + raw-hash pass-through", () => {
  const c = freshCtx();
  try {
    // Recorded mapping
    recordContextSnapshot(c.store, "snap_logical_1", "blob_ref_for_snap1", 4);
    assert.equal(
      resolveSnapshotBlobRef(c.store, "snap_logical_1"),
      "blob_ref_for_snap1",
    );
    // Unknown snapshot — passes through (contract documented in fn)
    const unknown = "0".repeat(64);
    assert.equal(
      resolveSnapshotBlobRef(c.store, unknown),
      unknown,
      "unknown snapshot passes through as raw blob hash",
    );
    // INSERT OR IGNORE: re-recording with different blob_ref is a no-op
    recordContextSnapshot(c.store, "snap_logical_1", "blob_ref_different", 99);
    assert.equal(
      resolveSnapshotBlobRef(c.store, "snap_logical_1"),
      "blob_ref_for_snap1",
      "first write wins under INSERT OR IGNORE",
    );
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 5 — Fork lifecycle (4 tests)
 * ==================================================================== */

test("insertFork + listForks: single fork round-trips", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/fork", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const origin = mkRun(proj.project_id, agent.agent_id);
    const forkRun = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, origin);
    insertRun(c.store, forkRun);
    const originStep = mkStep(origin.run_id, 0);
    insertStep(c.store, originStep);
    const forkId = insertFork(c.store, {
      originRunId: origin.run_id,
      originStepId: originStep.step_id,
      forkRunId: forkRun.run_id,
      edit: { type: "inject_message", payload: { text: "stop" } },
    });
    assert.ok(forkId.startsWith("frk_"));
    const forks = listForks(c.store, origin.run_id);
    assert.equal(forks.length, 1);
    assert.equal(forks[0]!.fork_id, forkId);
    assert.equal(forks[0]!.edit_type, "inject_message");
  } finally {
    c.cleanup();
  }
});

test("listForks: returns empty array for unknown origin run", () => {
  const c = freshCtx();
  try {
    assert.deepEqual(listForks(c.store, "run_no_forks"), []);
  } finally {
    c.cleanup();
  }
});

test("listForks: multiple forks of same origin returned in created_at order", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/multifork", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const origin = mkRun(proj.project_id, agent.agent_id);
    const fork1 = mkRun(proj.project_id, agent.agent_id);
    const fork2 = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, origin);
    insertRun(c.store, fork1);
    insertRun(c.store, fork2);
    const step = mkStep(origin.run_id, 0);
    insertStep(c.store, step);
    insertFork(c.store, {
      originRunId: origin.run_id,
      originStepId: step.step_id,
      forkRunId: fork1.run_id,
      edit: { type: "add_context", payload: "first" },
    });
    insertFork(c.store, {
      originRunId: origin.run_id,
      originStepId: step.step_id,
      forkRunId: fork2.run_id,
      edit: { type: "add_context", payload: "second" },
    });
    const forks = listForks(c.store, origin.run_id);
    assert.equal(forks.length, 2);
  } finally {
    c.cleanup();
  }
});

test("insertFork: payload survives JSON round-trip (object → string → object via listForks doesn't decode payload)", () => {
  // listForks omits the payload by design (small projection). Just
  // verify the fork was persisted and the projection columns are right.
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/payload", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const origin = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, origin);
    const step = mkStep(origin.run_id, 0);
    insertStep(c.store, step);
    const forkRun = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, forkRun);
    const forkId = insertFork(c.store, {
      originRunId: origin.run_id,
      originStepId: step.step_id,
      forkRunId: forkRun.run_id,
      edit: {
        type: "modify_tool_description",
        payload: { tool: "Edit", new_description: "spicier" },
      },
    });
    const forks = listForks(c.store, origin.run_id);
    assert.equal(forks[0]!.fork_id, forkId);
    assert.equal(forks[0]!.edit_type, "modify_tool_description");
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 6 — Annotation lifecycle (4 tests)
 * ==================================================================== */

test("insertAnnotation + listAnnotations: run annotation round-trips", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/ann-run", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    const ann = insertAnnotation(c.store, {
      targetKind: "run",
      targetId: run.run_id,
      author: "tester",
      verdict: "good_decision",
      note: "nicely done",
    });
    assert.ok(ann.annotation_id.startsWith("ann_"));
    const list = listAnnotations(c.store, "run", run.run_id);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.verdict, "good_decision");
    assert.equal(list[0]!.note, "nicely done");
  } finally {
    c.cleanup();
  }
});

test("insertAnnotation + listAnnotations: step annotation round-trips", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/ann-step", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    const step = mkStep(run.run_id, 0);
    insertStep(c.store, step);
    insertAnnotation(c.store, {
      targetKind: "step",
      targetId: step.step_id,
      author: "tester",
      verdict: "incorrect",
    });
    const list = listAnnotations(c.store, "step", step.step_id);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.target_kind, "step");
    assert.equal(list[0]!.verdict, "incorrect");
    // run scope must NOT pick up the step annotation
    assert.equal(listAnnotations(c.store, "run", step.step_id).length, 0);
  } finally {
    c.cleanup();
  }
});

test("listAnnotations: multiple annotations on same target returned in created_at order", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/multi-ann", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    insertAnnotation(c.store, {
      targetKind: "run",
      targetId: run.run_id,
      author: "a",
      note: "first",
    });
    insertAnnotation(c.store, {
      targetKind: "run",
      targetId: run.run_id,
      author: "b",
      note: "second",
    });
    const list = listAnnotations(c.store, "run", run.run_id);
    assert.equal(list.length, 2);
  } finally {
    c.cleanup();
  }
});

test("listAnnotations: unknown target returns empty array", () => {
  const c = freshCtx();
  try {
    assert.deepEqual(listAnnotations(c.store, "run", "run_unknown"), []);
    assert.deepEqual(listAnnotations(c.store, "step", "stp_unknown"), []);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 7 — Ingest offset (3 tests)
 * ==================================================================== */

test("getIngestOffset: unknown (runtime, path) returns 0 (baseline contract)", () => {
  const c = freshCtx();
  try {
    assert.equal(
      getIngestOffset(c.store, "claude-code", "/never/seen.jsonl"),
      0,
    );
  } finally {
    c.cleanup();
  }
});

test("setIngestOffset + getIngestOffset: round-trips, second call overwrites", () => {
  const c = freshCtx();
  try {
    setIngestOffset(c.store, "claude-code", "/tmp/session.jsonl", 1234);
    assert.equal(
      getIngestOffset(c.store, "claude-code", "/tmp/session.jsonl"),
      1234,
    );
    // Second call must overwrite, not duplicate.
    setIngestOffset(c.store, "claude-code", "/tmp/session.jsonl", 5678);
    assert.equal(
      getIngestOffset(c.store, "claude-code", "/tmp/session.jsonl"),
      5678,
      "second call overwrites the offset",
    );
  } finally {
    c.cleanup();
  }
});

test("setIngestOffset: distinct (runtime, path) keys do not collide", () => {
  const c = freshCtx();
  try {
    setIngestOffset(c.store, "claude-code", "/tmp/a.jsonl", 100);
    setIngestOffset(c.store, "claude-code", "/tmp/b.jsonl", 200);
    setIngestOffset(c.store, "codex-cli", "/tmp/a.jsonl", 300);
    assert.equal(getIngestOffset(c.store, "claude-code", "/tmp/a.jsonl"), 100);
    assert.equal(getIngestOffset(c.store, "claude-code", "/tmp/b.jsonl"), 200);
    assert.equal(getIngestOffset(c.store, "codex-cli", "/tmp/a.jsonl"), 300);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 8 — Session lookup (2 tests)
 * ==================================================================== */

test("getRunBySessionId: finds run with matching source_session_id", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/sess", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id, {
      source_session_id: "claude-session-uuid-1234",
    });
    insertRun(c.store, run);
    const found = getRunBySessionId(c.store, "claude-session-uuid-1234");
    assert.ok(found);
    assert.equal(found.run_id, run.run_id);
  } finally {
    c.cleanup();
  }
});

test("getRunBySessionId: unknown session returns undefined", () => {
  const c = freshCtx();
  try {
    assert.equal(
      getRunBySessionId(c.store, "session-that-was-never-recorded"),
      undefined,
    );
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 9 — Token math: aggregateTokens + updateRunTotals (5 tests)
 * Pure-logic and SQL-aggregation paths both pinned.
 * ==================================================================== */

test("aggregateTokens: empty array returns all-zero usage", () => {
  const result = aggregateTokens([]);
  assert.deepEqual(result, {
    input: 0,
    output: 0,
    cached_read: 0,
    cache_creation: 0,
    cache_creation_1h: 0,
  });
});

test("aggregateTokens: single step returns that step's usage verbatim", () => {
  const proj = "p";
  const agent = "a";
  const run = "r";
  const step = mkStep(run, 0, {
    tokens: {
      input: 100,
      output: 50,
      cached_read: 10,
      cache_creation: 5,
      cache_creation_1h: 2,
    },
  });
  void proj;
  void agent;
  const sum = aggregateTokens([step]);
  assert.equal(sum.input, 100);
  assert.equal(sum.output, 50);
  assert.equal(sum.cached_read, 10);
  assert.equal(sum.cache_creation, 5);
  assert.equal(sum.cache_creation_1h, 2);
});

test("aggregateTokens: N steps sum each field independently", () => {
  const steps: Step[] = [];
  for (let i = 0; i < 4; i++) {
    steps.push(
      mkStep("r", i, {
        tokens: {
          input: 10,
          output: 5,
          cached_read: 2,
          cache_creation: 1,
        },
      }),
    );
  }
  const sum = aggregateTokens(steps);
  assert.equal(sum.input, 40);
  assert.equal(sum.output, 20);
  assert.equal(sum.cached_read, 8);
  assert.equal(sum.cache_creation, 4);
});

test("aggregateTokens: missing cache_creation_1h coerces to 0 (the spread fallback)", () => {
  const step = mkStep("r", 0, {
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
  });
  // cache_creation_1h intentionally undefined
  const sum = aggregateTokens([step]);
  assert.equal(sum.cache_creation_1h, 0);
});

test("updateRunTotals: sums step tokens + costs into the run row", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/totals", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    for (let i = 0; i < 3; i++) {
      insertStep(
        c.store,
        mkStep(run.run_id, i, {
          tokens: {
            input: 100,
            output: 50,
            cached_read: 10,
            cache_creation: 5,
          },
          cost_cents: 7,
        }),
      );
    }
    updateRunTotals(c.store, run.run_id);
    const updated = getRun(c.store, run.run_id);
    assert.equal(updated!.step_count, 3);
    assert.equal(updated!.tokens_total_input, 300);
    assert.equal(updated!.tokens_total_output, 150);
    // tokens_total_cached = cached_read + cache_creation + cache_creation_1h
    assert.equal(updated!.tokens_total_cached, 45);
    assert.equal(updated!.cost_cents, 21);
  } finally {
    c.cleanup();
  }
});

test("updateRunTotals: run with zero steps gets zeroed totals (COALESCE fallback)", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/zero", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id, {
      tokens_total_input: 999, // garbage initial value
      cost_cents: 99,
    });
    insertRun(c.store, run);
    updateRunTotals(c.store, run.run_id);
    const updated = getRun(c.store, run.run_id);
    assert.equal(updated!.step_count, 0);
    assert.equal(updated!.tokens_total_input, 0, "no steps → 0, not NULL");
    assert.equal(updated!.cost_cents, 0);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 10 — Baseline tree (5 tests)
 * ==================================================================== */

test("insertBaselineTree + getBaselineTree: round-trips all fields", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/bt", "p");
    const bt = insertBaselineTree(c.store, {
      project_id: proj.project_id,
      manifest_blob_ref: "sha_xyz",
      git_head: "abc1234",
      git_dirty: true,
    });
    assert.ok(bt.baseline_tree_id.startsWith("bt_"));
    const fetched = getBaselineTree(c.store, bt.baseline_tree_id);
    assert.equal(fetched!.manifest_blob_ref, "sha_xyz");
    assert.equal(fetched!.git_head, "abc1234");
    assert.equal(fetched!.git_dirty, true);
  } finally {
    c.cleanup();
  }
});

test("getBaselineTree: unknown id returns undefined", () => {
  const c = freshCtx();
  try {
    assert.equal(getBaselineTree(c.store, "bt_unknown"), undefined);
  } finally {
    c.cleanup();
  }
});

test("findBaselineByManifest: dedup lookup hits", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/bt-dedup", "p");
    const inserted = insertBaselineTree(c.store, {
      project_id: proj.project_id,
      manifest_blob_ref: "sha_dedup",
      git_dirty: false,
    });
    const found = findBaselineByManifest(c.store, proj.project_id, "sha_dedup");
    assert.equal(found!.baseline_tree_id, inserted.baseline_tree_id);
    // Different project_id with same manifest → no match
    const otherProj = upsertProjectByCwd(c.store, "/tmp/other", "o");
    const miss = findBaselineByManifest(
      c.store,
      otherProj.project_id,
      "sha_dedup",
    );
    assert.equal(miss, undefined, "scoped to project");
  } finally {
    c.cleanup();
  }
});

test("findBaselineByManifest: unknown manifest returns undefined", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/bt-miss", "p");
    assert.equal(
      findBaselineByManifest(c.store, proj.project_id, "sha_does_not_exist"),
      undefined,
    );
  } finally {
    c.cleanup();
  }
});

test("setRunBaselineTree: links + overwrites + works under repeated calls (idempotent)", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/link", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    const bt1 = insertBaselineTree(c.store, {
      project_id: proj.project_id,
      manifest_blob_ref: "sha_1",
      git_dirty: false,
    });
    const bt2 = insertBaselineTree(c.store, {
      project_id: proj.project_id,
      manifest_blob_ref: "sha_2",
      git_dirty: false,
    });
    setRunBaselineTree(c.store, run.run_id, bt1.baseline_tree_id);
    let after = getRun(c.store, run.run_id);
    assert.equal(after!.baseline_tree_id, bt1.baseline_tree_id);
    // Overwrite path
    setRunBaselineTree(c.store, run.run_id, bt2.baseline_tree_id);
    after = getRun(c.store, run.run_id);
    assert.equal(after!.baseline_tree_id, bt2.baseline_tree_id);
    // Repeating the same link is a no-op
    setRunBaselineTree(c.store, run.run_id, bt2.baseline_tree_id);
    after = getRun(c.store, run.run_id);
    assert.equal(after!.baseline_tree_id, bt2.baseline_tree_id);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 11 — Run probe state column (3 tests)
 * The persisted column (`paused | resumed | null`), distinct from the
 * runtime FSM tested in Tier 3.
 * ==================================================================== */

test("setRunProbeState: round-trips 'paused' value", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/probe-paused", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    setRunProbeState(c.store, run.run_id, "paused");
    const after = getRun(c.store, run.run_id);
    assert.equal(after!.probe_state, "paused");
  } finally {
    c.cleanup();
  }
});

test("setRunProbeState: round-trips 'resumed' value", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/probe-resumed", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    setRunProbeState(c.store, run.run_id, "resumed");
    const after = getRun(c.store, run.run_id);
    assert.equal(after!.probe_state, "resumed");
  } finally {
    c.cleanup();
  }
});

test("setRunProbeState: null clears a previously-set value", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/probe-clear", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const run = mkRun(proj.project_id, agent.agent_id);
    insertRun(c.store, run);
    setRunProbeState(c.store, run.run_id, "paused");
    setRunProbeState(c.store, run.run_id, null);
    const after = getRun(c.store, run.run_id);
    assert.equal(after!.probe_state, undefined, "null clears the column");
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 12 — Fast-check properties (4 tests)
 * ==================================================================== */

const TOKEN_ARB = fc.record({
  input: fc.integer({ min: 0, max: 10_000 }),
  output: fc.integer({ min: 0, max: 10_000 }),
  cached_read: fc.integer({ min: 0, max: 10_000 }),
  cache_creation: fc.integer({ min: 0, max: 10_000 }),
});

test("property P1: aggregateTokens is commutative under reordering", () => {
  fc.assert(
    fc.property(
      fc.array(TOKEN_ARB, { minLength: 0, maxLength: 20 }),
      (tokens) => {
        const steps = tokens.map((t, i) => mkStep("r", i, { tokens: t }));
        const forward = aggregateTokens(steps);
        const reversed = aggregateTokens([...steps].reverse());
        return (
          forward.input === reversed.input &&
          forward.output === reversed.output &&
          forward.cached_read === reversed.cached_read &&
          forward.cache_creation === reversed.cache_creation
        );
      },
    ),
    { numRuns: 50 },
  );
});

test("property P2: aggregateTokens is additive across array splits", () => {
  // For any sequence of token records, sum(whole) === sum(prefix) +
  // sum(suffix) for every split point. This is the property that makes
  // the function safe for incremental aggregation.
  fc.assert(
    fc.property(
      fc.array(TOKEN_ARB, { minLength: 2, maxLength: 20 }),
      fc.integer({ min: 0, max: 19 }),
      (tokens, splitAt) => {
        const steps = tokens.map((t, i) => mkStep("r", i, { tokens: t }));
        const k = Math.min(splitAt, steps.length);
        const whole = aggregateTokens(steps);
        const prefix = aggregateTokens(steps.slice(0, k));
        const suffix = aggregateTokens(steps.slice(k));
        return (
          whole.input === prefix.input + suffix.input &&
          whole.output === prefix.output + suffix.output &&
          whole.cached_read === prefix.cached_read + suffix.cached_read &&
          whole.cache_creation === prefix.cache_creation + suffix.cache_creation
        );
      },
    ),
    { numRuns: 50 },
  );
});

test("property P3: listRuns limit is exact — result.length <= min(limit, total)", () => {
  const c = freshCtx();
  let counter = 0;
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/limit-prop", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }), // batch size
        fc.integer({ min: 0, max: 10 }), // limit
        (batchSize, limit) => {
          // Insert N more runs per iteration (cumulative). Total runs
          // visible at this point is `counter + batchSize`.
          for (let i = 0; i < batchSize; i++) {
            insertRun(c.store, mkRun(proj.project_id, agent.agent_id));
            counter++;
          }
          const rows = listRuns(c.store, { limit });
          return rows.length <= Math.min(limit, counter);
        },
      ),
      { numRuns: 30 },
    );
  } finally {
    c.cleanup();
  }
});

test("property P4: getRun is idempotent — calling twice with the same id returns identical rows", () => {
  const c = freshCtx();
  try {
    const proj = upsertProjectByCwd(c.store, "/tmp/get-prop", "p");
    const agent = upsertAgent(c.store, proj.project_id, "a");
    const runs: Run[] = [];
    for (let i = 0; i < 8; i++) {
      const r = mkRun(proj.project_id, agent.agent_id);
      insertRun(c.store, r);
      runs.push(r);
    }
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 }), (idx) => {
        const a = getRun(c.store, runs[idx]!.run_id);
        const b = getRun(c.store, runs[idx]!.run_id);
        if (!a || !b) return false;
        return a.run_id === b.run_id && a.title === b.title;
      }),
      { numRuns: 30 },
    );
  } finally {
    c.cleanup();
  }
});
