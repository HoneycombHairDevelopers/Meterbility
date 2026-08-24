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
    timestamp: extra.timestamp ?? `2026-08-20T10:00:${String(evCounter % 60).padStart(2, "0")}.000Z`,
    parentId: extra.parentId ?? null,
    data,
  };
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

  // File change: partial_diff row with patch text, on the child.
  const fcs = listFileChanges(store, eecom.run_id);
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.op, "modify");
  assert.equal(fcs[0]!.partial_diff, true);
  assert.equal(fcs[0]!.path, "repo/src/auth.ts");
  assert.ok(fcs[0]!.patch_text?.includes("+return session"));
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
  const runs = listRuns(store, {});
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

test("status inference: user-last is in_progress, session.error-last is error", async () => {
  const store = freshStore();
  const inProgress = writeSession([
    ev("session.start", { sessionId: "s-ip" }, { id: "p1" }),
    ev("user.message", { content: "still typing?" }, { id: "p2", parentId: "p1" }),
  ]);
  const r1 = await ingestCopilotSession(store, inProgress);
  assert.equal(getRun(store, r1.run_id)!.status, "in_progress");

  const errored = writeSession([
    ev("session.start", { sessionId: "s-err" }, { id: "q1" }),
    ev("user.message", { content: "go" }, { id: "q2", parentId: "q1" }),
    ev("session.error", { message: "boom" }, { id: "q3", parentId: "q2" }),
  ]);
  const r2 = await ingestCopilotSession(store, errored);
  assert.equal(getRun(store, r2.run_id)!.status, "error");
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
