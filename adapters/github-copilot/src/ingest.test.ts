import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  getChildRuns,
  getRun,
  listFileChanges,
  listRuns,
  listSteps,
  setIngestOffset,
} from "@meterbility/collector";
import { ingestCopilotSession } from "./ingest.ts";
import { parseEventsBuffer } from "./parser.ts";
import { probeEvents } from "./shape_probe.ts";

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "meter-copilot-"));
  process.env.METERBILITY_HOME = dir;
  return Store.open();
}

/** Write a session dir (events.jsonl + optional workspace.yaml); returns the events path. */
function writeSession(
  events: object[],
  opts: { workspaceYaml?: string; sessionDirName?: string } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "meter-copilot-sess-"));
  const dir = join(root, opts.sessionDirName ?? "abc-123-def");
  mkdirSync(dir, { recursive: true });
  if (opts.workspaceYaml !== undefined) {
    writeFileSync(join(dir, "workspace.yaml"), opts.workspaceYaml);
  }
  const path = join(dir, "events.jsonl");
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

let evCounter = 0;
function ev(
  type: string,
  data: Record<string, unknown> = {},
  extra: { id?: string; parentId?: string | null; timestamp?: string } = {},
): Record<string, unknown> {
  evCounter += 1;
  return {
    type,
    id: extra.id ?? `ev-${evCounter}`,
    // Monotonic regardless of counter value (no mod-60 wrap) so
    // started_at / child ordering / latency math never see time going
    // backwards within a fixture.
    timestamp:
      extra.timestamp ??
      new Date(Date.UTC(2026, 7, 20, 10, 0, evCounter)).toISOString(),
    parentId: extra.parentId ?? null,
    data,
  };
}

/** Recent timestamps (relative to now) for live-tail fixtures — status
 *  inference treats sessions silent past the staleness window as
 *  abandoned, so "still running" fixtures must look recent. */
function recentTs(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

/** A squad-style two-agent session with correlated sub-agent events. */
function squadSession(): object[] {
  return [
    ev("session.start", { sessionId: "sess-squad", model: "claude-sonnet-4.5" }, { id: "e1" }),
    ev("user.message", { content: "Set up the team and fix the auth bug" }, { id: "e2", parentId: "e1" }),
    ev("assistant.turn_start", {}, { id: "e3", parentId: "e2" }),
    ev(
      "subagent.started",
      {
        prompt: "You are EECOM, the Backend Engineer on this project.\nFix auth.",
        subagentId: "sa-1",
      },
      { id: "e4", parentId: "e3" },
    ),
    ev(
      "subagent.started",
      { prompt: "You are GNC, the Tester on this project.\nWrite tests.", subagentId: "sa-2" },
      { id: "e5", parentId: "e3" },
    ),
    // EECOM's stream
    ev("assistant.message", { content: "Looking at auth.ts now" }, { id: "e6", parentId: "e4" }),
    ev(
      "tool.execution_start",
      {
        name: "str_replace",
        toolCallId: "call-1",
        arguments: {
          path: "/repo/src/auth.ts",
          old_str: "return undefined",
          new_str: "return session ?? redirect()",
        },
      },
      { id: "e7", parentId: "e6" },
    ),
    ev(
      "tool.execution_complete",
      { toolCallId: "call-1", success: true, result: "edited" },
      { id: "e8", parentId: "e7", timestamp: "2026-08-20T10:01:30.000Z" },
    ),
    ev(
      "assistant.turn_end",
      { usage: { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 50 } },
      { id: "e9", parentId: "e8" },
    ),
    ev("subagent.completed", { subagentId: "sa-1", result: "auth fixed" }, { id: "e10", parentId: "e9" }),
    // GNC's stream — never completes (orphan)
    ev("assistant.message", { content: "Writing tests" }, { id: "e11", parentId: "e5" }),
    // back on the parent
    ev("assistant.message", { content: "EECOM finished; GNC still running" }, { id: "e12", parentId: "e3" }),
  ];
}

test("squad session carves into parent + child runs with agent identity", async () => {
  const store = freshStore();
  const path = writeSession(squadSession(), {
    workspaceYaml: "cwd: /repo\n",
  });
  const r = await ingestCopilotSession(store, path);
  assert.equal(r.status, "ok");
  assert.equal(r.child_run_ids.length, 2);

  const parent = getRun(store, r.run_id)!;
  assert.equal(parent.source_runtime, "github-copilot");
  assert.equal(parent.source_session_id, "sess-squad");
  assert.equal(parent.provider, "github");
  assert.equal(parent.cwd, "/repo");
  assert.equal(parent.parent_run_id, undefined);

  const children = getChildRuns(store, r.run_id);
  assert.equal(children.length, 2);
  const eecom = children.find((c) => c.tags.includes("agent:eecom"))!;
  assert.ok(eecom, "EECOM child carved with parsed agent name");
  assert.equal(eecom.parent_run_id, r.run_id);
  assert.ok(eecom.parent_run_step_id, "dispatch step linked");
  assert.equal(eecom.provider, "github");
  assert.ok(eecom.title?.startsWith("EECOM"));
  assert.ok(
    eecom.tags.includes("role:backend-engineer"),
    `role tag parsed from spawn prompt: ${JSON.stringify(eecom.tags)}`,
  );

  // Parent carries one sub_agent_dispatch step per spawn.
  const parentSteps = listSteps(store, r.run_id);
  const dispatches = parentSteps.filter(
    (s) => s.action.kind === "sub_agent_dispatch",
  );
  assert.equal(dispatches.length, 2);
  const eecomDispatch = dispatches.find((s) => s.action.sub_agent === "EECOM")!;
  assert.equal(eecomDispatch.outcome.status, "ok");
  assert.equal(eecomDispatch.step_id, eecom.parent_run_step_id);

  // EECOM's stream landed on the child, not the parent.
  const eecomSteps = listSteps(store, eecom.run_id);
  assert.ok(
    eecomSteps.some(
      (s) => s.action.kind === "tool_call" && s.action.tool_name === "str_replace",
    ),
    "tool call routed to child by correlation",
  );
  assert.ok(
    !parentSteps.some((s) => s.action.tool_name === "str_replace"),
    "tool call NOT on parent",
  );

  // Turn usage attributed to the child's assistant step; priced (bare
  // model name prefix-matches PRICING → not unpriced).
  const usageStep = eecomSteps.find((s) => s.tokens.input === 1200)!;
  assert.ok(usageStep, "turn_end usage applied");
  assert.equal(usageStep.tokens.output, 300);
  assert.ok(usageStep.cost_cents > 0);
  assert.ok(!usageStep.tags.includes("cost:unpriced"));

  // Tool latency from start→complete timestamps.
  const toolStep = eecomSteps.find((s) => s.action.kind === "tool_call")!;
  assert.equal(toolStep.outcome.status, "ok");
  assert.ok(toolStep.latency_ms > 0);

  // EECOM completed → ok; GNC orphan + parent terminal → abandoned.
  assert.equal(getRun(store, eecom.run_id)!.status, "ok");
  const gnc = children.find((c) => c.tags.includes("agent:gnc"))!;
  assert.equal(gnc.status, "abandoned");

  // File change: the str_replace had no prior view/create of the path
  // in the session, so the row is an honest partial (no blobs) with the
  // input-derived patch and the reason recorded. The absolute tool-
  // input path relativizes against the workspace cwd.
  const fcs = listFileChanges(store, { runId: eecom.run_id });
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.op, "modify");
  assert.equal(fcs[0]!.partial_diff, true);
  assert.equal(fcs[0]!.before_blob_ref, undefined);
  assert.equal(fcs[0]!.after_blob_ref, undefined);
  assert.equal(fcs[0]!.path, "src/auth.ts");
  assert.ok(fcs[0]!.patch_text?.includes("+return session"));
  assert.equal(fcs[0]!.lines_added, 1);
  assert.equal(fcs[0]!.lines_removed, 1);
  assert.deepEqual(fcs[0]!.normalizer_notes, {
    before_source: "none",
    before_miss: "no-prior-image",
  });
  assert.equal(fcs[0]!.redacted, false, "no secrets in fixture → not redacted");
});

