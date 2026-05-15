import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSseStream, teeAndCollect } from "./sse.ts";

test("parseSseStream parses event+data blocks", () => {
  const text = [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"msg_1"}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const events = parseSseStream(text);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.event, "message_start");
  assert.deepEqual(events[0]!.data, {
    type: "message_start",
    message: { id: "msg_1" },
  });
  assert.equal(events[1]!.event, "message_stop");
});

test("parseSseStream handles [DONE] sentinel and non-JSON lines", () => {
  const text = ["data: [DONE]", "", "data: not-json", ""].join("\n");
  const events = parseSseStream(text);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.data, "[DONE]");
  assert.equal(events[1]!.data, "not-json");
});

test("teeAndCollect lets the client read while capture buffers", async () => {
  const chunks = ["hello ", "world"];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(new TextEncoder().encode(c));
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.close();
    },
  });
  const { clientStream, capturePromise } = teeAndCollect(stream);
  const reader = clientStream.getReader();
  const decoder = new TextDecoder();
  let clientText = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    clientText += decoder.decode(value, { stream: true });
  }
  clientText += decoder.decode();
  assert.equal(clientText, "hello world");
  assert.equal(await capturePromise, "hello world");
});
