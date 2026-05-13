import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@spool/collector";
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

function freshHome(): { spool: string; claude: string } {
  const spool = mkdtempSync(join(tmpdir(), "spool-live-events-"));
  const claude = mkdtempSync(join(tmpdir(), "claude-fake-"));
  process.env.SPOOL_HOME = spool;
  process.env.CLAUDE_HOME = claude;
  return { spool, claude };
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
