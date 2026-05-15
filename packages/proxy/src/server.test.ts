import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Store, listRuns, listSteps } from "@spool/collector";
import { startProxy } from "./server.ts";

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-proxy-test-"));
  process.env.SPOOL_HOME = dir;
  return dir;
}

function startFakeUpstream(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () =>
          new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function settled(): Promise<void> {
  // The proxy fires capture asynchronously after returning the client
  // response. Wait a tick + small grace so the persist work lands.
  await new Promise((r) => setTimeout(r, 200));
}

test("proxy passes Anthropic non-streaming through and captures one Step", async () => {
  freshHome();
  const upstream = await startFakeUpstream((req, res, body) => {
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.method, "POST");
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, "claude-opus-4-7");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_test",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "pong" }],
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
    );
  });

  const proxy = await startProxy({
    port: 0,
    upstreams: { anthropic: upstream.url },
    spec: { project: "/tmp/proxy-test", agent: "smoke" },
    logger: () => {},
  });

  try {
    const resp = await fetch(proxy.url + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fake" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        system: "you are a test",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    assert.equal(resp.status, 200);
    const json = (await resp.json()) as { content: Array<{ text: string }> };
    assert.equal(json.content[0]!.text, "pong");

    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.source_runtime, "proxy");
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.action.kind, "message");
      assert.equal(
        (steps[0]!.action as { text: string }).text,
        "pong",
      );
      assert.equal(steps[0]!.tokens.input, 7);
      assert.equal(steps[0]!.tokens.output, 2);
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy passes Anthropic streaming through and reassembles into one Step", async () => {
  freshHome();
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","model":"claude-opus-4-7","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    let i = 0;
    const tick = () => {
      if (i >= events.length) return res.end();
      res.write(events[i]!);
      i++;
      setTimeout(tick, 5);
    };
    tick();
  });

  const proxy = await startProxy({
    port: 0,
    upstreams: { anthropic: upstream.url },
    spec: { project: "/tmp/proxy-test-stream", agent: "smoke" },
    logger: () => {},
  });

  try {
    const resp = await fetch(proxy.url + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "stream-ping" }],
      }),
    });
    assert.equal(resp.status, 200);
    // Drain client stream — proves we got SSE through.
    const text = await resp.text();
    assert.match(text, /content_block_delta/);

    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.action.kind, "message");
      assert.equal((steps[0]!.action as { text: string }).text, "Hi!");
      assert.equal(steps[0]!.tokens.output, 2);
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy groups two requests with same first user message into one Run", async () => {
  freshHome();
  let respIdx = 0;
  const responses = [
    {
      content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } }],
      usage: { input_tokens: 5, output_tokens: 1 },
    },
    {
      content: [{ type: "text", text: "found 3" }],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  ];
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${respIdx}`,
        model: "claude-opus-4-7",
        ...responses[respIdx]!,
      }),
    );
    respIdx += 1;
  });

  const proxy = await startProxy({
    port: 0,
    upstreams: { anthropic: upstream.url },
    spec: { project: "/tmp/proxy-grouping", agent: "smoke" },
    logger: () => {},
  });

  try {
    // turn 1 — model picks a tool
    await fetch(proxy.url + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        messages: [{ role: "user", content: "find x" }],
      }),
    });
    await settled();

    // turn 2 — user replies with tool_result; conversation extends
    await fetch(proxy.url + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        messages: [
          { role: "user", content: "find x" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: "3 hits" }],
          },
        ],
      }),
    });
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1, "both requests should share one Run");
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 2);
      assert.equal(steps[0]!.action.kind, "tool_call");
      assert.equal(steps[1]!.action.kind, "message");
      // Step 0's outcome got retro-attached when step 1's request arrived
      // with the matching tool_result block.
      assert.ok(
        steps[0]!.outcome.tool_result_ref,
        "expected tool_result_ref to be retro-attached on step 0",
      );
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy captures upstream HTTP error as an error step", async () => {
  freshHome();
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
  });

  const proxy = await startProxy({
    port: 0,
    upstreams: { anthropic: upstream.url },
    spec: { project: "/tmp/proxy-err", agent: "smoke" },
    logger: () => {},
  });

  try {
    const resp = await fetch(proxy.url + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        messages: [{ role: "user", content: "boom" }],
      }),
    });
    assert.equal(resp.status, 429);
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.status, "error");
      assert.equal(steps[0]!.outcome.status, "error");
      assert.match(steps[0]!.outcome.summary ?? "", /HTTP 429/);
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy routes /v1/chat/completions to OpenAI capture", async () => {
  freshHome();
  const upstream = await startFakeUpstream((req, res, body) => {
    assert.equal(req.url, "/v1/chat/completions");
    JSON.parse(body); // valid JSON
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl_1",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "yo" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }),
    );
  });

  const proxy = await startProxy({
    port: 0,
    upstreams: { openai: upstream.url },
    spec: { project: "/tmp/proxy-oai", agent: "smoke" },
    logger: () => {},
  });

  try {
    const resp = await fetch(proxy.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
    });
    assert.equal(resp.status, 200);
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.source_runtime, "proxy");
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.model, "gpt-4o");
      assert.equal(steps[0]!.action.kind, "message");
      assert.equal((steps[0]!.action as { text: string }).text, "yo");
      assert.equal(steps[0]!.tokens.input, 10);
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy strips x-spool-* headers before forwarding upstream", async () => {
  freshHome();
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  const upstream = await startFakeUpstream((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_h",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  const proxy = await startProxy({
    port: 0,
    upstreams: { anthropic: upstream.url },
    spec: { project: "/tmp/proxy-h", agent: "smoke" },
    logger: () => {},
  });
  try {
    await fetch(proxy.url + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-spool-run-id": "run_explicit_test",
        "x-spool-project": "should-not-leak",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await settled();
    assert.equal(receivedHeaders["x-spool-run-id"], undefined);
    assert.equal(receivedHeaders["x-spool-project"], undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
