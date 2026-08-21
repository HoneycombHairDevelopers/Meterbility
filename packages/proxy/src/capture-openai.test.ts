import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiCapture } from "./capture-openai.ts";

test("OpenAI parseRequest pulls system + history out of messages", () => {
  const req = JSON.stringify({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ],
  });
  const parsed = openaiCapture.parseRequest(req);
  assert.equal(parsed.model, "gpt-4o");
  assert.equal(parsed.systemPrompt, "be terse");
  assert.deepEqual(parsed.history, [{ role: "user", content: "hi" }]);
});

test("OpenAI parseResponse extracts text message + token usage", () => {
  const resp = JSON.stringify({
    model: "gpt-4o",
    choices: [{ message: { role: "assistant", content: "hello!" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 4 },
    },
  });
  const ex = openaiCapture.parseResponse(resp);
  assert.ok(ex);
  assert.equal(ex!.action.kind, "message");
  assert.equal((ex!.action as { text: string }).text, "hello!");
  assert.equal(ex!.tokens.input, 8);
  assert.equal(ex!.tokens.output, 3);
  assert.equal(ex!.tokens.cached_read, 4);
});

test("OpenAI parseResponse extracts tool_calls action", () => {
  const resp = JSON.stringify({
    model: "gpt-4o",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"meter"}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  });
  const ex = openaiCapture.parseResponse(resp);
  assert.ok(ex);
  assert.equal(ex!.action.kind, "tool_call");
  const a = ex!.action as { tool_name: string; tool_use_id: string; tool_input: unknown };
  assert.equal(a.tool_name, "search");
  assert.equal(a.tool_use_id, "call_1");
  assert.deepEqual(a.tool_input, { q: "meter" });
});

test("OpenAI reassembleStream concatenates text deltas + final usage chunk", () => {
  const sse = [
    'data: {"id":"x","model":"gpt-4o","choices":[{"delta":{"content":"Hello "}}]}',
    "",
    'data: {"id":"x","model":"gpt-4o","choices":[{"delta":{"content":"world"}}]}',
    "",
    'data: {"id":"x","model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}]}',
    "",
    'data: {"id":"x","model":"gpt-4o","usage":{"prompt_tokens":10,"completion_tokens":2}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const ex = openaiCapture.reassembleStream(sse);
  assert.ok(ex);
  assert.equal((ex!.action as { text: string }).text, "Hello world");
  assert.equal(ex!.tokens.input, 10);
  assert.equal(ex!.tokens.output, 2);
});

test("reassembleStream folds reasoning_content deltas into the decision blob", () => {
  // NVIDIA-style reasoning stream (captured live 2026-08-20): reasoning
  // deltas arrive BEFORE any visible content, every delta carries role,
  // usage rides a separate empty-choices final chunk.
  const sse = [
    'data: {"id":"r","model":"meta/muse-glimmer-30b","choices":[{"delta":{"reasoning_content":"We need to count. ","role":"assistant"}}]}',
    "",
    'data: {"id":"r","model":"meta/muse-glimmer-30b","choices":[{"delta":{"reasoning_content":"Simple.","role":"assistant"}}]}',
    "",
    'data: {"id":"r","model":"meta/muse-glimmer-30b","choices":[{"delta":{"content":"1\\n2","role":"assistant"}}]}',
    "",
    'data: {"id":"r","model":"meta/muse-glimmer-30b","choices":[{"delta":{"role":"assistant"},"finish_reason":"stop"}]}',
    "",
    'data: {"id":"r","model":"meta/muse-glimmer-30b","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":40}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const ex = openaiCapture.reassembleStream(sse);
  assert.ok(ex);
  // The visible action stays the visible text…
  assert.equal((ex!.action as { text: string }).text, "1\n2");
  // …and the thinking survives in the stored decision, matching what a
  // non-streamed response body would have carried.
  const decision = JSON.parse(ex!.decisionJson) as {
    choices: Array<{ message: { reasoning_content?: string } }>;
  };
  assert.equal(
    decision.choices[0]!.message.reasoning_content,
    "We need to count. Simple.",
  );
});

test("reassembleStream recovers first-delta vs first-visible timing from marks", () => {
  const b = (json: string) => `data: ${json}\n\n`;
  const blocks = [
    b('{"id":"t","model":"m/reasoner","choices":[{"delta":{"reasoning_content":"hmm"}}]}'),
    b('{"id":"t","model":"m/reasoner","choices":[{"delta":{"content":"answer"}}]}'),
    b('{"id":"t","model":"m/reasoner","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}'),
    "data: [DONE]\n\n",
  ];
  const text = blocks.join("");
  // One network chunk per block: reasoning arrives at 50ms, the first
  // visible token at 850ms — an 800ms reasoning burn.
  let upto = 0;
  const arrival = [50, 850, 900, 901];
  const marks = blocks.map((blk, i) => {
    upto += blk.length;
    return { at_ms: arrival[i]!, upto };
  });
  const ex = openaiCapture.reassembleStream(text, marks);
  assert.ok(ex?.timing);
  assert.equal(ex!.timing!.first_delta_ms, 50);
  assert.equal(ex!.timing!.first_visible_ms, 850);
});

test("reassembleStream without marks omits timing (back-compat)", () => {
  const sse =
    'data: {"id":"x","model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const ex = openaiCapture.reassembleStream(sse);
  assert.ok(ex);
  assert.equal(ex!.timing, undefined);
});

test("cacheReported distinguishes absent prompt_tokens_details from explicit zero", () => {
  // nemotron-shaped: usage present, NO prompt_tokens_details at all.
  const unreported = openaiCapture.parseResponse(
    JSON.stringify({
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 25, completion_tokens: 72, total_tokens: 97 },
    }),
  );
  assert.equal(unreported!.cacheReported, false);
  assert.equal(unreported!.tokens.cached_read, 0);

  // muse-shaped: details present with an explicit cached_tokens: 0.
  const reportedZero = openaiCapture.parseResponse(
    JSON.stringify({
      model: "meta/muse-glimmer-30b",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 65,
        completion_tokens: 239,
        prompt_tokens_details: { audio_tokens: null, cached_tokens: 0 },
      },
    }),
  );
  assert.equal(reportedZero!.cacheReported, true);
  assert.equal(reportedZero!.tokens.cached_read, 0);

  // No usage at all: cacheReported stays undefined (that's usage:missing's job).
  const noUsage = openaiCapture.parseResponse(
    JSON.stringify({
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }),
  );
  assert.equal(noUsage!.cacheReported, undefined);
});

test("OpenAI tool messages flow into pendingToolResults", () => {
  const req = JSON.stringify({
    model: "gpt-4o",
    messages: [
      { role: "user", content: "find it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "3 hits" },
    ],
  });
  const parsed = openaiCapture.parseRequest(req);
  assert.equal(parsed.pendingToolResults.length, 1);
  assert.equal(parsed.pendingToolResults[0]!.tool_use_id, "call_1");
  assert.equal(parsed.pendingToolResults[0]!.content, "3 hits");
});