test("re-ingest is a no-op on unchanged file and duplicates nothing on growth", async () => {
  const store = freshStore();
  const path = writeSession(squadSession(), { workspaceYaml: "cwd: /repo\n" });
  const first = await ingestCopilotSession(store, path);
  const second = await ingestCopilotSession(store, path);
  assert.equal(second.status, "empty");

  // Grow the file → whole-file re-carve, deterministic ids upsert in place.
  appendFileSync(
    path,
    JSON.stringify(
      ev("assistant.message", { content: "wrapping up" }, { id: "e99", parentId: "e3" }),
    ) + "\n",
  );
  const third = await ingestCopilotSession(store, path);
  assert.equal(third.status, "ok");
  assert.equal(third.run_id, first.run_id, "parent run id stable across re-carve");
  assert.deepEqual(
    [...third.child_run_ids].sort(),
    [...first.child_run_ids].sort(),
    "child run ids stable across re-carve",
  );
  const runs = listRuns(store, { includeChildren: true });
  assert.equal(runs.length, 3, "no duplicate runs after re-carve");
  const parentSteps = listSteps(store, first.run_id);
  const seqs = parentSteps.map((s) => s.sequence);
  assert.equal(new Set(seqs).size, seqs.length, "no duplicate sequences");
});

test("session without correlation ids degrades to parent-only (no carving)", async () => {
  const store = freshStore();
  const events = [
    { type: "session.start", timestamp: "2026-08-20T10:00:00Z", data: { sessionId: "sess-noid", model: "gpt-5" } },
    { type: "user.message", timestamp: "2026-08-20T10:00:01Z", data: { content: "go" } },
    { type: "subagent.started", timestamp: "2026-08-20T10:00:02Z", data: { agentName: "Ripley" } },
    { type: "assistant.message", timestamp: "2026-08-20T10:00:03Z", data: { content: "done" } },
  ];
  const path = writeSession(events);
  const r = await ingestCopilotSession(store, path);
  assert.equal(r.child_run_ids.length, 0, "no children without correlation ids");
  const steps = listSteps(store, r.run_id);
  const dispatch = steps.find((s) => s.action.kind === "sub_agent_dispatch")!;
  assert.ok(dispatch, "dispatch step still recorded");
  assert.equal(dispatch.action.sub_agent, "Ripley");
  assert.ok(dispatch.tags.includes("agent:ripley"));
  assert.equal(getRun(store, r.run_id)!.status, "ok");
});

test("unroutable parentId lands on parent tagged copilot:unrouted, never dropped", async () => {
  const store = freshStore();
  const events = [
    ev("session.start", { sessionId: "sess-drift", model: "claude-sonnet-4.5" }, { id: "d1" }),
    ev("user.message", { content: "hello" }, { id: "d2", parentId: "d1" }),
    // parentId references an id that appears nowhere in the file.
    ev("assistant.message", { content: "ghost" }, { id: "d3", parentId: "never-seen" }),
  ];
  const path = writeSession(events);
  const r = await ingestCopilotSession(store, path);
  const steps = listSteps(store, r.run_id);
  const ghost = steps.find((s) => s.action.text === "ghost")!;
  assert.ok(ghost, "unroutable event still became a step");
  assert.ok(ghost.tags.includes("copilot:unrouted"));
  assert.equal(ghost.run_id, r.run_id);
});

test("vendor-namespaced model gets cost:unpriced, premium requests recorded", async () => {
  const store = freshStore();
  const events = [
    ev("session.start", { sessionId: "sess-open", model: "meta/llama-3.3-70b" }, { id: "m1" }),
    ev("user.message", { content: "hi" }, { id: "m2", parentId: "m1" }),
    ev("assistant.message", { content: "hey" }, { id: "m3", parentId: "m2" }),
    ev(
      "assistant.turn_end",
      { usage: { inputTokens: 500, outputTokens: 100, premiumRequests: 2 } },
      { id: "m4", parentId: "m3" },
    ),
  ];
  const path = writeSession(events);
  const r = await ingestCopilotSession(store, path);
  const steps = listSteps(store, r.run_id);
  const usageStep = steps.find((s) => s.tokens.input === 500)!;
  assert.ok(usageStep, "camelCase usage aliases normalized");
  assert.equal(usageStep.cost_cents, 0);
  assert.ok(usageStep.tags.includes("cost:unpriced"), "unpriced, never $0.00-as-real");
  assert.ok(usageStep.tags.includes("premium_requests:2"));
});

test("status inference: recent user-last is in_progress, stale user-last is abandoned, session.error-last is error", async () => {
  const store = freshStore();
  // Recent activity + mid-turn last event → still in progress.
  const inProgress = writeSession([
    ev("session.start", { sessionId: "s-ip" }, { id: "p1", timestamp: recentTs(120) }),
    ev("user.message", { content: "still typing?" }, { id: "p2", parentId: "p1", timestamp: recentTs(60) }),
  ]);
  const r1 = await ingestCopilotSession(store, inProgress);
  assert.equal(getRun(store, r1.run_id)!.status, "in_progress");

  // Same shape but silent past the staleness window (fixture dates are
  // days old) → the session died mid-turn → abandoned, not a forever
  // in_progress row polluting the fleet.
  const staleMidTurn = writeSession([
    ev("session.start", { sessionId: "s-stale" }, { id: "s1" }),
    ev("user.message", { content: "crashed after this" }, { id: "s2", parentId: "s1" }),
  ]);
  const r3 = await ingestCopilotSession(store, staleMidTurn);
  assert.equal(getRun(store, r3.run_id)!.status, "abandoned");

  const errored = writeSession([
    ev("session.start", { sessionId: "s-err" }, { id: "q1" }),
    ev("user.message", { content: "go" }, { id: "q2", parentId: "q1" }),
    ev("session.error", { message: "boom" }, { id: "q3", parentId: "q2" }),
  ]);
  const r2 = await ingestCopilotSession(store, errored);
  assert.equal(getRun(store, r2.run_id)!.status, "error");
});

test("live squad tail: uncompleted children stay in_progress while the session is fresh", async () => {
  const store = freshStore();
  // Parent dispatched an agent and went quiet; the agent is streaming
  // (recent events) but has not completed. The old parent-terminal rule
  // flipped such children to abandoned every tick (adversarial review
  // finding); session-level freshness keeps them honest.
  const path = writeSession([
    ev("session.start", { sessionId: "s-live" }, { id: "l1", timestamp: recentTs(300) }),
    ev("user.message", { content: "build it" }, { id: "l2", parentId: "l1", timestamp: recentTs(290) }),
    ev(
      "subagent.started",
      { prompt: "You are Ripley, the Builder on this project.", subagentId: "sa-l1" },
      { id: "l3", parentId: "l2", timestamp: recentTs(280) },
    ),
    ev("assistant.message", { content: "working…" }, { id: "l4", parentId: "l3", timestamp: recentTs(10) }),
  ]);
  const r = await ingestCopilotSession(store, path);
  const child = getChildRuns(store, r.run_id)[0]!;
  assert.equal(child.status, "in_progress", "streaming child must not read abandoned");
});

