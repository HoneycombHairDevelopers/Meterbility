import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Store, listRuns, listSteps } from "@meterbility/collector";
import { startProxy } from "./server.ts";

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "meter-proxy-test-"));
  process.env.METERBILITY_HOME = dir;
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

test("proxy strips x-meterbility-* headers before forwarding upstream", async () => {
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
        "x-meterbility-run-id": "run_explicit_test",
        "x-meterbility-project": "should-not-leak",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await settled();
    assert.equal(receivedHeaders["x-meterbility-run-id"], undefined);
    assert.equal(receivedHeaders["x-meterbility-project"], undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy persists x-meterbility-cwd/git-branch/run-id as run metadata", async () => {
  freshHome();
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_meta",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
  });
  const proxy = await startProxy({
    port: 0,
    upstreams: { anthropic: upstream.url },
    spec: { project: "/tmp/proxy-meta", agent: "smoke" },
    logger: () => {},
  });
  try {
    await fetch(proxy.url + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meterbility-run-id": "run_meta_test",
        "x-meterbility-cwd": "/home/dev/edge-project",
        "x-meterbility-git-branch": "feat/edge",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      // Edge-supplied attribution lands on the Run row.
      assert.equal(run.run_id, "run_meta_test", "explicit run id wins");
      assert.equal(run.cwd, "/home/dev/edge-project");
      assert.equal(run.git_branch, "feat/edge");
      assert.equal(
        run.source_session_id,
        "proxy:run_meta_test",
        "explicit run id is namespaced into source_session_id so it can't collide with other vendors' session ids",
      );
      // Project identity keys off the edge cwd, not the proxy's spec.
      const project = store.db
        .prepare(`SELECT cwd FROM projects WHERE project_id = ?`)
        .get(run.project_id) as { cwd: string };
      assert.equal(project.cwd, "/home/dev/edge-project");
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

/* ====================================================================
 * Multi-upstream: named providers, prefix routing, provider identity
 * (design: docs/designs/proxy-multi-upstream.md)
 * ==================================================================== */

test("prefixed OpenAI-dialect route captures with provider on run AND step", async () => {
  freshHome();
  const upstream = await startFakeUpstream((req, res) => {
    // Prefix must be stripped before forwarding.
    assert.equal(req.url, "/v1/chat/completions");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl_nv",
        model: "meta/llama-3.1-405b-instruct",
        choices: [{ message: { role: "assistant", content: "hello from nim" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      }),
    );
  });

  const proxy = await startProxy({
    port: 0,
    providers: [{ name: "nvidia", dialect: "openai", url: upstream.url }],
    spec: { project: "/tmp/proxy-nvidia", agent: "smoke" },
    logger: () => {},
  });

  try {
    const resp = await fetch(proxy.url + "/nvidia/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-nv" },
      body: JSON.stringify({
        model: "meta/llama-3.1-405b-instruct",
        messages: [{ role: "user", content: "hi nim" }],
      }),
    });
    assert.equal(resp.status, 200);
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.provider, "nvidia");
      // 2C: upstream host recorded at run creation for provenance.
      assert.equal(runs[0]!.upstream_host, new URL(upstream.url).host);
      // 1C: vendor-namespaced model → cost is honestly unpriced (0 +
      // cost:unpriced on step AND run), never a fabricated number.
      assert.ok(runs[0]!.tags.includes("cost:unpriced"));
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.provider, "nvidia");
      assert.equal(steps[0]!.tokens.input, 9);
      assert.equal(steps[0]!.cost_cents, 0);
      assert.ok(steps[0]!.tags.includes("cost:unpriced"));
      assert.ok(!steps[0]!.tags.includes("cost:approx"));
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("two providers on one port: identical prompts/models land in distinct runs", async () => {
  freshHome();
  const mkBody = () =>
    JSON.stringify({
      id: "cmpl_x",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "same" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    });
  const upstreamA = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mkBody());
  });
  const upstreamB = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mkBody());
  });

  const proxy = await startProxy({
    port: 0,
    upstreams: { openai: upstreamA.url },
    providers: [{ name: "nvidia", dialect: "openai", url: upstreamB.url }],
    spec: { project: "/tmp/proxy-ab", agent: "smoke" },
    logger: () => {},
  });

  const identicalRequest = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "identical prompt" }],
    }),
  } as const;

  try {
    await fetch(proxy.url + "/v1/chat/completions", identicalRequest);
    await fetch(proxy.url + "/nvidia/v1/chat/completions", identicalRequest);
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 2, "same prompt+model via two providers must NOT merge");
      const providers = runs.map((r) => r.provider).sort();
      assert.deepEqual(providers, ["nvidia", "openai"]);
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstreamA.close();
    await upstreamB.close();
  }
});

