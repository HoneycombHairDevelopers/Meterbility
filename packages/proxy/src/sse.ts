/**
 * SSE reassembly helpers.
 *
 * Each provider streams differently, but they all share two needs from
 * the proxy:
 *
 *   1. **Tee** the upstream stream — the client must see chunks as soon
 *      as they arrive (don't buffer the whole thing or we break UX).
 *   2. **Buffer** a copy for our own reassembly so we can emit a single
 *      Step row with the complete final Message after the stream ends.
 *
 * `teeAndCollect` returns two ReadableStreams: one to hand back to the
 * client, one we read ourselves and pass to a provider-specific parser.
 *
 * `collectSseEvents` reads SSE-framed text and yields parsed events
 * (`{ event, data }` where data is JSON-decoded if possible).
 */

export interface SseEvent {
  event?: string;
  data: unknown;
  /** Raw `data:` payload before JSON parse — preserved for debugging. */
  raw: string;
}

/**
 * Split an upstream Response body into two streams. Returns:
 *   - `clientStream`: pass back to the original caller via Hono's response.
 *   - `capturePromise`: resolves to the full collected text once upstream finishes.
 *
 * The `capturePromise` never blocks the client stream — if the consumer
 * downstream errors before reading everything, we still finish reading
 * for capture purposes (best-effort).
 */
export function teeAndCollect(
  source: ReadableStream<Uint8Array>,
): { clientStream: ReadableStream<Uint8Array>; capturePromise: Promise<string> } {
  const [a, b] = source.tee();
  const decoder = new TextDecoder();
  const capturePromise = (async () => {
    const reader = b.getReader();
    let collected = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) collected += decoder.decode(value, { stream: true });
      }
      collected += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return collected;
  })();
  return { clientStream: a, capturePromise };
}

/**
 * Parse SSE-framed text (per the WHATWG spec subset both Anthropic and
 * OpenAI use): events are separated by blank lines, each event has zero
 * or more `field: value` lines. We keep `event:` and `data:`. Multi-line
 * `data:` is concatenated with `\n`. JSON-parse the result if it looks
 * like JSON; otherwise pass the raw string through.
 */
export function parseSseStream(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    if (raw === "[DONE]") {
      events.push({ event: eventName, data: "[DONE]", raw });
      continue;
    }
    try {
      data = JSON.parse(raw);
    } catch {
      // not JSON — keep raw
    }
    events.push({ event: eventName, data, raw });
  }
  return events;
}
