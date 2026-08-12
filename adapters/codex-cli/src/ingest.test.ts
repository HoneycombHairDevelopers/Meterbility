import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, listRuns, listSteps } from "@meterbility/collector";
import { ingestCodexSession } from "./ingest.ts";

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "meter-codex-"));
  process.env.METERBILITY_HOME = dir;
  return Store.open();
}

function writeSession(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "meter-codex-session-"));
  const path = join(dir, "rollout-2026-05-11T10-12-04-test-session.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

test("ingest codex message-only session", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-05-11T17:12:04Z",
      payload: {
        id: "sess1",
        timestamp: "2026-05-11T17:12:04Z",
        cwd: "/tmp/proj",
        model_provider: "openai",
        base_instructions: { text: "you are a careful coder" },
        git: { branch: "main" },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:05Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "list the files" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:06Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "[external_agent_tool_call: Bash]\ncommand: ls -la\n[/external_agent_tool_call]",
          },
        ],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:07Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-05-11T17:12:08Z",
      payload: { type: "task_complete", turn_id: "t1" },
    },
  ]);

  const r = await ingestCodexSession(store, path);
  assert.equal(r.status, "ok");
  assert.equal(r.steps_added, 2);

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.source_runtime, "codex-cli");
  assert.equal(runs[0]!.git_branch, "main");
  assert.equal(runs[0]!.cwd, "/tmp/proj");
  assert.equal(runs[0]!.status, "ok");
  assert.ok(runs[0]!.tags.includes("cost:approx"));

  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.action.kind, "tool_call");
  assert.equal(steps[0]!.action.tool_name, "Bash");
  assert.equal(steps[1]!.action.kind, "message");
  store.close();
});

test("function_call + function_call_output pair becomes one step with outcome", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-05-11T17:12:04Z",
      payload: { id: "sess2", timestamp: "2026-05-11T17:12:04Z", cwd: "/tmp/p2" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:05Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "compute 1+1" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:06Z",
      payload: {
        type: "function_call",
        call_id: "c1",
        name: "calculator",
        arguments: '{"expr":"1+1"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:07Z",
      payload: { type: "function_call_output", call_id: "c1", output: "2" },
    },
  ]);

  const r = await ingestCodexSession(store, path);
  assert.equal(r.steps_added, 1);
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps[0]!.action.kind, "tool_call");
  assert.equal(steps[0]!.action.tool_name, "calculator");
  assert.deepEqual(steps[0]!.action.tool_input, { expr: "1+1" });
  assert.equal(steps[0]!.outcome.status, "ok");
  assert.ok(steps[0]!.outcome.tool_result_ref);
  store.close();
});

test("codex ingest is idempotent", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-05-11T17:12:04Z",
      payload: { id: "sess3", timestamp: "2026-05-11T17:12:04Z", cwd: "/tmp/p3" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:05Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    },
  ]);
  await ingestCodexSession(store, path);
  const r2 = await ingestCodexSession(store, path);
  assert.equal(r2.status, "empty");
  store.close();
});

// ---------------------------------------------------------------------------
// Parity coverage (2026-08-04): token_count usage, turn_context model,
// patch_apply_end file changes, custom_tool_call steps. Fixture shapes are
// taken from a real captured write-mode rollout.
// ---------------------------------------------------------------------------

