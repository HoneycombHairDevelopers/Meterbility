import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSseStream, teeAndCollect, timeAtOffset } from "./sse.ts";

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
  const collected = await capturePromise;
  assert.equal(collected.text, "hello world");
  // One arrival mark per chunk, cumulative lengths monotone, and the
  // second chunk arrived measurably after the first (5ms gap above).
  assert.equal(collected.marks.length, 2);
  assert.equal(collected.marks[0]!.upto, "hello ".length);
  assert.equal(collected.marks[1]!.upto, "hello world".length);
  assert.ok(collected.marks[1]!.at_ms >= collected.marks[0]!.at_ms);
});

test("parseSseStream records block offsets that join against chunk marks", () => {
  const block1 = 'data: {"n":1}\n\n';
  const block2 = 'data: {"n":2}\n\n';
  const events = parseSseStream(block1 + block2);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.offset, 0);
  assert.equal(events[1]!.offset, block1.length);

  // Simulate two chunks arriving 100ms apart, one block per chunk:
  const marks = [
    { at_ms: 3, upto: block1.length },
    { at_ms: 103, upto: block1.length + block2.length },
  ];
  assert.equal(timeAtOffset(marks, events[0]!.offset), 3);
  assert.equal(timeAtOffset(marks, events[1]!.offset), 103);
});

test("timeAtOffset is undefined with no marks or past-the-end offsets", () => {
  assert.equal(timeAtOffset([], 0), undefined);
  assert.equal(timeAtOffset([{ at_ms: 5, upto: 10 }], 10), undefined);
});
