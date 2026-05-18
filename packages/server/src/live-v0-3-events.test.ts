import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@spool/collector";
import {
  clearProbe,
  confirmPaused,
  requestPause,
  requestResume,
  setInject,
} from "@spool/shared";
import { LiveInspector, type LiveEvent } from "./live.ts";

/**
 * v0.3 §4.9 + §8.5 — new SSE event types on /api/live:
 *   - `files:changed`  (file capture)
 *   - `run:paused`     (Live Probe pause acked)
 *   - `run:resumed`    (Live Probe resume)
 *
 * These are observed by the inspector tick. Pause/resume by polling the
 * probe file (works for both web POST and CLI `spool probe`); files:changed
 * by walking new_steps and looking up file_change rows after ingest.
 */

function freshHomes(): { spool: string; claude: string } {
  const spool = mkdtempSync(join(tmpdir(), "spool-v03-events-"));
  const claude = mkdtempSync(join(tmpdir(), "claude-v03-events-"));
  process.env.SPOOL_HOME = spool;
  process.env.CLAUDE_HOME = claude;
  return { spool, claude };
}

function writeRepo(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "spool-v03-repo-"));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function writeFakeSession(
  claudeHome: string,
  projectName: string,
  sessionId: string,
  records: object[],
): string {
  const dir = join(claudeHome, "projects", projectName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function writeBackup(
  claudeHome: string,
  sessionId: string,
  fileName: string,
  contents: string,
): void {
  const dir = join(claudeHome, "file-history", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), contents);
}

function plainSession(sessionId: string, cwd: string): object[] {
  return [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId,
      timestamp: "2026-05-15T00:00:00.000Z",
      cwd,
      message: { role: "user", content: "hi" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId,
      timestamp: "2026-05-15T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
}

test("files:changed fires for a freshly ingested step that produced file_change rows", async () => {
  const { claude } = freshHomes();
  const repoCwd = writeRepo({
    "src/greet.ts": "function greet() { return 'hi'; }\n",
  });
  // Backup the pre-edit bytes where the adapter expects them.
  writeBackup(
    claude,
    "sess-fc-1",
    "bak-greet",
    "function greet() { return 'hi'; }\n",
  );

  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start(); // silent backfill — nothing on disk yet

  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  // Post-boot: write a session that does an Edit. file-history-snapshot
  // points at the backup we just wrote.
  writeFakeSession(claude, "fc-proj", "sess-fc-1", [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "sess-fc-1",
      timestamp: "2026-05-15T00:00:00.000Z",
      cwd: repoCwd,
      message: { role: "user", content: "rename greet" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-fc-1",
      timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        [join(repoCwd, "src/greet.ts")]: { backupFileName: "bak-greet" },
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "sess-fc-1",
      timestamp: "2026-05-15T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: "tu_e",
            name: "Edit",
            input: {
              file_path: join(repoCwd, "src/greet.ts"),
              old_string: "greet",
              new_string: "hello",
            },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ]);
  await live.tick();

  const filesChanged = events.filter((e) => e.type === "files:changed");
  assert.equal(
    filesChanged.length,
    1,
    "exactly one files:changed event for the modifying step",
  );
  const ev = filesChanged[0] as Extract<LiveEvent, { type: "files:changed" }>;
  assert.ok(ev.run_id, "run_id is populated");
  assert.ok(ev.step_id, "step_id is populated");
  assert.deepEqual(ev.paths, ["src/greet.ts"], "paths are repo-relative + deduped");
  assert.equal(ev.partial, false, "Edit is full-fidelity, not partial");

  live.stop();
  store.close();
});

test("files:changed is not emitted for steps with no file_change rows", async () => {
  const { claude } = freshHomes();
  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start();

  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  writeFakeSession(
    claude,
    "plain-proj",
    "sess-plain",
    plainSession("sess-plain", "/tmp/plain"),
  );
  await live.tick();

  const filesChanged = events.filter((e) => e.type === "files:changed");
  assert.equal(filesChanged.length, 0, "plain text-only step → no files:changed");
  live.stop();
  store.close();
});

test("run:paused fires once when probe file appears with paused_at_ms set", async () => {
  const { claude } = freshHomes();
  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start();

  writeFakeSession(
    claude,
    "probe-proj",
    "sess-probe-1",
    plainSession("sess-probe-1", "/tmp/probe1"),
  );
  await live.tick(); // ingests the run; no probe file yet so polling skips
  const runId = live.fleetEntries()[0]?.run.run_id;
  assert.ok(runId, "ingested run has an id");

  // Verify polling stays silent while there's no probe file — runs that
  // never get probed must not generate probe-related events.
  const baselineEvents: LiveEvent[] = [];
  const baselineHandler = (e: LiveEvent) => baselineEvents.push(e);
  live.on("data", baselineHandler);
  await live.tick();
  live.off("data", baselineHandler);
  assert.equal(
    baselineEvents.filter(
      (e) => e.type === "run:paused" || e.type === "run:resumed",
    ).length,
    0,
    "ticks for un-probed runs are silent (no spurious events)",
  );

  // Operator pauses, SDK acks. The probe file now exists with
  // paused_at_ms populated.
  requestPause(runId!);
  confirmPaused(runId!);

  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));
  await live.tick();

  const paused = events.filter((e) => e.type === "run:paused");
  assert.equal(paused.length, 1, "exactly one run:paused on the transition");
  const ev = paused[0] as Extract<LiveEvent, { type: "run:paused" }>;
  assert.equal(ev.run_id, runId);
  assert.ok(ev.paused_at, "paused_at is populated");

  // Idle paused tick — paused_at_ms hasn't advanced, no re-emit.
  events.length = 0;
  await live.tick();
  assert.equal(
    events.filter((e) => e.type === "run:paused").length,
    0,
    "idle paused tick does not re-fire run:paused",
  );

  clearProbe(runId!);
  live.stop();
  store.close();
});

test("run:paused and run:resumed both fire when a full pause/resume cycle completes between ticks", async () => {
  // The pre-fix bug: state-edge detection compared prev.state vs
  // next.state, so a `running → pause_requested → paused → running`
  // cycle that completed inside one 1500ms tick interval looked like
  // `running → running` to the inspector and emitted nothing.
  // Post-fix: detection is timestamp-based — paused_at_ms /
  // resumed_at_ms advance regardless of the snapshot state.
  const { claude } = freshHomes();
  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start();

  writeFakeSession(
    claude,
    "fast-proj",
    "sess-fast",
    plainSession("sess-fast", "/tmp/fast"),
  );
  await live.tick();
  const runId = live.fleetEntries()[0]!.run.run_id;

  // Whole cycle compressed between two ticks — what the operator
  // workflow looks like when they pause + paste an inject + hit resume
  // faster than the poll interval.
  requestPause(runId);
  confirmPaused(runId);
  requestResume(runId);

  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));
  await live.tick();

  const paused = events.filter((e) => e.type === "run:paused");
  const resumed = events.filter((e) => e.type === "run:resumed");
  assert.equal(paused.length, 1, "fast cycle still fires run:paused");
  assert.equal(resumed.length, 1, "fast cycle still fires run:resumed");

  clearProbe(runId);
  live.stop();
  store.close();
});