function paritySession(): object[] {
  return [
    {
      type: "session_meta",
      timestamp: "2026-08-04T18:26:37Z",
      payload: {
        id: "sess-parity",
        timestamp: "2026-08-04T18:26:37Z",
        cwd: "/tmp/proj",
        model_provider: "openai",
        git: { branch: "main", commit_hash: "abc123", repository_url: "x" },
      },
    },
    {
      type: "turn_context",
      timestamp: "2026-08-04T18:26:38Z",
      payload: { model: "gpt-5.5", cwd: "/tmp/proj" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T18:26:39Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "create probe.txt then edit it" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T18:26:41Z",
      payload: {
        type: "custom_tool_call",
        id: "ctc_1",
        status: "completed",
        call_id: "call_A",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: probe.txt\n+parity probe v1\n*** End Patch\n",
        metadata: { turn_id: "turn-1" },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T18:26:42Z",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_A",
        output:
          "Exit code: 0\nWall time: 0.2 seconds\nOutput:\nSuccess. Updated the following files:\nA probe.txt\n",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-04T18:26:42Z",
      payload: {
        type: "patch_apply_end",
        call_id: "call_A",
        turn_id: "turn-1",
        stdout: "Success. Updated the following files:\nA probe.txt\n",
        stderr: "",
        success: true,
        status: "completed",
        changes: {
          "/tmp/proj/probe.txt": { type: "add", content: "parity probe v1\n" },
        },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-04T18:26:43Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 800,
            output_tokens: 60,
            reasoning_output_tokens: 40,
            total_tokens: 1060,
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 800,
            output_tokens: 60,
            reasoning_output_tokens: 40,
            total_tokens: 1060,
          },
          model_context_window: 258400,
        },
        rate_limits: { limit_id: "codex", plan_type: "plus" },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T18:26:45Z",
      payload: {
        type: "custom_tool_call",
        id: "ctc_2",
        status: "completed",
        call_id: "call_B",
        name: "apply_patch",
        input:
          "*** Begin Patch\n*** Update File: probe.txt\n@@\n parity probe v1\n+edited by codex\n*** End Patch\n",
        metadata: { turn_id: "turn-1" },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T18:26:46Z",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_B",
        output:
          "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nM probe.txt\n",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-04T18:26:46Z",
      payload: {
        type: "patch_apply_end",
        call_id: "call_B",
        turn_id: "turn-1",
        stdout: "Success. Updated the following files:\nM probe.txt\n",
        stderr: "",
        success: true,
        status: "completed",
        changes: {
          "/tmp/proj/probe.txt": {
            type: "update",
            unified_diff: "@@ -1 +1,2 @@\n parity probe v1\n+edited by codex\n",
            move_path: null,
          },
        },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-04T18:26:47Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 2500,
            cached_input_tokens: 2100,
            output_tokens: 110,
            reasoning_output_tokens: 60,
            total_tokens: 2610,
          },
          last_token_usage: {
            input_tokens: 1500,
            cached_input_tokens: 1300,
            output_tokens: 50,
            reasoning_output_tokens: 20,
            total_tokens: 1550,
          },
          model_context_window: 258400,
        },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T18:26:48Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-04T18:26:49Z",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "Done.",
        duration_ms: 9800,
        time_to_first_token_ms: 900,
      },
    },
  ];
}

test("parity: token_count deltas land on steps with uncached-input semantics", async () => {
  const store = freshStore();
  const path = writeSession(paritySession());
  const r = await ingestCodexSession(store, path);
  assert.equal(r.steps_added, 3);

  const runs = listRuns(store);
  const run = runs[0]!;
  // Usage exists → run must NOT carry cost:approx.
  assert.ok(!run.tags.includes("cost:approx"), "run should not be cost:approx");

  const steps = listSteps(store, run.run_id);
  // Step 0 (call_A) anchors the first token_count: input 1000/cached 800.
  const s0 = steps[0]!;
  assert.equal(s0.tokens.input, 200, "input stores uncached only");
  assert.equal(s0.tokens.cached_read, 800);
  assert.equal(s0.tokens.output, 60);
  assert.equal(s0.tokens.reasoning, 40);
  assert.ok(s0.cost_cents > 0, "cost computed from real pricing");
  assert.ok(!s0.tags.includes("cost:approx"), "gpt-5.5 prefix-matches gpt-5");

  // Step 1 (call_B) anchors the second token_count DELTA (not cumulative).
  const s1 = steps[1]!;
  assert.equal(s1.tokens.input, 200); // 1500 - 1300
  assert.equal(s1.tokens.cached_read, 1300);
  assert.equal(s1.tokens.output, 50);

  // Run totals aggregate real usage.
  assert.ok(run.tokens_total_cached >= 0); // refreshed via updateRunTotals
  store.close();
});

test("parity: model comes from turn_context, never the provider string", async () => {
  const store = freshStore();
  const path = writeSession(paritySession());
  await ingestCodexSession(store, path);
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  for (const s of steps) {
    assert.equal(s.model, "gpt-5.5");
  }
  store.close();
});

test("parity: patch_apply_end produces file_change rows (add + partial update)", async () => {
  const store = freshStore();
  const path = writeSession(paritySession());
  await ingestCodexSession(store, path);
  const runs = listRuns(store);
  const rows = store.db
    .prepare(
      `SELECT * FROM file_change WHERE run_id = ? ORDER BY created_at, sequence`,
    )
    .all(runs[0]!.run_id) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);

  const add = rows.find((r) => r.op === "create")!;
  assert.equal(add.path, "probe.txt");
  assert.equal(add.partial_diff, 0);
  assert.ok(add.after_blob_ref, "add carries after-content blob");
  assert.equal(add.lines_added, 1);
  assert.equal(add.source_tool_name, "apply_patch");

  const upd = rows.find((r) => r.op === "modify")!;
  assert.equal(upd.path, "probe.txt");
  assert.equal(upd.partial_diff, 1, "updates have no before-content");
  assert.ok(
    String(upd.patch_text).includes("+edited by codex"),
    "unified diff cached as patch_text",
  );
  assert.equal(upd.lines_added, 1);
  store.close();
});

