import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackNotifier } from "./slack.ts";

test("rejects an invalid webhook URL", () => {
  assert.throws(
    () => new SlackNotifier({ webhookUrl: "https://example.com/x" }),
    /invalid Slack webhook/,
  );
});

test("formats alert payloads as Block Kit attachments", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const n = new SlackNotifier({
      webhookUrl: "https://hooks.slack.com/services/T0/B0/x",
      serverUrl: "http://127.0.0.1:4317",
    });
    await n.handleEvent({
      type: "alert",
      run_id: "run_xyz",
      kind: "loop",
      message: "4× Bash with same args",
    });
    assert.equal(calls.length, 1);
    const payload = calls[0]!.body as {
      attachments: Array<{ blocks: Array<{ text?: { text?: string } }> }>;
    };
    assert.ok(payload.attachments);
    const text = payload.attachments[0]!.blocks[0]!.text!.text!;
    assert.match(text, /Loop detected/);
    assert.match(text, /run_xyz/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("filters events by configured kinds (default: alert only)", async () => {
  const calls: unknown[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push({});
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const n = new SlackNotifier({
      webhookUrl: "https://hooks.slack.com/services/T0/B0/x",
    });
    // run:created shouldn't be forwarded by default.
    await n.handleEvent({
      type: "run:created",
      run: {
        run_id: "r",
        agent_id: "a",
        project_id: "p",
        source_runtime: "claude-code",
        status: "in_progress",
        started_at: new Date().toISOString(),
        tokens_total_input: 0,
        tokens_total_output: 0,
        tokens_total_cached: 0,
        cost_cents: 0,
        step_count: 0,
        tags: [],
      },
    });
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("rate-limits posts within a 60s window", async () => {
  const calls: unknown[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push({});
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const n = new SlackNotifier({
      webhookUrl: "https://hooks.slack.com/services/T0/B0/x",
      rateLimitPerMinute: 2,
    });
    for (let i = 0; i < 5; i++) {
      await n.handleEvent({
        type: "alert",
        run_id: "r",
        kind: "loop",
        message: `loop ${i}`,
      });
    }
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});