test("target override is provider-scoped (6A): /openai prefix follows --openai-target", async () => {
  freshHome();
  let hits = 0;
  const override = await startFakeUpstream((req, res) => {
    hits += 1;
    assert.equal(req.url, "/v1/chat/completions");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl_ovr",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "override" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });

  const proxy = await startProxy({
    port: 0,
    upstreams: { openai: override.url },
    spec: { project: "/tmp/proxy-6a", agent: "smoke" },
    logger: () => {},
  });

  try {
    const body = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    } as const;
    const bare = await fetch(proxy.url + "/v1/chat/completions", body);
    const prefixed = await fetch(proxy.url + "/openai/v1/chat/completions", body);
    assert.equal(bare.status, 200);
    assert.equal(prefixed.status, 200);
    assert.equal(hits, 2, "bare AND prefixed aliases both follow the override");
  } finally {
    await proxy.close();
    await override.close();
  }
});

test("path-carrying upstream joins cleanly and preserves the query string", async () => {
  freshHome();
  let seenUrl = "";
  const upstream = await startFakeUpstream((req, res) => {
    seenUrl = req.url ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl_q",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });

  const proxy = await startProxy({
    port: 0,
    // Groq-style: the upstream base itself carries a path segment.
    providers: [{ name: "groq", dialect: "openai", url: upstream.url + "/openai" }],
    spec: { project: "/tmp/proxy-join", agent: "smoke" },
    logger: () => {},
  });

  try {
    const resp = await fetch(
      proxy.url + "/groq/v1/chat/completions?beta=true&x=a%20b",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "q" }] }),
      },
    );
    assert.equal(resp.status, 200);
    assert.equal(seenUrl, "/openai/v1/chat/completions?beta=true&x=a%20b");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("non-capture path under a prefix forwards uncaptured and writes no rows", async () => {
  freshHome();
  const upstream = await startFakeUpstream((req, res) => {
    assert.equal(req.url, "/v1/models");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "meta/llama-3.1-405b-instruct" }] }));
  });

  const proxy = await startProxy({
    port: 0,
    providers: [{ name: "nvidia", dialect: "openai", url: upstream.url }],
    spec: { project: "/tmp/proxy-models", agent: "smoke" },
    logger: () => {},
  });

  try {
    const resp = await fetch(proxy.url + "/nvidia/v1/models");
    assert.equal(resp.status, 200);
    const json = (await resp.json()) as { data: Array<{ id: string }> };
    assert.equal(json.data[0]!.id, "meta/llama-3.1-405b-instruct");
    await settled();

    const store = Store.open();
    try {
      assert.equal(listRuns(store).length, 0, "pure passthrough writes no rows");
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("404 and /__meter/health enumerate the dynamic route set", async () => {
  freshHome();
  const proxy = await startProxy({
    port: 0,
    providers: [{ name: "nvidia", dialect: "openai", url: "https://integrate.api.nvidia.com" }],
    spec: { project: "/tmp/proxy-enum", agent: "smoke" },
    logger: () => {},
  });
  try {
    const health = await fetch(proxy.url + "/__meter/health");
    const h = (await health.json()) as { ok: boolean; providers: string[] };
    assert.equal(h.ok, true);
    assert.deepEqual([...h.providers].sort(), ["anthropic", "nvidia", "openai"]);

    const miss = await fetch(proxy.url + "/groq/v1/chat/completions", { method: "POST" });
    assert.equal(miss.status, 404);
    const m = (await miss.json()) as { error: string };
    assert.match(m.error, /\/nvidia\/\.\.\./);
    assert.match(m.error, /\/v1\/messages/);
  } finally {
    await proxy.close();
  }
});

test("upstream HTTP error through a prefixed route records an error step with provider", async () => {
  freshHome();
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  const proxy = await startProxy({
    port: 0,
    providers: [{ name: "nvidia", dialect: "openai", url: upstream.url }],
    spec: { project: "/tmp/proxy-nverr", agent: "smoke" },
    logger: () => {},
  });
  try {
    const resp = await fetch(proxy.url + "/nvidia/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "boom" }] }),
    });
    assert.equal(resp.status, 429);
    await settled();
    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.provider, "nvidia");
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps[0]!.status, "error");
      assert.equal(steps[0]!.provider, "nvidia");
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("anthropic-dialect named upstream: capture + tool_result retro-attach via prefix", async () => {
  freshHome();
  let respIdx = 0;
  const responses = [
    {
      content: [{ type: "tool_use", id: "tu_nv1", name: "lookup", input: { q: "y" } }],
      usage: { input_tokens: 4, output_tokens: 1 },
    },
    {
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 9, output_tokens: 2 },
    },
  ];
  const upstream = await startFakeUpstream((req, res) => {
    assert.equal(req.url, "/v1/messages");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_${respIdx}`, model: "claude-opus-4-7", ...responses[respIdx]! }));
    respIdx += 1;
  });

  const proxy = await startProxy({
    port: 0,
    providers: [{ name: "mygw", dialect: "anthropic", url: upstream.url }],
    spec: { project: "/tmp/proxy-mygw", agent: "smoke" },
    logger: () => {},
  });

  try {
    await fetch(proxy.url + "/mygw/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        messages: [{ role: "user", content: "find y" }],
      }),
    });
    await settled();
    await fetch(proxy.url + "/mygw/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 32,
        messages: [
          { role: "user", content: "find y" },
          { role: "assistant", content: [{ type: "tool_use", id: "tu_nv1", name: "lookup", input: { q: "y" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_nv1", content: "1 hit" }] },
        ],
      }),
    });
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.provider, "mygw");
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 2);
      assert.ok(steps[0]!.outcome.tool_result_ref, "retro-attach works through a prefix");
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("NVIDIA-shaped SSE stream through a prefixed route tees and reassembles", async () => {
  freshHome();
  // REAL NVIDIA stream shape, captured live from integrate.api.nvidia.com
  // (meta/llama-3.1-8b-instruct, 2026-08-19; ids anonymized). Quirks vs
  // vanilla OpenAI, all pinned here:
  //   - every delta chunk carries role: "assistant"
  //   - the finish_reason chunk has NO usage (only nvext timing)
  //   - usage arrives in a SEPARATE final chunk with EMPTY choices: []
  //   - usage is present by default (no stream_options.include_usage)
  //   - prompt_tokens_details.cached_tokens is populated
  //   - an nvext vendor-extension blob rides on every chunk
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      'data: {"id":"chatcmpl-fixture","choices":[{"index":0,"delta":{"content":"Hel","role":"assistant"}}],"created":1787192456,"model":"meta/llama-3.1-8b-instruct","object":"chat.completion.chunk","nvext":{"worker_id":{"prefill_worker_id":1,"prefill_dp_rank":0,"decode_worker_id":1,"decode_dp_rank":0}}}\n\n',
      'data: {"id":"chatcmpl-fixture","choices":[{"index":0,"delta":{"content":"lo","role":"assistant"}}],"created":1787192456,"model":"meta/llama-3.1-8b-instruct","object":"chat.completion.chunk","nvext":{"worker_id":{"prefill_worker_id":1,"prefill_dp_rank":0,"decode_worker_id":1,"decode_dp_rank":0}}}\n\n',
      'data: {"id":"chatcmpl-fixture","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}],"created":1787192456,"model":"meta/llama-3.1-8b-instruct","object":"chat.completion.chunk","nvext":{"worker_id":{"prefill_worker_id":1,"prefill_dp_rank":0,"decode_worker_id":1,"decode_dp_rank":0},"timing":{"request_received_ms":1787192456979,"ttft_ms":19.66,"total_time_ms":35.87,"kv_hit_rate":0.33,"router_queue_depth":0}}}\n\n',
      'data: {"id":"chatcmpl-fixture","choices":[],"created":1787192456,"model":"meta/llama-3.1-8b-instruct","object":"chat.completion.chunk","usage":{"prompt_tokens":6,"completion_tokens":2,"total_tokens":8,"prompt_tokens_details":{"cached_tokens":4}}}\n\n',
      "data: [DONE]\n\n",
    ];
    let i = 0;
    const tick = () => {
      if (i >= chunks.length) return res.end();
      res.write(chunks[i]!);
      i++;
      setTimeout(tick, 5);
    };
    tick();
  });

  const proxy = await startProxy({
    port: 0,
    providers: [{ name: "nvidia", dialect: "openai", url: upstream.url }],
    spec: { project: "/tmp/proxy-nvsse", agent: "smoke" },
    logger: () => {},
  });

  try {
    const resp = await fetch(proxy.url + "/nvidia/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "meta/llama-3.1-8b-instruct",
        stream: true,
        messages: [{ role: "user", content: "stream hi" }],
      }),
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.match(text, /\[DONE\]/);
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.provider, "nvidia");
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 1);
      assert.equal((steps[0]!.action as { text: string }).text, "Hello");
      assert.equal(steps[0]!.tokens.input, 6);
      assert.equal(steps[0]!.tokens.output, 2);
      assert.equal(
        steps[0]!.tokens.cached_read,
        4,
        "prompt_tokens_details.cached_tokens must map to cached_read",
      );
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("auth headers forward to a prefixed upstream but are never persisted", async () => {
  freshHome();
  let receivedAuth: string | undefined;
  const upstream = await startFakeUpstream((req, res) => {
    receivedAuth = req.headers["authorization"] as string | undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl_auth",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
  const proxy = await startProxy({
    port: 0,
    providers: [{ name: "nvidia", dialect: "openai", url: upstream.url }],
    spec: { project: "/tmp/proxy-auth", agent: "smoke" },
    logger: () => {},
  });
  try {
    await fetch(proxy.url + "/nvidia/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nvapi-SECRET" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "auth" }] }),
    });
    await settled();
    assert.equal(receivedAuth, "Bearer nvapi-SECRET", "auth forwards untouched");

    const store = Store.open();
    try {
      // The secret must not appear in any persisted step/run column.
      const rows = store.db
        .prepare("SELECT action_json, outcome_json, tags FROM steps")
        .all() as Array<Record<string, string>>;
      for (const row of rows) {
        for (const v of Object.values(row)) {
          assert.ok(!String(v).includes("nvapi-SECRET"), "secret leaked into a step column");
        }
      }
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("startProxy rejects duplicate provider names at startup", async () => {
  freshHome();
  await assert.rejects(
    startProxy({
      port: 0,
      providers: [
        { name: "gw", dialect: "openai", url: "https://a.example" },
        { name: "gw", dialect: "openai", url: "https://b.example" },
      ],
      logger: () => {},
    }),
    /duplicate/,
  );
});

test("unpriced model: step + run tagged cost:unpriced exactly once, never cost:approx", async () => {
  freshHome();
  const upstream = await startFakeUpstream((_req, res, body) => {
    JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl_unpriced",
        model: "meta/llama-3.1-8b-instruct",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );
  });

  const proxy = await startProxy({
    port: 0,
    providers: [{ name: "nvidia", dialect: "openai", url: upstream.url }],
    spec: { project: "/tmp/proxy-unpriced", agent: "smoke" },
    logger: () => {},
  });

  try {
    const send = (msgs: Array<{ role: string; content: string }>) =>
      fetch(proxy.url + "/nvidia/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake" },
        body: JSON.stringify({ model: "meta/llama-3.1-8b-instruct", messages: msgs }),
      });
    // Two steps in one conversation → the run-level tag must land exactly once.
    assert.equal((await send([{ role: "user", content: "hi" }])).status, 200);
    await settled();
    assert.equal(
      (
        await send([
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "more" },
        ])
      ).status,
      200,
    );
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      assert.equal(
        runs[0]!.tags.filter((t) => t === "cost:unpriced").length,
        1,
        "run carries cost:unpriced exactly once across two unpriced steps",
      );
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 2);
      for (const s of steps) {
        assert.ok(s.tags.includes("cost:unpriced"), "step tagged cost:unpriced");
        assert.ok(!s.tags.includes("cost:approx"), "unpriced suppresses cost:approx");
        assert.equal(s.cost_cents, 0, "unpriced cost stored as 0 by construction");
      }
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("zero-usage ok exchange: step gets persistent usage:missing tag (survives --quiet)", async () => {
  freshHome();
  const upstream = await startFakeUpstream((_req, res, body) => {
    JSON.parse(body);
    // A completion whose usage shape doesn't parse → zero in/out tokens.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl_nousage",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "silent" }, finish_reason: "stop" }],
        usage: { totally_different_shape: 7 },
      }),
    );
  });

  const proxy = await startProxy({
    port: 0,
    upstreams: { openai: upstream.url },
    spec: { project: "/tmp/proxy-nousage", agent: "smoke" },
    logger: () => {}, // --quiet: the log warning is gone; the tag must not be
  });

  try {
    const resp = await fetch(proxy.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 200);
    await settled();

    const store = Store.open();
    try {
      const runs = listRuns(store);
      assert.equal(runs.length, 1);
      const steps = listSteps(store, runs[0]!.run_id);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.tokens.input, 0);
      assert.equal(steps[0]!.tokens.output, 0);
      assert.ok(
        steps[0]!.tags.includes("usage:missing"),
        "zero-usage ok-step carries the persistent usage:missing marker",
      );
    } finally {
      store.close();
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
