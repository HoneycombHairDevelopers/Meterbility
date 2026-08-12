import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@meterbility/collector";
import { LiveInspector, type LiveEvent } from "./live.ts";

/**
 * Regressions for the boot-storm bugs the user hit:
 *  - first-tick fires run:created for every historical session
 *  - run:completed fires every tick on already-terminal runs
 *  - duplicate processing because new files are also "size grew from 0"
 *
 * We simulate Claude Code by writing fake JSONL session files into a
 * fresh CLAUDE_HOME and inspecting the events the inspector emits.
 */

function freshHome(): { meter: string; claude: string; codex: string } {
  const meter = mkdtempSync(join(tmpdir(), "meter-live-events-"));
  const claude = mkdtempSync(join(tmpdir(), "claude-fake-"));
  const codex = mkdtempSync(join(tmpdir(), "codex-fake-"));
  process.env.METERBILITY_HOME = meter;
  process.env.CLAUDE_HOME = claude;
  // Isolate Codex discovery too — without this, the inspector would
  // ingest the developer's real ~/.codex rollouts into the test store.
  process.env.CODEX_HOME = codex;
  return { meter, claude, codex };
}

function writeFakeCodexRollout(
  codexHome: string,
  sessionId: string,
  records: object[],
): string {
  const dir = join(codexHome, "sessions", "2026", "08", "04");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-04T10-00-00-${sessionId}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function writeFakeSession(claudeHome: string, projectName: string, sessionId: string, records: object[]): string {
  const dir = join(claudeHome, "projects", projectName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function basicSession(sessionId: string, cwd: string): object[] {
  return [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId,
      timestamp: "2026-05-12T00:00:00.000Z",
      cwd,
      message: { role: "user", content: "hi" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId,
      timestamp: "2026-05-12T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
}

test("startup is silent: historical sessions don't fire run:created or run:completed", async () => {
  const { claude } = freshHome();
  writeFakeSession(claude, "old-proj-1", "sess-old-1", basicSession("sess-old-1", "/tmp/old1"));
  writeFakeSession(claude, "old-proj-2", "sess-old-2", basicSession("sess-old-2", "/tmp/old2"));

  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  await live.start();
  live.stop();

  const created = events.filter((e) => e.type === "run:created");
  const completed = events.filter((e) => e.type === "run:completed");
  assert.equal(created.length, 0, "no run:created events on boot");
  assert.equal(completed.length, 0, "no run:completed events on boot");
  // We should still see one fleet snapshot so SSE clients can populate.
  const snapshots = events.filter((e) => e.type === "fleet:snapshot");
  assert.equal(snapshots.length, 1);
  store.close();
});

test("post-boot: new file triggers run:created exactly once, run:completed only on transition", async () => {
  const { claude } = freshHome();

  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start(); // silent backfill (nothing on disk)

  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  // Write a new file AFTER boot; should fire created + completed (terminal).
  writeFakeSession(claude, "new-proj", "sess-new", basicSession("sess-new", "/tmp/new"));
  await live.tick();

  const created = events.filter((e) => e.type === "run:created");
  const completed = events.filter((e) => e.type === "run:completed");
  assert.equal(created.length, 1);
  assert.equal(completed.length, 1);

  // Tick again with no file change → no new events.
  events.length = 0;
  await live.tick();
  const repeats = events.filter(
    (e) => e.type === "run:created" || e.type === "run:completed",
  );
  assert.equal(repeats.length, 0, "completed run does not re-fire run:completed on idle ticks");
  live.stop();
  store.close();
});

test("alerts fired during silent backfill are recorded but not emitted", async () => {
  const { claude } = freshHome();

  // Build a session that crosses the 50% context threshold.
  writeFakeSession(claude, "ctx-proj", "sess-ctx", [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "sess-ctx",
      timestamp: "2026-05-12T00:00:00.000Z",
      cwd: "/tmp/ctx",
      message: { role: "user", content: "do thing" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "sess-ctx",
      timestamp: "2026-05-12T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        // 110k input tokens > 50% of the 200k window
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 110_000, output_tokens: 5 },
      },
    },
  ]);

  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));
  await live.start();
  live.stop();

  const alerts = events.filter((e) => e.type === "alert");
  assert.equal(alerts.length, 0, "no alerts fired during silent backfill");
  store.close();
});

test("duplicate path processing fixed: a brand-new file is ingested once per tick", async () => {
  const { claude } = freshHome();

  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start();

  let ingestCount = 0;
  // Patch listRuns indirectly: count run:created events instead.
  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  writeFakeSession(claude, "dup-proj", "sess-dup", basicSession("sess-dup", "/tmp/dup"));
  await live.tick();

  ingestCount = events.filter((e) => e.type === "run:created").length;
  assert.equal(ingestCount, 1, "new file fires run:created exactly once, not twice");
  live.stop();
  store.close();
});

test("pre-existing run growing post-boot fires run:updated, not run:created", async () => {
  // Regression: the silent backfill `continue`d on ingest status
  // "empty" (offset already at EOF for sessions ingested before the
  // inspector started) without seeding lastStepCounts. The first
  // growth of any such run then emitted run:created — which the run
  // detail page ignores, so live step append never started.
  const { claude } = freshHome();
  const path = writeFakeSession(
    claude, "seed-proj", "sess-seed", basicSession("sess-seed", "/tmp/seed"),
  );

  const store = Store.open();
  // Ingest BEFORE the inspector exists — run row + EOF offset in store.
  const { ingestSession } = await import("@meterbility/claude-code-adapter");
  const pre = await ingestSession(store, path);
  assert.equal(pre.status, "ok", "precondition: session ingested before boot");

  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start(); // backfill sees "empty" for this path
  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  // Grow the session with a fresh assistant turn → one new step.
  const grown = [
    ...basicSession("sess-seed", "/tmp/seed"),
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "a1",
      sessionId: "sess-seed",
      timestamp: "2026-05-12T00:00:05.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "more" }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    },
  ];
  writeFakeSession(claude, "seed-proj", "sess-seed", grown);
  await live.tick();

  const created = events.filter((e) => e.type === "run:created");
  const updated = events.filter((e) => e.type === "run:updated");
  assert.equal(created.length, 0, "known run must not re-fire run:created");
  assert.equal(updated.length, 1, "growth fires run:updated");
  assert.ok(
    updated[0]!.type === "run:updated" && updated[0]!.new_steps.length >= 1,
    "run:updated carries the newly ingested steps",
  );
  live.stop();
  store.close();
});

test("fleet entries carry descriptive alert messages, not dedup keys", async () => {
  // Regression: buildFleetEntries used to render the internal dedup key
  // ("tool:Bash:stp_x", "ctx:80") as both kind and message, so fleet
  // cards showed raw keys and the stall styling (kind === "stall")
  // never matched.
  const { claude } = freshHome();

  const store = Store.open();
  const live = new LiveInspector(store, {
    scanIntervalMs: 999_999,
    watchTools: ["Bash"],
  });
  await live.start();

  writeFakeSession(claude, "alert-proj", "sess-alert", [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "sess-alert",
      timestamp: "2026-05-12T00:00:00.000Z",
      cwd: "/tmp/alerts",
      message: { role: "user", content: "clean up" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "sess-alert",
      timestamp: "2026-05-12T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "Bash",
            input: { command: "rm -rf node_modules" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ]);
  await live.tick();

  const entry = live.fleetEntries().find((e) => e.run.title === "clean up");
  assert.ok(entry, "fleet entry exists for the session");
  const alert = entry!.alerts.find((a) => a.kind === "tool_called");
  assert.ok(alert, "tool_called alert present with a real kind, not a key");
  assert.match(alert!.message, /watched tool Bash called at step #/);
  assert.match(alert!.message, /rm -rf node_modules/, "message includes the command");
  live.stop();
  store.close();
});

// ---------------------------------------------------------------------------
// Cross-vendor live discovery (2026-08-04): Codex rollouts are tail-polled
// exactly like Claude Code transcripts.
// ---------------------------------------------------------------------------

function codexRecords(sessionId: string): object[] {
  return [
    {
      type: "session_meta",
      timestamp: "2026-08-04T10:00:00Z",
      payload: { id: sessionId, timestamp: "2026-08-04T10:00:00Z", cwd: "/tmp/codex-proj" },
    },
    {
      type: "turn_context",
      timestamp: "2026-08-04T10:00:01Z",
      payload: { model: "gpt-5.5" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T10:00:02Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "do the thing" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T10:00:03Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "working on it" }],
      },
    },
  ];
}

test("codex rollout appearing post-boot fires run:created; append fires run:updated", async () => {
  const { codex } = freshHome();
  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start(); // silent backfill, nothing on disk

  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  const path = writeFakeCodexRollout(codex, "0199-codex-live", codexRecords("codex-live-1"));
  await live.tick();

  const created = events.filter((e) => e.type === "run:created");
  assert.equal(created.length, 1, "codex run:created fired once");
  const createdRun = (created[0] as Extract<LiveEvent, { type: "run:created" }>).run;
  assert.equal(createdRun.source_runtime, "codex-cli");

  // Append another assistant turn → run:updated with new steps.
  events.length = 0;
  appendFileSync(
    path,
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-04T10:00:10Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    }) + "\n",
  );
  await live.tick();
  const updated = events.filter((e) => e.type === "run:updated");
  assert.equal(updated.length, 1, "append triggers run:updated");

  // Idle tick → silence.
  events.length = 0;
  await live.tick();
  assert.equal(
    events.filter((e) => e.type === "run:created" || e.type === "run:updated").length,
    0,
  );
  live.stop();
  store.close();
});