test("malformed lines are skipped; compaction becomes an idempotent annotation", async () => {
  const store = freshStore();
  const path = writeSession([
    ev("session.start", { sessionId: "s-mixed" }, { id: "x1" }),
    ev("user.message", { content: "hi" }, { id: "x2", parentId: "x1" }),
    ev("session.compaction_start", {}, { id: "x3", parentId: "x2" }),
    ev("session.compaction_end", {}, { id: "x4", parentId: "x3" }),
    ev("assistant.message", { content: "compacted and done" }, { id: "x5", parentId: "x4" }),
  ]);
  appendFileSync(path, "{not valid json\n");
  appendFileSync(
    path,
    JSON.stringify(ev("assistant.message", { content: "after garbage" }, { id: "x6", parentId: "x5" })) + "\n",
  );
  const r = await ingestCopilotSession(store, path);
  assert.equal(r.status, "ok");
  const steps = listSteps(store, r.run_id);
  assert.ok(steps.some((s) => s.action.text === "after garbage"));

  const countAnnotations = () =>
    (store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM annotations WHERE target_id = ? AND kind = 'context_compaction'",
      )
      .get(r.run_id) as { n: number }).n;
  assert.equal(countAnnotations(), 2, "one annotation per compaction event");

  // Re-carve (grow the file) must not duplicate annotations.
  appendFileSync(
    path,
    JSON.stringify(ev("assistant.message", { content: "more" }, { id: "x7", parentId: "x6" })) + "\n",
  );
  await ingestCopilotSession(store, path);
  assert.equal(countAnnotations(), 2, "compaction annotations idempotent");
});

test("plain single-agent session: no children, no squad tags, title from first user message", async () => {
  const store = freshStore();
  const path = writeSession([
    ev("session.start", { sessionId: "s-solo", model: "gpt-5" }, { id: "s1" }),
    ev("user.message", { content: "Refactor the config loader\nplease" }, { id: "s2", parentId: "s1" }),
    ev("assistant.message", { content: "done" }, { id: "s3", parentId: "s2" }),
  ]);
  const r = await ingestCopilotSession(store, path);
  assert.equal(r.child_run_ids.length, 0);
  const run = getRun(store, r.run_id)!;
  assert.equal(run.title, "Refactor the config loader");
  assert.equal(run.status, "ok");
  assert.ok(run.tags.includes("copilot"));
});

test("shape probe flags unknown event types without breaking ingest", async () => {
  const events = [
    ev("session.start", { sessionId: "s-drift" }, { id: "u1" }),
    ev("totally.new_event", { whatever: 1 }, { id: "u2", parentId: "u1" }),
    ev("totally.new_event", { whatever: 2 }, { id: "u3", parentId: "u1" }),
  ];
  const parsed = parseEventsBuffer(
    Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"),
  );
  const warnings = probeEvents(parsed.map((p) => p.event));
  const unknown = warnings.find((w) => w.eventType === "totally.new_event")!;
  assert.ok(unknown, "unknown type surfaced");
  assert.equal(unknown.count, 2, "deduped by drift key, counted");

  const store = freshStore();
  const path = writeSession(events);
  const r = await ingestCopilotSession(store, path);
  assert.equal(r.status, "ok", "ingest survives unknown event types");
});

test("M2 gate: full re-carve produces byte-identical DB state", async () => {
  const store = freshStore();
  const path = writeSession(squadSession(), { workspaceYaml: "cwd: /repo\n" });
  await ingestCopilotSession(store, path);

  const dump = () => {
    const out: Record<string, unknown[]> = {};
    for (const table of [
      "runs",
      "steps",
      "file_change",
      "annotations",
      "projects",
      "agents",
      "context_snapshots",
    ]) {
      out[table] = store.db
        .prepare(`SELECT * FROM ${table} ORDER BY 1`)
        .all()
        // created_at on projects/agents/annotations is wall-clock; the
        // byte-identical guarantee covers carve-derived content.
        .map((row) => {
          const r = { ...(row as Record<string, unknown>) };
          delete r.created_at;
          delete r.last_ingested_at;
          return r;
        });
    }
    return JSON.stringify(out);
  };

  const before = dump();
  // Force a whole-file re-carve (the offset is only a change detector).
  setIngestOffset(store, "github-copilot", path, 0);
  const r2 = await ingestCopilotSession(store, path);
  assert.equal(r2.status, "ok");
  const after = dump();
  assert.equal(after, before, "re-carve must be byte-identical");
});

test("listRuns excludes carved children by default; includeChildren restores the flat set", async () => {
  const store = freshStore();
  const path = writeSession(squadSession(), { workspaceYaml: "cwd: /repo\n" });
  const r = await ingestCopilotSession(store, path);

  const topLevel = listRuns(store, {});
  assert.equal(topLevel.length, 1, "children excluded from default listing");
  assert.equal(topLevel[0]!.run_id, r.run_id);

  const flat = listRuns(store, { includeChildren: true });
  assert.equal(flat.length, 3, "includeChildren restores parent + agents");
});

