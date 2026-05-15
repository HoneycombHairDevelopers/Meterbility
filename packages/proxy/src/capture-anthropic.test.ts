import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicCapture } from "./capture-anthropic.ts";

test("Anthropic parseRequest pulls system + history + tools", () => {
  const req = JSON.stringify({
    model: "claude-opus-4-7",
    max_tokens: 512,
    system: "you are helpful",
    tools: [{ name: "search", description: "search the web", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "find spool" }],
  });
  const parsed = anthropicCapture.parseRequest(req);
  assert.equal(parsed.model, "claude-opus-4-7");
  assert.equal(parsed.systemPrompt, "you are helpful");
  assert.deepEqual(parsed.history, [{ role: "user", content: "find spool" }]);
  assert.equal(Array.isArray(parsed.toolDefinitions), true);
  assert.equal(parsed.isStream, false);
});

test("Anthropic parseResponse extracts message action + token usage", () => {
  const resp = JSON.stringify({
    id: "msg_1",
    model: "claude-opus-4-7",
    content: [{ type: "text", text: "hello!" }],
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
    },
  });
  const ex = anthropicCapture.parseResponse(resp);
  assert.ok(ex);
  assert.equal(ex!.action.kind, "message");
  assert.equal((ex!.action as { kind: string; text: string }).text, "hello!");
  assert.equal(ex!.tokens.input, 12);
  assert.equal(ex!.tokens.output, 4);
  assert.equal(ex!.tokens.cached_read, 50);
  assert.equal(ex!.tokens.cache_creation_1h, 1000);
});

test("Anthropic parseResponse extracts tool_use action", () => {
  const resp = JSON.stringify({
    id: "msg_2",
    model: "claude-opus-4-7",
    content: [
      { type: "text", text: "let me search" },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "spool" } },
    ],
    usage: { input_tokens: 30, output_tokens: 8 },
  });
  const ex = anthropicCapture.parseResponse(resp);
  assert.ok(ex);
  assert.equal(ex!.action.kind, "tool_call");
  const a = ex!.action as { tool_name: string; tool_use_id: string; tool_input: unknown };
  assert.equal(a.tool_name, "search");
  assert.equal(a.tool_use_id, "tu_1");
  assert.deepEqual(a.tool_input, { q: "spool" });
});

test("Anthropic reassembleStream rebuilds text + tool_use across deltas", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_3","model":"claude-opus-4-7","content":[]}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_x","name":"search","input":{}}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"spool\\"}"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":1}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const ex = anthropicCapture.reassembleStream(sse);
  assert.ok(ex, "expected reassembleStream to yield a captured exchange");
  // tool_use blocks win over text blocks for the action.
  assert.equal(ex!.action.kind, "tool_call");
  const a = ex!.action as { tool_name: string; tool_input: unknown };
  assert.equal(a.tool_name, "search");
  assert.deepEqual(a.tool_input, { q: "spool" });
  assert.equal(ex!.tokens.output, 15);
});

test("Anthropic parseRequest pulls tool_results out of message blocks", () => {
  const req = JSON.stringify({
    model: "claude-opus-4-7",
    max_tokens: 512,
    messages: [
      { role: "user", content: "find spool" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "spool" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "3 hits" },
        ],
      },
    ],
  });
  const parsed = anthropicCapture.parseRequest(req);
  assert.equal(parsed.pendingToolResults.length, 1);
  assert.equal(parsed.pendingToolResults[0]!.tool_use_id, "tu_1");
  assert.equal(parsed.pendingToolResults[0]!.content, "3 hits");
});