test("parity: custom_tool_call steps get exit code + wall-time latency", async () => {
  const store = freshStore();
  const path = writeSession(paritySession());
  await ingestCodexSession(store, path);
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  const s0 = steps[0]!;
  assert.equal(s0.action.kind, "tool_call");
  assert.equal(s0.action.tool_name, "apply_patch");
  assert.equal(s0.outcome.status, "ok");
  assert.equal(s0.latency_ms, 200, "Wall time: 0.2 seconds → 200ms");
  // Terminal assistant step gets the turn's duration_ms.
  const s2 = steps[2]!;
  assert.equal(s2.action.kind, "message");
  assert.equal(s2.latency_ms, 9800);
  store.close();
});

test("parity: re-ingest duplicates neither steps nor file_change rows", async () => {
  const store = freshStore();
  const path = writeSession(paritySession());
  await ingestCodexSession(store, path);
  const runs = listRuns(store);
  const runId = runs[0]!.run_id;
  const stepsBefore = listSteps(store, runId).length;
  const fcBefore = (
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM file_change WHERE run_id = ?`)
      .get(runId) as { n: number }
  ).n;

  // Force a full re-read by resetting the ingest offset (simulates a
  // fresh machine or offset loss — the worst case for duplication).
  store.db
    .prepare(`DELETE FROM ingest_progress WHERE source_path = ?`)
    .run(path);
  await ingestCodexSession(store, path);

  assert.equal(listSteps(store, runId).length, stepsBefore);
  const fcAfter = (
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM file_change WHERE run_id = ?`)
      .get(runId) as { n: number }
  ).n;
  assert.equal(fcAfter, fcBefore);
  store.close();
});

test("parity: nonzero exit code marks the tool step as error", async () => {
  const store = freshStore();
  const session = paritySession().map((r) => {
    const rec = r as { type: string; payload: { type?: string; call_id?: string; output?: string } };
    if (
      rec.type === "response_item" &&
      rec.payload.type === "custom_tool_call_output" &&
      rec.payload.call_id === "call_B"
    ) {
      return {
        ...rec,
        payload: {
          ...rec.payload,
          output: "Exit code: 1\nWall time: 0.1 seconds\nOutput:\npatch failed\n",
        },
      };
    }
    return r;
  });
  const path = writeSession(session);
  await ingestCodexSession(store, path);
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  const s1 = steps[1]!; // call_B
  assert.equal(s1.outcome.status, "error");
  assert.equal(s1.outcome.is_error, true);
  assert.equal(s1.status, "error");
  store.close();
});

test("parity: patch_apply_end delete and rename entries map to delete / rename ops", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-08-04T18:26:37Z",
      payload: { id: "sess-ops", timestamp: "2026-08-04T18:26:37Z", cwd: "/tmp/proj" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T18:26:41Z",
      payload: {
        type: "custom_tool_call",
        id: "ctc_1",
        status: "completed",
        call_id: "call_ops",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Delete File: dead.txt\n*** End Patch\n",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-04T18:26:42Z",
      payload: {
        type: "patch_apply_end",
        call_id: "call_ops",
        success: true,
        changes: {
          "/tmp/proj/dead.txt": { type: "delete" },
          "/tmp/proj/probe.txt": {
            type: "update",
            unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
            move_path: "/tmp/proj/renamed.txt",
          },
        },
      },
    },
  ]);
  await ingestCodexSession(store, path);
  const runs = listRuns(store);
  const rows = store.db
    .prepare(`SELECT * FROM file_change WHERE run_id = ? ORDER BY sequence`)
    .all(runs[0]!.run_id) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);

  const del = rows.find((r) => r.op === "delete")!;
  assert.equal(del.path, "dead.txt");
  assert.equal(del.partial_diff, 1);

  const ren = rows.find((r) => r.op === "rename")!;
  assert.equal(ren.path, "renamed.txt", "rename: path is the move target");
  assert.equal(ren.old_path, "probe.txt", "rename: old_path is the original");
  assert.ok(String(ren.patch_text).includes("+new"));
  store.close();
});

test("parity: two unmatched-call_id patch events both attach to the last step without colliding", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-08-04T18:26:37Z",
      payload: { id: "sess-orphan", timestamp: "2026-08-04T18:26:37Z", cwd: "/tmp/proj" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-04T18:26:40Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "patching" }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-04T18:26:41Z",
      payload: {
        type: "patch_apply_end",
        call_id: "call_lost_1",
        success: true,
        changes: {
          "/tmp/proj/one.txt": { type: "add", content: "one\n" },
        },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-04T18:26:42Z",
      payload: {
        type: "patch_apply_end",
        call_id: "call_lost_2",
        success: true,
        changes: {
          "/tmp/proj/two.txt": { type: "add", content: "two\n" },
        },
      },
    },
  ]);
  // Regression for the UNIQUE(step_id, sequence) crash-loop: both
  // fallback events land on the same (only) step and must take
  // distinct sequences.
  const r = await ingestCodexSession(store, path);
  assert.equal(r.status, "ok");
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps.length, 1);
  const rows = store.db
    .prepare(`SELECT * FROM file_change WHERE run_id = ? ORDER BY sequence`)
    .all(runs[0]!.run_id) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2, "both orphan patches inserted");
  assert.equal(rows[0]!.step_id, steps[0]!.step_id);
  assert.equal(rows[1]!.step_id, steps[0]!.step_id);
  assert.deepEqual(
    rows.map((x) => x.sequence),
    [0, 1],
    "distinct sequences on the shared fallback step",
  );
  store.close();
});

