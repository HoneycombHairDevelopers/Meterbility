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

  // File change: partial_diff row with patch text, on the child. The
  // absolute tool-input path relativizes against the workspace cwd.
  const fcs = listFileChanges(store, { runId: eecom.run_id });
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.op, "modify");
  assert.equal(fcs[0]!.partial_diff, true);
  assert.equal(fcs[0]!.path, "src/auth.ts");
  assert.ok(fcs[0]!.patch_text?.includes("+return session"));
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
