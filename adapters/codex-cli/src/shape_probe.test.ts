import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CodexShapeProbe,
  formatCodexWarning,
  probeCodexRecords,
  resetCodexDriftLog,
} from "./shape_probe.ts";

const known = [
  { type: "session_meta", payload: { id: "s", timestamp: "t" } },
  { type: "turn_context", payload: { model: "gpt-5.5" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [] } },
  { type: "response_item", payload: { type: "reasoning", summary: [] } },
  { type: "response_item", payload: { type: "web_search_call", status: "completed" } },
  { type: "event_msg", payload: { type: "token_count", info: null } },
  { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
  { type: "event_msg", payload: { type: "thread_settings_applied" } },
  {
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "AgentMessage", id: "i1" } },
  },
  {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "FileChange", id: "call_1", changes: {}, status: "completed" },
    },
  },
  { type: "event_msg", payload: { type: "patch_apply_end", call_id: "c", changes: {} } },
];

test("known record, payload, event and item kinds produce no warnings", () => {
  assert.deepEqual(probeCodexRecords(known), []);
});

test("unknown event_msg payload type is counted once per type", () => {
  const w = probeCodexRecords([
    { type: "event_msg", payload: { type: "turn_diff", unified_diff: "x" } },
    { type: "event_msg", payload: { type: "turn_diff", unified_diff: "y" } },
    { type: "event_msg", payload: { type: "turn_diff", unified_diff: "z" } },
  ]);
  assert.equal(w.length, 1);
  assert.equal(w[0]!.kind, "event_msg");
  assert.equal(w[0]!.typeName, "turn_diff");
  assert.equal(w[0]!.count, 3);
  assert.deepEqual(w[0]!.exampleKeys, ["type", "unified_diff"]);
});

test("unknown item_completed item type is counted once per type", () => {
  const w = probeCodexRecords([
    { type: "event_msg", payload: { type: "item_completed", item: { type: "TodoList", id: "a" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "TodoList", id: "b" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "ImageView", id: "c" } } },
    { type: "event_msg", payload: { type: "item_completed" } },
  ]);
  const byKey = Object.fromEntries(w.map((x) => [x.driftKey, x.count]));
  assert.deepEqual(byKey, {
    "item_completed:TodoList": 2,
    "item_completed:ImageView": 1,
    "item_completed:<missing>": 1,
  });
});

test("unknown record envelope and response_item types are flagged", () => {
  const w = probeCodexRecords([
    { type: "compacted", payload: {} },
    { type: "response_item", payload: { type: "local_shell_call", id: "x" } },
    null,
  ]);
  const keys = w.map((x) => x.driftKey).sort();
  assert.deepEqual(keys, [
    "record:<non-object>",
    "record:compacted",
    "response_item:local_shell_call",
  ]);
});

test("report logs each drift key once per process, then stays silent", () => {
  resetCodexDriftLog();
  const logged: string[] = [];
  const orig = console.warn;
  console.warn = (msg: unknown) => {
    logged.push(String(msg));
  };
  try {
    const probe = new CodexShapeProbe();
    probe.probe({ type: "event_msg", payload: { type: "turn_diff" } });
    probe.probe({ type: "event_msg", payload: { type: "turn_diff" } });
    probe.report("rollout-a.jsonl");
    probe.report("rollout-a.jsonl");
    const again = new CodexShapeProbe();
    again.probe({ type: "event_msg", payload: { type: "turn_diff" } });
    again.report("rollout-b.jsonl");
  } finally {
    console.warn = orig;
    resetCodexDriftLog();
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /codex shape drift in rollout-a\.jsonl/);
  assert.match(logged[0]!, /unknown event_msg type=turn_diff/);
  assert.match(logged[0]!, /×2$/);
});

test("formatCodexWarning is dense and content-free", () => {
  const [w] = probeCodexRecords([
    { type: "event_msg", payload: { type: "weird", secret: "hunter2" } },
  ]);
  const line = formatCodexWarning(w!, "x.jsonl");
  assert.ok(line.includes("keys=[secret,type]"));
  assert.ok(!line.includes("hunter2"), "values never reach the log");
});