test("nonexistent CODEX_HOME: Claude run:created still fires, no throw", async () => {
  const { claude } = freshHome();
  // Point Codex discovery at a directory that does not exist — the
  // inspector must skip Codex silently and keep the Claude plane alive.
  process.env.CODEX_HOME = join(tmpdir(), `codex-definitely-missing-${Date.now()}`);
  try {
    const store = Store.open();
    const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
    await live.start(); // silent backfill

    const events: LiveEvent[] = [];
    live.on("data", (e: LiveEvent) => events.push(e));

    writeFakeSession(
      claude,
      "codexless-proj",
      "sess-codexless",
      basicSession("sess-codexless", "/tmp/codexless"),
    );
    await live.tick();

    const created = events.filter((e) => e.type === "run:created");
    assert.equal(created.length, 1, "Claude discovery unaffected by missing CODEX_HOME");
    live.stop();
    store.close();
  } finally {
    delete process.env.CODEX_HOME;
  }
});

test("fleet entries ignore synthetic band steps when deriving last activity", async () => {
  freshHome();
  const { upsertProjectByCwd, upsertAgent, insertRun, insertStep } = await import(
    "@meterbility/collector"
  );
  const { buildFleetEntries } = await import("./live.ts");
  const store = Store.open();
  const project = upsertProjectByCwd(store, "/tmp/band-proj", "cursor");
  const agent = upsertAgent(store, project.project_id, "cursor");
  insertRun(store, {
    run_id: "run_band",
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_session_id: "comp-band",
    source_runtime: "cursor",
    status: "in_progress",
    started_at: "2026-08-04T10:00:00.000Z",
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: ["cursor"],
  });
  const mkStep = (partial: Record<string, unknown>) =>
    ({
      run_id: "run_band",
      timestamp: "2026-08-04T10:00:01.000Z",
      model: "cursor",
      context_snapshot_id: "ctx",
      decision_ref: "dec",
      action: { kind: "message", text: "hi" },
      outcome: { status: "ok" },
      tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
      latency_ms: 0,
      cost_cents: 0,
      tags: [],
      status: "ok",
      ...partial,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  // Transcript step (walk range) at T1...
  insertStep(
    store,
    mkStep({ step_id: "stp_walk", sequence: 0, timestamp: "2026-08-04T10:00:01.000Z" }),
  );
  // ...and a synthetic hook step at 100k with a MUCH later timestamp and
  // a tool_call action that must not leak into recent_tools.
  insertStep(
    store,
    mkStep({
      step_id: "stp_hook",
      sequence: 100_000,
      timestamp: "2026-08-04T11:30:00.000Z",
      action: { kind: "tool_call", tool_name: "afterFileEdit", tool_input: {} },
      tags: ["cursor-hook"],
    }),
  );

  const entries = buildFleetEntries(store, { limit: 10 });
  const entry = entries.find((e) => e.run.run_id === "run_band")!;
  assert.equal(
    entry.last_step_at,
    "2026-08-04T10:00:01.000Z",
    "last activity derives from the transcript step, not the 100k band step",
  );
  assert.ok(
    !entry.recent_tools.includes("afterFileEdit"),
    "synthetic hook tool not in recent_tools",
  );
  store.close();
});
