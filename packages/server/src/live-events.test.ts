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
  // Copilot live-poll isolation (v8 adapter): without this, real
  // ~/.copilot sessions on the dev machine get ingested every tick
  // and starve the assertions (machine-state-dependent failure).
  process.env.COPILOT_HOME = codex;
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

// ---------------------------------------------------------------------------
// v0.6.x front-door coexistence: two LiveInspectors (the `meter live`
// terminal process and the web server) share one store. The ingest
// offset (`ingest_progress`) is single-consumer, so whichever inspector
// ingests a session's growth first drains it — the loser's own ingest
// returns "empty". detectStepArrivals must surface those steps from the
// store anyway, or the web run page never sees run:updated.
// ---------------------------------------------------------------------------

/** Assistant record whose action is a tool_use — keeps the run
 *  in_progress (awaiting the tool result), which is exactly the state
 *  a live session sits in while the operator watches it. */
function toolUseRecord(uuid: string, parentUuid: string, sessionId: string, n: number): object {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId,
    timestamp: `2026-05-12T00:00:0${n}.000Z`,
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [
        { type: "tool_use", id: `tu${n}`, name: "Bash", input: { command: `echo ${n}` } },
      ],
      usage: { input_tokens: 10 + n, output_tokens: 2 },
    },
  };
}

test("shared-store race: losing inspector still emits run:updated via the store-delta detector", async () => {
  const { claude } = freshHome();

  // Two handles on the same store file — one per simulated process.
  const storeCli = Store.open();
  const storeWeb = Store.open();
  const cli = new LiveInspector(storeCli, { scanIntervalMs: 999_999 });
  const web = new LiveInspector(storeWeb, { scanIntervalMs: 999_999 });
  await cli.start(); // silent backfill, nothing on disk
  await web.start();

  const cliEvents: LiveEvent[] = [];
  const webEvents: LiveEvent[] = [];
  cli.on("data", (e: LiveEvent) => cliEvents.push(e));
  web.on("data", (e: LiveEvent) => webEvents.push(e));

  const u1 = {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId: "sess-race",
    timestamp: "2026-05-12T00:00:00.000Z",
    cwd: "/tmp/race",
    message: { role: "user", content: "go" },
  };
  const path = writeFakeSession(claude, "race-proj", "sess-race", [
    u1,
    toolUseRecord("a1", "u1", "sess-race", 1),
  ]);

  // CLI ticks first → wins the ingest, advances the shared offset.
  await cli.tick();
  assert.equal(
    cliEvents.filter((e) => e.type === "run:created").length,
    1,
    "winner announces the new run from its own ingest",
  );

  // Web ticks second → its own ingest returns "empty" (offset already
  // at EOF), but the store-delta detector must still announce the run.
  await web.tick();
  assert.equal(
    webEvents.filter((e) => e.type === "run:created").length,
    1,
    "loser announces the run via detectStepArrivals despite an empty ingest",
  );

  // Grow the session; CLI wins again.
  appendFileSync(path, JSON.stringify(toolUseRecord("a2", "a1", "sess-race", 2)) + "\n");
  cliEvents.length = 0;
  webEvents.length = 0;
  await cli.tick();
  const cliUpdated = cliEvents.filter((e) => e.type === "run:updated");
  assert.equal(
    cliUpdated.length,
    1,
    "winner's own-ingest emit is not duplicated by its own delta detector",
  );

  await web.tick();
  const webUpdated = webEvents.filter((e) => e.type === "run:updated") as Array<
    Extract<LiveEvent, { type: "run:updated" }>
  >;
  assert.equal(
    webUpdated.length,
    1,
    "loser emits run:updated for steps another process ingested",
  );
  assert.deepEqual(
    webUpdated[0]!.new_steps.map((s) => s.sequence),
    [1],
    "the delta carries the exact new sequence",
  );

  // Idle ticks on both sides → no re-emission of the same steps.
  cliEvents.length = 0;
  webEvents.length = 0;
  await cli.tick();
  await web.tick();
  assert.equal(
    cliEvents.filter((e) => e.type === "run:updated" || e.type === "run:created").length,
    0,
    "winner stays silent on idle ticks",
  );
  assert.equal(
    webEvents.filter((e) => e.type === "run:updated" || e.type === "run:created").length,
    0,
    "loser does not re-emit already-announced steps",
  );

  cli.stop();
  web.stop();
  storeCli.close();
  storeWeb.close();
});

