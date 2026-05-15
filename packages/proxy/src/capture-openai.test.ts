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
              function: { name: "search", arguments: '{"q":"spool"}' },
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
  assert.deepEqual(a.tool_input, { q: "spool" });
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