test("a corrupt probe file for one run does not poison polling for other runs", async () => {
  // Pre-fix: an unguarded readProbeState call threw on any non-ENOENT
  // error, aborting the whole probe-poll loop and skipping the fleet
  // snapshot. Post-fix: per-run try/catch isolates the failure.
  const { claude, spool } = freshHomes();
  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start();

  writeFakeSession(
    claude,
    "ok-proj",
    "sess-ok",
    plainSession("sess-ok", "/tmp/ok"),
  );
  writeFakeSession(
    claude,
    "bad-proj",
    "sess-bad",
    plainSession("sess-bad", "/tmp/bad"),
  );
  await live.tick();
  const entries = live.fleetEntries();
  const okRunId = entries.find((e) => e.run.cwd === "/tmp/ok")!.run.run_id;
  const badRunId = entries.find((e) => e.run.cwd === "/tmp/bad")!.run.run_id;

  // Set up: one healthy paused probe, one probe file that readState
  // can't recover (corrupt JSON is auto-recovered to default by the
  // probe layer, so simulate the throw-able case by writing a non-
  // readable file mode).
  requestPause(okRunId);
  confirmPaused(okRunId);

  // Place a probe file for the bad run and chmod it 0 so readFileSync
  // throws EACCES — the one re-thrown error path in readState.
  const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join: pjoin } = await import("node:path");
  mkdirSync(pjoin(spool, "probe"), { recursive: true });
  const badProbePath = pjoin(
    spool,
    "probe",
    `${encodeURIComponent(badRunId)}.json`,
  );
  writeFileSync(badProbePath, "{}");
  chmodSync(badProbePath, 0o000);

  let threw = false;
  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));
  // Silence the per-run error log so the test output stays clean.
  const origErr = console.error;
  console.error = () => {};
  try {
    await live.tick();
  } catch {
    threw = true;
  } finally {
    console.error = origErr;
    // Restore so cleanup can remove the file.
    chmodSync(badProbePath, 0o600);
  }

  assert.equal(threw, false, "tick does not throw when one probe file is unreadable");
  // The healthy run still got its run:paused event despite the bad
  // sibling — this is the whole point of per-run guarding.
  assert.equal(
    events.filter((e) => e.type === "run:paused").length,
    1,
    "healthy run still emits run:paused when a sibling's probe file is broken",
  );

  clearProbe(okRunId);
  clearProbe(badRunId);
  live.stop();
  store.close();
});

test("run:resumed reports the count of distinct injects observed during the paused window", async () => {
  const { claude } = freshHomes();
  const store = Store.open();
  const live = new LiveInspector(store, { scanIntervalMs: 999_999 });
  await live.start();

  writeFakeSession(
    claude,
    "probe-proj-2",
    "sess-probe-2",
    plainSession("sess-probe-2", "/tmp/probe2"),
  );
  await live.tick(); // ingests run; no probe file yet so polling skips
  const runId = live.fleetEntries()[0]!.run.run_id;

  const events: LiveEvent[] = [];
  live.on("data", (e: LiveEvent) => events.push(e));

  // Pause cycle. Operator queues one inject, the SDK acks, then a
  // second distinct inject lands. Both should tally toward the
  // resume's `edits` count — they arrived in distinct polling
  // windows with different values.
  requestPause(runId);
  confirmPaused(runId);
  setInject(runId, "first-edit");
  await live.tick(); // first sighting: plants track + emits paused, edits = 1
  setInject(runId, "second-edit");
  await live.tick(); // second distinct inject → edits = 2
  requestResume(runId);
  await live.tick(); // resumed_at_ms advances → emits run:resumed

  const resumed = events.filter((e) => e.type === "run:resumed");
  assert.equal(resumed.length, 1, "exactly one run:resumed on resume");
  const ev = resumed[0] as Extract<LiveEvent, { type: "run:resumed" }>;
  assert.equal(ev.run_id, runId);
  assert.equal(ev.edits, 2, "two distinct injects observed during the pause");
  assert.ok(ev.resumed_at, "resumed_at is populated");

  clearProbe(runId);
  live.stop();
  store.close();
});