test("REGRESSION v8: fresh schema has lineage columns; lineage-free runs list identically", async () => {
  const store = freshStore();
  const cols = (store.db.pragma("table_info(runs)") as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(cols.includes("parent_run_id"));
  assert.ok(cols.includes("parent_run_step_id"));

  // A lineage-free (claude-code-style) run round-trips with undefined
  // lineage — pre-v8 read behavior preserved.
  const path = writeSession([
    ev("session.start", { sessionId: "s-reg" }, { id: "g1" }),
    ev("assistant.message", { content: "done" }, { id: "g2", parentId: "g1" }),
  ]);
  const r = await ingestCopilotSession(store, path);
  const run = listRuns(store, {}).find((x) => x.run_id === r.run_id)!;
  assert.equal(run.parent_run_id, undefined);
  assert.equal(run.parent_run_step_id, undefined);
  assert.equal(getChildRuns(store, r.run_id).length, 0);
});

test("REAL SHAPE (Copilot CLI ≥1.0.80): interaction-stream carve — siblings, prompt identity, per-message tokens, shutdown totals", async () => {
  const store = freshStore();
  // Replicates the observed real format (2026-08-26 live session):
  // a FLAT linked list (every parentId = previous event), streams keyed
  // by interactionId, spawn prompts in `task` tool arguments, subagent
  // lifecycle joined by toolCallId, per-message outputTokens, and a
  // session.shutdown carrying the session-total token breakdown.
  const MAIN = "iid-main";
  const A = "iid-frontend";
  const B = "iid-backend";
  const promptA = "You are Frontend, the UI engineer for the recipe app.\nGoal: build the form.";
  const promptB = "You are Backend, the Express engineer for the recipe app.\nGoal: build the API.";
  let prev: string | null = null;
  let n = 0;
  const lin = (type: string, data: Record<string, unknown>) => {
    const id = `ev${n++}`;
    const e = ev(type, data, { id, parentId: prev ?? undefined, timestamp: recentTs(600 - n * 5) });
    (e as { parentId: string | null }).parentId = prev;
    prev = id;
    return e;
  };
  const path = writeSession(
    [
      lin("session.start", { sessionId: "s-real", model: "gpt-5-mini" }),
      lin("user.message", { content: "build it all", interactionId: MAIN }),
      lin("tool.execution_start", {
        toolName: "task",
        toolCallId: "call_A",
        arguments: { description: "Frontend work", prompt: promptA },
      }),
      lin("subagent.started", {
        toolCallId: "call_A",
        agentName: "task",
        agentDisplayName: "Task Agent",
        model: "gpt-5-mini",
      }),
      lin("tool.execution_start", {
        toolName: "task",
        toolCallId: "call_B",
        arguments: { description: "Backend work", prompt: promptB },
      }),
      lin("subagent.started", {
        toolCallId: "call_B",
        agentName: "task",
        agentDisplayName: "Task Agent",
        model: "gpt-5-mini",
      }),
      // Children's spawn user.messages bind their interaction streams.
      lin("user.message", { content: promptA, interactionId: A }),
      lin("user.message", { content: promptB, interactionId: B }),
      // Interleaved child work with per-message outputTokens.
      lin("assistant.message", {
        content: "building form",
        interactionId: A,
        model: "gpt-5-mini",
        outputTokens: 1000,
      }),
      lin("assistant.message", {
        content: "building api",
        interactionId: B,
        model: "gpt-5-mini",
        outputTokens: 2000,
      }),
      // A child tool call: start has NO interactionId (real shape) —
      // joined via its completion's interactionId.
      lin("tool.execution_start", {
        toolName: "create",
        toolCallId: "call_fA",
        arguments: { path: "/repo/src/Form.tsx", content: "export {}\n" },
      }),
      lin("tool.execution_complete", {
        toolCallId: "call_fA",
        interactionId: A,
        success: true,
        result: "created",
      }),
      lin("subagent.completed", {
        toolCallId: "call_A",
        agentName: "task",
        totalTokens: 5000,
        durationMs: 1234,
      }),
      lin("subagent.completed", {
        toolCallId: "call_B",
        agentName: "task",
        totalTokens: 7000,
        durationMs: 2345,
      }),
      lin("session.shutdown", {
        shutdownType: "routine",
        totalPremiumRequests: 2,
        tokenDetails: {
          input: { tokenCount: 100000 },
          cache_read: { tokenCount: 50000 },
          cache_write: { tokenCount: 0 },
          output: { tokenCount: 3000 },
        },
      }),
    ],
    { workspaceYaml: "cwd: /repo\n" },
  );
  const r = await ingestCopilotSession(store, path);
  assert.equal(r.status, "ok");
  assert.equal(r.child_run_ids.length, 2);

  const parentRun = getRun(store, r.run_id)!;
  const kids = getChildRuns(store, parentRun.run_id);
  assert.equal(kids.length, 2, "both agents are SIBLINGS under the parent (not a chain)");

  const frontend = kids.find((c) => c.tags.includes("agent:frontend"))!;
  const backend = kids.find((c) => c.tags.includes("agent:backend"))!;
  assert.equal(frontend.title, "Frontend — UI engineer", "identity from the task spawn prompt");
  assert.equal(backend.title, "Backend — Express engineer");
  assert.equal(frontend.status, "ok", "completion joined by toolCallId");
  assert.equal(backend.status, "ok");
  assert.equal(parentRun.status, "ok", "session.shutdown is an at-rest event");

  // Per-message output tokens land on the owning child.
  assert.equal(frontend.tokens_total_output, 1000);
  assert.equal(backend.tokens_total_output, 2000);
  assert.ok(frontend.tags.includes("agent_total_tokens:5000"));

  // The iid-less tool start joined to Frontend via its completion.
  const fFcs = listFileChanges(store, { runId: frontend.run_id });
  assert.equal(fFcs.length, 1, "child file change routed via toolCallId→interaction join");
  assert.equal(fFcs[0]!.path, "src/Form.tsx");

  // Session input totals land on the parent, tagged, never on children.
  assert.equal(parentRun.tokens_total_input, 100000);
  assert.equal(parentRun.tokens_total_cached, 50000);
  assert.ok(parentRun.tags.includes("premium_requests:2"));

  // Nothing in a real-shaped (flat linked list) file is "unrouted".
  const allSteps = [parentRun, ...kids].flatMap((run) => listSteps(store, run.run_id));
  assert.ok(
    !allSteps.some((s) => s.tags.includes("copilot:unrouted")),
    "flat parentId chain is the format's normal shape, not drift",
  );
});

test("REVIEW: cyclic/self-referential parentId does not hang; events land unrouted on parent", async () => {
  const store = freshStore();
  const path = writeSession([
    ev("session.start", { sessionId: "s-cycle" }, { id: "c1" }),
    // Self-referential chain — a corrupted or adversarial line must not
    // spin the ancestry walk forever (event-loop DoS in the live poll).
    ev("assistant.message", { content: "loop" }, { id: "c2", parentId: "c2" }),
    // Two-node cycle referencing each other.
    ev("assistant.message", { content: "a" }, { id: "c3", parentId: "c4" }),
    ev("assistant.message", { content: "b" }, { id: "c4", parentId: "c3" }),
  ]);
  const r = (await Promise.race([
    ingestCopilotSession(store, path),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("ingest hung on parentId cycle")), 5000),
    ),
  ])) as { run_id: string; status: string };
  assert.equal(r.status, "ok");
  const steps = listSteps(store, r.run_id);
  const cyclic = steps.filter((s) => s.tags.includes("copilot:unrouted"));
  assert.ok(cyclic.length >= 2, "cyclic events tagged unrouted, never dropped");
});