test("shared-store race: synthetic band steps don't skew the delta detector", async () => {
  const { claude } = freshHome();
  const storeCli = Store.open();
  const storeWeb = Store.open();
  const cli = new LiveInspector(storeCli, { scanIntervalMs: 999_999 });
  const web = new LiveInspector(storeWeb, { scanIntervalMs: 999_999 });
  await cli.start();
  await web.start();

  const u1 = {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId: "sess-race-band",
    timestamp: "2026-05-12T00:00:00.000Z",
    cwd: "/tmp/race-band",
    message: { role: "user", content: "go" },
  };
  const path = writeFakeSession(claude, "race-band-proj", "sess-race-band", [
    u1,
    toolUseRecord("a1", "u1", "sess-race-band", 1),
  ]);
  await cli.tick(); // seq 0 ingested by the winner
  await web.tick(); // loser catches up (run:created)

  // A synthetic capture-plane step lands out of band at the reserved
  // band (hook drains do exactly this) — it must never register as
  // main-band progress or ride a run:updated delta.
  const { getRunBySessionId, insertStep } = await import("@meterbility/collector");
  const run = getRunBySessionId(storeCli, "sess-race-band")!;
  insertStep(storeCli, {
    step_id: "stp_band_race",
    run_id: run.run_id,
    sequence: 100_000,
    timestamp: "2026-05-12T01:00:00.000Z",
    model: "claude-opus-4-7",
    context_snapshot_id: "ctx",
    decision_ref: "dec",
    action: { kind: "tool_call", tool_name: "afterFileEdit", tool_input: {} },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: ["cursor-hook"],
    status: "ok",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const webEvents: LiveEvent[] = [];
  web.on("data", (e: LiveEvent) => webEvents.push(e));
  await web.tick();
  assert.equal(
    webEvents.filter((e) => e.type === "run:updated").length,
    0,
    "a band-only arrival is not main-band progress",
  );

  // Real growth after the band step: the delta must be exactly the new
  // main-band sequence — not the band step, and not a count-derived
  // sequence inflated past the walk range.
  appendFileSync(
    path,
    JSON.stringify(toolUseRecord("a2", "a1", "sess-race-band", 2)) + "\n",
  );
  await cli.tick(); // winner drains the offset
  webEvents.length = 0;
  await web.tick();
  const updated = webEvents.filter((e) => e.type === "run:updated") as Array<
    Extract<LiveEvent, { type: "run:updated" }>
  >;
  assert.equal(updated.length, 1, "loser emits the out-of-band main-band step");
  assert.deepEqual(
    updated[0]!.new_steps.map((s) => s.sequence),
    [1],
    "delta carries exact main-band sequences only — the 100000 band step never rides",
  );

  cli.stop();
  web.stop();
  storeCli.close();
  storeWeb.close();
});

test("rewound transcript resets the append cursor; later steps still emit run:updated", async () => {
  // Regression (G5): lastMaxSeq never rewound. After adapter
  // reconciliation of a rewritten-shorter source trimmed a run's tail,
  // the cached floor stayed at the old max — every step appended after
  // the rewind sat below it and run:updated went silently dead.
  const { claude } = freshHome();
  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start(); // silent backfill, nothing on disk

  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  const u1 = {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId: "sess-rewind",
    timestamp: "2026-05-12T00:00:00.000Z",
    cwd: "/tmp/rewind",
    message: { role: "user", content: "hi" },
  };
  const a1 = {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    sessionId: "sess-rewind",
    timestamp: "2026-05-12T00:00:01.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "step one" }],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  };
  const a2 = {
    type: "assistant",
    uuid: "a2",
    parentUuid: "a1",
    sessionId: "sess-rewind",
    timestamp: "2026-05-12T00:00:02.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "step two" }],
      usage: { input_tokens: 11, output_tokens: 3 },
    },
  };
  const path = writeFakeSession(claude, "rewind-proj", "sess-rewind", [u1, a1, a2]);
  await live.tick(); // run:created; append cursor floor = 1

  const { getRunBySessionId, deleteStepsFromSequence, listSteps } = await import(
    "@meterbility/collector"
  );
  const run = getRunBySessionId(store, "sess-rewind")!;
  assert.equal(listSteps(store, run.run_id).length, 2, "precondition: two steps");

  // REWOUND source: the transcript is rewritten shorter (fewer records,
  // same session id) and reconciliation trims the stale tail step (the
  // Cursor adapter does exactly this; the CC adapter absorbs rewinds
  // via its sequence upsert). Filler user records keep the rewritten
  // file LARGER than the original — the tail poll is size-growth-gated
  // — and give the stale ingest offset a parseable record to land on.
  deleteStepsFromSequence(store, run.run_id, 1);
  const filler = {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    sessionId: "sess-rewind",
    timestamp: "2026-05-12T00:00:03.000Z",
    cwd: "/tmp/rewind",
    message: { role: "user", content: "pad ".repeat(1000) },
  };
  const tailMarker = {
    type: "user",
    uuid: "u3",
    parentUuid: "u2",
    sessionId: "sess-rewind",
    timestamp: "2026-05-12T00:00:04.000Z",
    cwd: "/tmp/rewind",
    message: { role: "user", content: "resume" },
  };
  writeFakeSession(claude, "rewind-proj", "sess-rewind", [u1, a1, filler, tailMarker]);
  events.length = 0;
  await live.tick(); // rewind observed → cursor resets; no assertions here

  // A step appended AFTER the rewind must still reach subscribers.
  appendFileSync(
    path,
    JSON.stringify({
      type: "assistant",
      uuid: "a3",
      parentUuid: "u3",
      sessionId: "sess-rewind",
      timestamp: "2026-05-12T00:00:05.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "fresh step after rewind" }],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    }) + "\n",
  );
  events.length = 0;
  await live.tick();
  const updated = events.filter((e) => e.type === "run:updated");
  assert.equal(updated.length, 1, "run:updated fires for the post-rewind step");
  assert.ok(
    updated[0]!.type === "run:updated" && updated[0]!.new_steps.length >= 1,
    "the fresh step rides the event",
  );
  live.stop();
  store.close();
});