test("idle tail (chatter-only append) skips the rebuild; a real append still ingests", async () => {
  const { appendFileSync } = await import("node:fs");
  const store = freshStore();
  const path = writeSession(paritySession());
  await ingestCodexSession(store, path);
  const runs = listRuns(store);
  const runId = runs[0]!.run_id;
  const stepsBefore = listSteps(store, runId).length;

  // Chatter-only append: an agent_message event carries no step
  // material — the idle-tail gate must advance the offset and skip.
  appendFileSync(
    path,
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-04T18:27:00Z",
      payload: { type: "agent_message", message: "just narrating" },
    }) + "\n",
  );
  const r1 = await ingestCodexSession(store, path);
  assert.equal(r1.status, "ok");
  assert.equal(r1.steps_added, 0);
  assert.equal(r1.run_id, runId);
  assert.equal(listSteps(store, runId).length, stepsBefore, "no new steps");

  // Offset advanced: the same call again is a clean empty.
  const r2 = await ingestCodexSession(store, path);
  assert.equal(r2.status, "empty");

  // A real append (assistant response_item) still ingests normally.
  appendFileSync(
    path,
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-04T18:27:05Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "one more thing" }],
      },
    }) + "\n",
  );
  const r3 = await ingestCodexSession(store, path);
  assert.equal(r3.status, "ok");
  assert.equal(
    listSteps(store, runId).length,
    stepsBefore + 1,
    "real append added a step",
  );
  store.close();
});

// ---------------------------------------------------------------------------
// Coverage closure (ship 2026-08-11): title-preamble skip, subagent tag,
// null-info token_count refresh.
// ---------------------------------------------------------------------------

test("title skips injected AGENTS.md/user_instructions preambles", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-08-11T10:00:00Z",
      payload: { id: "sess-title", timestamp: "2026-08-11T10:00:00Z", cwd: "/tmp/t" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-11T10:00:01Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for this repo\nrules..." }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-11T10:00:02Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<user_instructions>be terse</user_instructions>" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-11T10:00:03Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "fix the flaky sentinel test" }],
      },
    },
  ]);
  await ingestCodexSession(store, path);
  assert.equal(listRuns(store)[0]!.title, "fix the flaky sentinel test");
  store.close();
});

test("title falls back to the preamble when no real prompt exists", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-08-11T10:00:00Z",
      payload: { id: "sess-title2", timestamp: "2026-08-11T10:00:00Z", cwd: "/tmp/t2" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-11T10:00:01Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions only" }],
      },
    },
  ]);
  await ingestCodexSession(store, path);
  assert.equal(listRuns(store)[0]!.title, "# AGENTS.md instructions only");
  store.close();
});

test("parent_thread_id tags the run codex:subagent", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-08-11T10:00:00Z",
      payload: {
        id: "sess-sub",
        timestamp: "2026-08-11T10:00:00Z",
        cwd: "/tmp/sub",
        parent_thread_id: "parent-123",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-11T10:00:01Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "child working" }],
      },
    },
  ]);
  await ingestCodexSession(store, path);
  assert.ok(listRuns(store)[0]!.tags.includes("codex:subagent"));
  store.close();
});

test("token_count with info:null (rate-limit refresh) attributes no usage and keeps cost:approx", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-08-11T10:00:00Z",
      payload: { id: "sess-nullinfo", timestamp: "2026-08-11T10:00:00Z", cwd: "/tmp/ni" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-11T10:00:01Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "thinking..." }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-11T10:00:02Z",
      payload: {
        type: "token_count",
        info: null,
        rate_limits: { limit_id: "codex", plan_type: "plus" },
      },
    },
  ]);
  const r = await ingestCodexSession(store, path);
  assert.equal(r.status, "ok");
  const run = listRuns(store)[0]!;
  const steps = listSteps(store, run.run_id);
  assert.equal(steps[0]!.tokens.input, 0);
  assert.equal(steps[0]!.tokens.cached_read, 0);
  assert.ok(run.tags.includes("cost:approx"), "no usage → still approx");
  store.close();
});