test("REVIEW: file shrink/rewrite re-carves instead of reporting empty forever", async () => {
  const store = freshStore();
  const path = writeSession([
    ev("session.start", { sessionId: "s-shrink" }, { id: "h1" }),
    ev("user.message", { content: "one" }, { id: "h2", parentId: "h1" }),
    ev("assistant.message", { content: "two" }, { id: "h3", parentId: "h2" }),
    ev("assistant.message", { content: "three" }, { id: "h4", parentId: "h3" }),
  ]);
  const r1 = await ingestCopilotSession(store, path);
  assert.equal(listSteps(store, r1.run_id).length, 3);

  // The CLI rewrites the file smaller (compaction / reset).
  writeFileSync(
    path,
    [
      ev("session.start", { sessionId: "s-shrink" }, { id: "h1" }),
      ev("assistant.message", { content: "compacted" }, { id: "h9", parentId: "h1" }),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const r2 = await ingestCopilotSession(store, path);
  assert.equal(r2.status, "ok", "smaller file must re-carve, not report empty");
  const steps = listSteps(store, r2.run_id);
  assert.equal(steps.length, 1, "stale steps from the pre-rewrite carve removed");
  assert.equal(steps[0]!.action.text, "compacted");
});

test("REVIEW: trailing torn line does not force perpetual re-carves", async () => {
  const store = freshStore();
  const path = writeSession([
    ev("session.start", { sessionId: "s-torn" }, { id: "t1" }),
    ev("assistant.message", { content: "done" }, { id: "t2", parentId: "t1" }),
  ]);
  appendFileSync(path, '{"type":"assistant.mess'); // torn mid-write, no newline
  const r1 = await ingestCopilotSession(store, path);
  assert.equal(r1.status, "ok");
  const r2 = await ingestCopilotSession(store, path);
  assert.equal(
    r2.status,
    "empty",
    "unchanged file (torn tail included) must be a no-op on the next poll",
  );
});

test("REVIEW: secrets in tool inputs are redacted before persistence; FileChange.redacted is honest", async () => {
  const store = freshStore();
  // Assembled at runtime so no contiguous credential-shaped literal
  // exists in source — secret scanners (the repo pre-push guard,
  // GitHub secret scanning) would flag a plain literal. The joined
  // string matches the anthropic-key redaction rule.
  const secret = ["sk-ant", "api03-abcdefghijklmnop12345"].join("-");
  const path = writeSession(
    [
      ev("session.start", { sessionId: "s-red" }, { id: "r1" }),
      ev(
        "tool.execution_start",
        {
          name: "create",
          toolCallId: "call-red",
          arguments: { path: "/repo/.env", content: `OPENAI_API_KEY=${secret}\n` },
        },
        { id: "r2", parentId: "r1" },
      ),
      ev("tool.execution_complete", { toolCallId: "call-red", success: true }, { id: "r3", parentId: "r2" }),
    ],
    { workspaceYaml: "cwd: /repo\n" },
  );
  const r = await ingestCopilotSession(store, path);
  const step = listSteps(store, r.run_id).find((s) => s.action.kind === "tool_call")!;
  assert.ok(
    !JSON.stringify(step.action).includes(secret),
    "raw secret must not reach steps.action_json",
  );
  const fc = listFileChanges(store, { runId: r.run_id })[0]!;
  assert.ok(
    !JSON.stringify(fc.source_tool_input ?? "").includes(secret),
    "raw secret must not reach file_change.source_tool_input",
  );
  assert.equal(fc.redacted, true, "row must report that redaction happened");
  // `.env` is a sensitive path: the FACT of the create is recorded, the
  // contents never are — no after blob even though file_text is known.
  assert.equal(fc.after_blob_ref, undefined);
  assert.equal(fc.source_tool_input, undefined);
  assert.equal(
    (fc.normalizer_notes as { redacted_reason?: string }).redacted_reason,
    "sensitive-path",
  );
});

test("REVIEW: per-agent toolCallId collisions resolve to the right child run", async () => {
  const store = freshStore();
  const path = writeSession([
    ev("session.start", { sessionId: "s-collide" }, { id: "k1" }),
    ev("user.message", { content: "two agents, same call id" }, { id: "k2", parentId: "k1" }),
    ev(
      "subagent.started",
      { prompt: "You are Alpha, the Left Hand on this project.", subagentId: "sa-a" },
      { id: "k3", parentId: "k2" },
    ),
    ev(
      "subagent.started",
      { prompt: "You are Beta, the Right Hand on this project.", subagentId: "sa-b" },
      { id: "k4", parentId: "k2" },
    ),
    // Copilot may scope call ids per agent subprocess: both agents
    // legally use "call_1".
    ev(
      "tool.execution_start",
      { name: "bash", toolCallId: "call_1", arguments: { command: "echo alpha" } },
      { id: "k5", parentId: "k3" },
    ),
    ev(
      "tool.execution_start",
      { name: "bash", toolCallId: "call_1", arguments: { command: "echo beta" } },
      { id: "k6", parentId: "k4" },
    ),
    ev(
      "tool.execution_complete",
      { toolCallId: "call_1", result: "alpha-result", success: true },
      { id: "k7", parentId: "k5" },
    ),
    ev(
      "tool.execution_complete",
      { toolCallId: "call_1", result: "beta-result", success: true },
      { id: "k8", parentId: "k6" },
    ),
    ev("subagent.completed", { subagentId: "sa-a" }, { id: "k9", parentId: "k7" }),
    ev("subagent.completed", { subagentId: "sa-b" }, { id: "k10", parentId: "k8" }),
  ]);
  const r = await ingestCopilotSession(store, path);
  const kids = getChildRuns(store, r.run_id);
  const alpha = kids.find((c) => c.tags.includes("agent:alpha"))!;
  const beta = kids.find((c) => c.tags.includes("agent:beta"))!;
  const alphaTool = listSteps(store, alpha.run_id).find((s) => s.action.kind === "tool_call")!;
  const betaTool = listSteps(store, beta.run_id).find((s) => s.action.kind === "tool_call")!;
  assert.equal(alphaTool.outcome.summary, "alpha-result");
  assert.equal(betaTool.outcome.summary, "beta-result");
  assert.equal(alphaTool.outcome.status, "ok");
  assert.equal(betaTool.outcome.status, "ok");
});

test("REVIEW: re-carve refreshes run metadata (title arrives after first carve)", async () => {
  const store = freshStore();
  // First carve happens before the first user message exists (live
  // tail): the run has no title yet.
  const path = writeSession([
    ev("session.start", { sessionId: "s-title" }, { id: "m1" }),
  ]);
  const r1 = await ingestCopilotSession(store, path);
  assert.equal(getRun(store, r1.run_id)!.title, undefined);

  appendFileSync(
    path,
    JSON.stringify(
      ev("user.message", { content: "Fix the login bug" }, { id: "m2", parentId: "m1" }),
    ) + "\n",
  );
  const r2 = await ingestCopilotSession(store, path);
  assert.equal(r2.status, "ok");
  assert.equal(
    getRun(store, r1.run_id)!.title,
    "Fix the login bug",
    "re-carve must refresh carve-derived metadata on the existing row",
  );
});

test("REAL-SHAPE: session.shutdown abandons uncompleted agents immediately (no staleness wait)", async () => {
  const store = freshStore();
  // Observed live (squad session 4): shutdown "routine" landed while a
  // dispatched agent never got subagent.completed — the agent was cut
  // off. Recent timestamps keep the staleness window out of the way:
  // shutdown alone must settle the status.
  const path = writeSession([
    ev("session.start", { sessionId: "s-cutoff" }, { id: "z1", timestamp: recentTs(300) }),
    ev("user.message", { content: "go team" }, { id: "z2", parentId: "z1", timestamp: recentTs(290) }),
    ev(
      "subagent.started",
      { prompt: "You are Omega, the Finisher on this project.", subagentId: "sa-z" },
      { id: "z3", parentId: "z2", timestamp: recentTs(280) },
    ),
    ev("assistant.message", { content: "working…" }, { id: "z4", parentId: "z3", timestamp: recentTs(200) }),
    ev(
      "session.shutdown",
      { shutdownType: "routine", tokenDetails: { input: { tokenCount: 100 } } },
      { id: "z5", parentId: "z4", timestamp: recentTs(60) },
    ),
  ]);
  const r = await ingestCopilotSession(store, path);
  assert.equal(getRun(store, r.run_id)!.status, "ok", "shutdown seals the parent");
  const child = getChildRuns(store, r.run_id)[0]!;
  assert.equal(
    child.status,
    "abandoned",
    "uncompleted agent after shutdown must not sit in_progress for the staleness window",
  );
});

test("REVIEW: routing drift across re-carves does not double-count steps (torn subagent.started completes)", async () => {
  const store = freshStore();
  const startLine = JSON.stringify(
    ev(
      "subagent.started",
      { prompt: "You are Gamma, the Fixer on this project.", subagentId: "sa-g" },
      { id: "d3", parentId: "d2" },
    ),
  );
  const sessionHead = [
    ev("session.start", { sessionId: "s-drift" }, { id: "d1" }),
    ev("user.message", { content: "dispatch" }, { id: "d2", parentId: "d1" }),
  ];
  const childEvents = [
    ev("assistant.message", { content: "gamma working" }, { id: "d4", parentId: "d3" }),
    ev(
      "assistant.turn_end",
      { usage: { input_tokens: 500, output_tokens: 100 } },
      { id: "d5", parentId: "d4" },
    ),
  ];
  // Tick 1: the subagent.started line is torn (unparsable) — gamma's
  // events walk a broken chain and land on the parent, tagged unrouted.
  const path = writeSession(sessionHead);
  appendFileSync(
    path,
    startLine.slice(0, 40) + "\n" + childEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  const r1 = await ingestCopilotSession(store, path);
  assert.equal(r1.child_run_ids.length, 0, "torn start line → no child yet");
  const parentTokensT1 = getRun(store, r1.run_id)!.tokens_total_input;
  assert.equal(parentTokensT1, 500, "usage landed on parent while unrouted");

  // Tick 2: the line completes (the CLI finished its write) — rewrite
  // the file with the intact line in place.
  writeFileSync(
    path,
    sessionHead
      .map((e) => JSON.stringify(e))
      .concat([startLine])
      .concat(childEvents.map((e) => JSON.stringify(e)))
      .join("\n") + "\n",
  );
  const r2 = await ingestCopilotSession(store, path);
  assert.equal(r2.child_run_ids.length, 1, "child carved once the line parses");
  const parent = getRun(store, r2.run_id)!;
  const child = getRun(store, r2.child_run_ids[0]!)!;
  assert.equal(child.tokens_total_input, 500, "usage moved to the child");
  assert.equal(
    parent.tokens_total_input,
    0,
    "stale parent-side steps deleted — tokens must not exist in both runs",
  );
  const parentSteps = listSteps(store, parent.run_id);
  assert.ok(
    !parentSteps.some((s) => s.action.text === "gamma working"),
    "relocated step no longer on the parent",
  );
});

// ─── File-change fidelity (real Copilot CLI ≥1.0 shapes, 2026-10) ─────
//
// Fixtures below replicate the observed real records (paths/contents
// redacted): `view` results number every line "N. " and ship the whole
// file as an all-context diff in detailedContent; `create`/`edit`
// completions ship a git unified diff of what was written; failures
// carry success:false + error:{message, code} and no result; every
// `bash` start carries shellToolInfo.

const RECIPES_BEFORE = [
  "const express = require('express');",
  "const router = express.Router();",
  "",
  "function norm(s) {",
  "  return (s || '').toString().toLowerCase();",
  "}",
  "",
  "module.exports = router;",
  "",
].join("\n");

/** Real view shape: "N. " numbering, empty lines keep the trailing space. */
function numbered(text: string): string {
  return text
    .split("\n")
    .map((l, i) => `${i + 1}. ${l}`)
    .join("\n");
}

function gitDiff(path: string, hunk: string): string {
  return `\ndiff --git a${path} b${path}\nindex 0000000..0000000 100644\n--- a${path}\n+++ b${path}\n${hunk}`;
}

/** Linear real-shape session builder (flat parentId chain, interactionId streams). */
function realSession() {
  let prev: string | null = null;
  let n = 0;
  const events: Record<string, unknown>[] = [];
  const lin = (type: string, data: Record<string, unknown>) => {
    const id = `rv${n++}`;
    const e = ev(type, data, { id, parentId: prev ?? undefined, timestamp: recentTs(900 - n * 5) });
    (e as { parentId: string | null }).parentId = prev;
    prev = id;
    events.push(e);
    return e;
  };
  return { events, lin };
}

test("REAL-SHAPE file changes: view → edit is a full row (both blobs, before_source view_result, hunk cross-check); create is a full row; a chained edit uses session_chain", async () => {
  const store = freshStore();
  const MAIN = "iid-main";
  const P = "/repo/backend/routes/recipes.js";
  const oldStr = "function norm(s) {\n  return (s || '').toString().toLowerCase();\n}\n";
  const newStr =
    "function norm(s) {\n  return (s || '').toString().toLowerCase();\n}\n\nfunction loadRatings() {\n  return {};\n}\n";
  const after1 = RECIPES_BEFORE.replace(oldStr, newStr);
  const editHunk =
    "@@ -4,5 +4,9 @@\n function norm(s) {\n   return (s || '').toString().toLowerCase();\n }\n \n+function loadRatings() {\n+  return {};\n+}\n+\n module.exports = router;\n";
  const { events, lin } = realSession();
  lin("session.start", { sessionId: "s-fc", copilotVersion: "1.0.80" });
  lin("user.message", { content: "add ratings", interactionId: MAIN });
  lin("assistant.turn_start", { interactionId: MAIN, turnId: "0" });
  // 1. view (no range) → whole-file image
  lin("tool.execution_start", { toolName: "view", toolCallId: "toolu_v1", arguments: { path: P } });
  lin("tool.execution_complete", {
    toolCallId: "toolu_v1",
    interactionId: MAIN,
    success: true,
    result: {
      content: numbered(RECIPES_BEFORE),
      detailedContent: gitDiff(
        P,
        "@@ -1,9 +1,9 @@\n" + RECIPES_BEFORE.split("\n").map((l) => ` ${l}`).join("\n"),
      ),
    },
  });
  // 2. edit → full row from the view image
  lin("tool.execution_start", {
    toolName: "edit",
    toolCallId: "toolu_e1",
    arguments: { path: P, old_str: oldStr, new_str: newStr },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_e1",
    interactionId: MAIN,
    success: true,
    result: { content: `File ${P} updated with changes.`, detailedContent: gitDiff(P, editHunk) },
  });
  // 3. create → after blob from file_text
  const C = "/repo/backend/data/ratings.json";
  const fileText = '{\n  "recipes": {}\n}\n';
  lin("tool.execution_start", {
    toolName: "create",
    toolCallId: "toolu_c1",
    arguments: { path: C, file_text: fileText },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_c1",
    interactionId: MAIN,
    success: true,
    result: {
      content: `Created file ${C} with 20 characters`,
      detailedContent: gitDiff(C, '@@ -0,0 +1,3 @@\n+{\n+  "recipes": {}\n+}\n'),
    },
  });
  // 4. second edit of recipes.js with NO new view → session chain
  lin("tool.execution_start", {
    toolName: "edit",
    toolCallId: "toolu_e2",
    arguments: { path: P, old_str: "  return {};\n", new_str: "  return { recipes: {} };\n" },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_e2",
    interactionId: MAIN,
    success: true,
    result: {
      content: `File ${P} updated with changes.`,
      detailedContent: gitDiff(P, "@@ -8,3 +8,3 @@\n function loadRatings() {\n-  return {};\n+  return { recipes: {} };\n }\n"),
    },
  });
  lin("assistant.turn_end", { turnId: "0" });
  lin("session.shutdown", {
    shutdownType: "routine",
    codeChanges: { linesAdded: 8, linesRemoved: 1, filesModified: [P, C] },
    tokenDetails: { input: { tokenCount: 10 } },
  });
  const path = writeSession(events, { workspaceYaml: "cwd: /repo\n" });
  const r = await ingestCopilotSession(store, path);
  assert.equal(r.status, "ok");
  assert.equal(r.file_changes_added, 3);

  const fcs = listFileChanges(store, { runId: r.run_id }).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  assert.deepEqual(
    fcs.map((f) => [f.op, f.path, f.partial_diff, f.lines_added, f.lines_removed]),
    [
      ["modify", "backend/routes/recipes.js", false, 4, 0],
      ["create", "backend/data/ratings.json", false, 3, 0],
      ["modify", "backend/routes/recipes.js", false, 1, 1],
    ],
  );

  // Edit 1: before = the stripped view, after = before with old→new.
  const e1 = fcs[0]!;
  assert.deepEqual(e1.normalizer_notes, { before_source: "view_result", hunk_check: "ok" });
  assert.equal(await store.blobs.getString(e1.before_blob_ref!), RECIPES_BEFORE);
  assert.equal(await store.blobs.getString(e1.after_blob_ref!), after1);
  assert.equal(e1.patch_format, "unified");
  assert.ok(
    e1.patch_text!.startsWith("\ndiff --git a/backend/routes/recipes.js b/backend/routes/recipes.js\n"),
    `Copilot's own diff is the patch_text, headers relativized: ${e1.patch_text!.slice(0, 80)}`,
  );
  assert.ok(e1.patch_text!.includes("\n--- a/backend/routes/recipes.js\n+++ b/backend/routes/recipes.js\n"));
  assert.ok(e1.patch_text!.includes("+function loadRatings() {"));
  assert.equal(e1.line_count_before, 8);
  assert.equal(e1.line_count_after, 12);
  assert.equal(e1.source_tool_name, "edit");
  assert.equal(e1.tool_call_id, "toolu_e1");

  // Create: no before (op create), after = file_text verbatim.
  const c1 = fcs[1]!;
  assert.equal(c1.before_blob_ref, undefined);
  assert.equal(await store.blobs.getString(c1.after_blob_ref!), fileText);
  assert.deepEqual(c1.normalizer_notes, { hunk_check: "ok" });
  assert.ok(c1.patch_text!.includes('+  "recipes": {}'));

  // Edit 2: chained from edit 1's after-image.
  const e2 = fcs[2]!;
  assert.deepEqual(e2.normalizer_notes, { before_source: "session_chain", hunk_check: "ok" });
  assert.equal(await store.blobs.getString(e2.before_blob_ref!), after1);
  assert.equal(
    await store.blobs.getString(e2.after_blob_ref!),
    after1.replace("  return {};\n", "  return { recipes: {} };\n"),
  );

  // Session totals agree with the CLI's own codeChanges counters.
  const added = fcs.reduce((n, f) => n + f.lines_added, 0);
  const removed = fcs.reduce((n, f) => n + f.lines_removed, 0);
  assert.equal(added, 8);
  assert.equal(removed, 1);

  // Every tool step resolved; the probe stayed quiet on these shapes.
  const parsed = parseEventsBuffer(
    Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"),
  );
  assert.deepEqual(probeEvents(parsed.map((p) => p.event)), []);
});

test("REAL-SHAPE file changes: failed create / edit / bash completions produce NO row; the step records the error", async () => {
  const store = freshStore();
  const MAIN = "iid-main";
  const { events, lin } = realSession();
  lin("session.start", { sessionId: "s-fail" });
  lin("user.message", { content: "go", interactionId: MAIN });
  lin("tool.execution_start", {
    toolName: "create",
    toolCallId: "toolu_cf",
    arguments: { path: "/repo/src/exists.js", file_text: "module.exports = 1;\n" },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_cf",
    interactionId: MAIN,
    success: false,
    error: { message: "Path already exists", code: "failure" },
  });
  lin("tool.execution_start", {
    toolName: "edit",
    toolCallId: "toolu_ef",
    arguments: { path: "/repo/src/exists.js", old_str: "nope", new_str: "yes" },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_ef",
    interactionId: MAIN,
    success: false,
    error: { message: "No match found", code: "failure" },
  });
  lin("tool.execution_start", {
    toolName: "bash",
    toolCallId: "toolu_bf",
    arguments: { command: "pkill node", description: "stop" },
    shellToolInfo: { possiblePaths: ["node"], hasWriteFileRedirection: false },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_bf",
    interactionId: MAIN,
    success: false,
    error: { message: "Command not executed. The 'pkill' command is not allowed.", code: "failure" },
  });
  // One success so the fixture proves rows CAN be produced here.
  lin("tool.execution_start", {
    toolName: "create",
    toolCallId: "toolu_ok",
    arguments: { path: "/repo/src/new.js", file_text: "export {};\n" },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_ok",
    interactionId: MAIN,
    success: true,
    result: { content: "Created file /repo/src/new.js with 11 characters" },
  });
  lin("session.shutdown", { shutdownType: "routine" });
  const path = writeSession(events, { workspaceYaml: "cwd: /repo\n" });
  const r = await ingestCopilotSession(store, path);
  const fcs = listFileChanges(store, { runId: r.run_id });
  assert.deepEqual(
    fcs.map((f) => [f.op, f.path, f.partial_diff, f.lines_added]),
    [["create", "src/new.js", false, 1]],
  );
  const errSteps = listSteps(store, r.run_id).filter((s) => s.status === "error");
  assert.deepEqual(
    errSteps.map((s) => s.action.tool_name).sort(),
    ["bash", "create", "edit"],
    "failures are still visible as error steps",
  );
});

test("REAL-SHAPE file changes: a mutating start with no completion keeps a partial stub; a re-carve with the completion replaces it", async () => {
  const store = freshStore();
  const MAIN = "iid-main";
  const { events, lin } = realSession();
  lin("session.start", { sessionId: "s-torn" });
  lin("user.message", { content: "go", interactionId: MAIN });
  lin("tool.execution_start", {
    toolName: "create",
    toolCallId: "toolu_t1",
    arguments: { path: "/repo/a.txt", file_text: "one\ntwo\n" },
  });
  const path = writeSession(events, { workspaceYaml: "cwd: /repo\n" });
  const r1 = await ingestCopilotSession(store, path);
  const stub = listFileChanges(store, { runId: r1.run_id });
  assert.equal(stub.length, 1);
  assert.equal(stub[0]!.partial_diff, true);
  assert.equal(stub[0]!.after_blob_ref, undefined);
  assert.equal(stub[0]!.lines_added, 2);
  assert.deepEqual(stub[0]!.normalizer_notes, { completion: "missing", before_source: "none" });

  // The completion lands (live tail grew) → full row, same id, no dup.
  const done = lin("tool.execution_complete", {
    toolCallId: "toolu_t1",
    interactionId: MAIN,
    success: true,
    result: { content: "Created file /repo/a.txt with 8 characters" },
  });
  appendFileSync(path, JSON.stringify(done) + "\n");
  const r2 = await ingestCopilotSession(store, path);
  assert.equal(r2.run_id, r1.run_id);
  const rows = listFileChanges(store, { runId: r1.run_id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.file_change_id, stub[0]!.file_change_id, "deterministic id");
  assert.equal(rows[0]!.partial_diff, false);
  assert.equal(await store.blobs.getString(rows[0]!.after_blob_ref!), "one\ntwo\n");
  assert.equal(rows[0]!.normalizer_notes, undefined);
});

test("REAL-SHAPE file changes: bash leaves a (shell) stub; a write redirection confirmed by shellToolInfo becomes a path-aware stub", async () => {
  const store = freshStore();
  const MAIN = "iid-main";
  const { events, lin } = realSession();
  lin("session.start", { sessionId: "s-bash" });
  lin("user.message", { content: "run", interactionId: MAIN });
  // Plain command: generic stub.
  lin("tool.execution_start", {
    toolName: "bash",
    toolCallId: "toolu_b1",
    arguments: { command: "npm test", description: "tests" },
    shellToolInfo: { possiblePaths: ["test"], hasWriteFileRedirection: false },
  });
  lin("tool.execution_complete", { toolCallId: "toolu_b1", interactionId: MAIN, success: true, result: { content: "ok" } });
  // Real observed shape: `npm start > /tmp/backend.log 2>&1 &` with the
  // log path among possiblePaths and hasWriteFileRedirection true.
  lin("tool.execution_start", {
    toolName: "bash",
    toolCallId: "toolu_b2",
    arguments: { command: "cd /repo/backend && npm start > /tmp/backend.log 2>&1 &", description: "start" },
    shellToolInfo: {
      possiblePaths: ["/tmp/backend.log", "/repo/backend", "start"],
      hasWriteFileRedirection: true,
    },
  });
  lin("tool.execution_complete", { toolCallId: "toolu_b2", interactionId: MAIN, success: true, result: { content: "" } });
  // Redirect to /dev/null only: flagged by the CLI but nothing we would
  // name → generic stub, never a "dev/null" row.
  lin("tool.execution_start", {
    toolName: "bash",
    toolCallId: "toolu_b3",
    arguments: { command: "ls /repo/src > /dev/null", description: "ls" },
    shellToolInfo: { possiblePaths: ["/dev/null", "/repo/src"], hasWriteFileRedirection: true },
  });
  lin("tool.execution_complete", { toolCallId: "toolu_b3", interactionId: MAIN, success: true, result: { content: "" } });
  // Heredoc into a repo file, quoted target.
  lin("tool.execution_start", {
    toolName: "bash",
    toolCallId: "toolu_b4",
    arguments: { command: "cat > '/repo/.squad/log.md' <<'EOF'\nhi\nEOF", description: "log" },
    shellToolInfo: { possiblePaths: ["/repo/.squad/log.md"], hasWriteFileRedirection: true },
  });
  lin("tool.execution_complete", { toolCallId: "toolu_b4", interactionId: MAIN, success: true, result: { content: "" } });
  lin("session.shutdown", { shutdownType: "routine" });
  const path = writeSession(events, { workspaceYaml: "cwd: /repo\n" });
  const r = await ingestCopilotSession(store, path);
  const fcs = listFileChanges(store, { runId: r.run_id }).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  assert.deepEqual(
    fcs.map((f) => [f.path, f.op, f.partial_diff, f.normalizer_notes ?? null]),
    [
      ["(shell)", "modify", true, null],
      ["tmp/backend.log", "modify", true, { shell: "write-redirection" }],
      ["(shell)", "modify", true, null],
      [".squad/log.md", "modify", true, { shell: "write-redirection" }],
    ],
  );
  assert.ok(fcs.every((f) => f.source_tool_name === "bash" && !f.before_blob_ref && !f.after_blob_ref));
  assert.equal((fcs[1]!.source_tool_input as { command: string }).command.includes("npm start"), true);
});

test("REAL-SHAPE file changes: an edit whose old_str does not fit the known image, or whose derived counts disagree with the CLI's hunks, degrades to an honest partial row", async () => {
  const store = freshStore();
  const MAIN = "iid-main";
  const P = "/repo/x.txt";
  const { events, lin } = realSession();
  lin("session.start", { sessionId: "s-degrade" });
  lin("user.message", { content: "go", interactionId: MAIN });
  lin("tool.execution_start", { toolName: "view", toolCallId: "toolu_v", arguments: { path: P } });
  lin("tool.execution_complete", {
    toolCallId: "toolu_v",
    interactionId: MAIN,
    success: true,
    result: { content: numbered("a\nb\nc\n") },
  });
  // old_str not in the image (something changed the file under us)
  lin("tool.execution_start", {
    toolName: "edit",
    toolCallId: "toolu_e1",
    arguments: { path: P, old_str: "zzz\n", new_str: "yyy\n" },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_e1",
    interactionId: MAIN,
    success: true,
    result: { content: "updated", detailedContent: gitDiff(P, "@@ -1,1 +1,1 @@\n-zzz\n+yyy\n") },
  });
  // Fresh view, then an edit that fits — but the CLI's hunks say more
  // changed than our derivation (stale image) → partial, hunk counts win.
  lin("tool.execution_start", { toolName: "view", toolCallId: "toolu_v2", arguments: { path: P } });
  lin("tool.execution_complete", {
    toolCallId: "toolu_v2",
    interactionId: MAIN,
    success: true,
    result: { content: numbered("a\nb\nc\n") },
  });
  lin("tool.execution_start", {
    toolName: "edit",
    toolCallId: "toolu_e2",
    arguments: { path: P, old_str: "b\n", new_str: "B\n" },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_e2",
    interactionId: MAIN,
    success: true,
    result: { content: "updated", detailedContent: gitDiff(P, "@@ -1,3 +1,4 @@\n a\n-b\n+B\n+extra\n c\n") },
  });
  // A ranged view is NOT a whole-file image: the next edit has no image.
  lin("tool.execution_start", {
    toolName: "view",
    toolCallId: "toolu_v3",
    arguments: { path: P, view_range: [1, 2] },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_v3",
    interactionId: MAIN,
    success: true,
    result: { content: numbered("a\nB") },
  });
  lin("tool.execution_start", {
    toolName: "edit",
    toolCallId: "toolu_e3",
    arguments: { path: P, old_str: "a\n", new_str: "A\n" },
  });
  lin("tool.execution_complete", {
    toolCallId: "toolu_e3",
    interactionId: MAIN,
    success: true,
    result: { content: "updated" },
  });
  lin("session.shutdown", { shutdownType: "routine" });
  const path = writeSession(events, { workspaceYaml: "cwd: /repo\n" });
  const r = await ingestCopilotSession(store, path);
  const fcs = listFileChanges(store, { runId: r.run_id }).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  assert.equal(fcs.length, 3);
  assert.deepEqual(
    fcs.map((f) => [f.partial_diff, f.lines_added, f.lines_removed, f.normalizer_notes]),
    [
      [true, 1, 1, { before_source: "none", before_miss: "old_str-not-found", before_rejected: "view_result" }],
      [true, 2, 1, { before_source: "none", before_miss: "hunk-mismatch", before_rejected: "view_result", hunk_check: "mismatch" }],
      [true, 1, 1, { before_source: "none", before_miss: "no-prior-image" }],
    ],
  );
  assert.ok(fcs.every((f) => !f.before_blob_ref && !f.after_blob_ref));
  assert.ok(fcs[1]!.patch_text!.includes("+extra"), "CLI diff kept as patch_text on degrade");
  assert.ok(fcs[2]!.patch_text!.includes("+A"), "input-derived patch when the CLI shipped none");
});

test("shape probe: quiet on real tool/shutdown payloads and skill.invoked; warns on malformed shellToolInfo, detailedContent, codeChanges", async () => {
  const quiet = [
    ev("session.start", { sessionId: "s-p" }),
    ev("skill.invoked", { name: "squad", path: "/repo/.copilot/skills/squad.md", source: "project", trigger: "user" }),
    ev("tool.execution_start", {
      toolName: "bash",
      toolCallId: "c1",
      arguments: { command: "ls" },
      shellToolInfo: { possiblePaths: [], hasWriteFileRedirection: false },
    }),
    ev("tool.execution_complete", {
      toolCallId: "c1",
      success: true,
      result: { content: "a\nb", detailedContent: "a\nb" },
    }),
    ev("tool.execution_complete", {
      toolCallId: "c2",
      success: false,
      error: { message: "No match found", code: "failure" },
    }),
    ev("session.shutdown", {
      codeChanges: { linesAdded: 1, linesRemoved: 0, filesModified: ["/repo/a"] },
    }),
  ];
  (quiet[1] as { agentId?: string }).agentId = "call_abc";
  assert.deepEqual(probeEvents(quiet as never), []);

  const drift = [
    ev("tool.execution_start", {
      toolName: "bash",
      toolCallId: "d1",
      arguments: { command: "ls" },
      shellToolInfo: { possiblePaths: "/repo", hasWriteFileRedirection: "yes" },
    }),
    ev("tool.execution_complete", { toolCallId: "d1", success: "true", result: { detailedContent: 42 } }),
    ev("session.shutdown", { codeChanges: { linesAdded: "1" } }),
  ];
  const notes = probeEvents(drift as never).map((w) => w.note).sort();
  assert.deepEqual(notes, [
    "codeChanges is not {linesAdded, linesRemoved, filesModified[]}",
    "result.detailedContent is not a string",
    "shellToolInfo is not {possiblePaths[], hasWriteFileRedirection}",
    "success is not a boolean",
  ]);
});
