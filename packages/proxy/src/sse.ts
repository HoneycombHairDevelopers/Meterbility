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
 * The collected copy carries per-chunk arrival marks so the dialect
 * reassemblers can recover time-to-first-token — the tee is the only
 * place chunk timing exists; once the text is buffered it's gone.
 *
 * `parseSseStream` reads SSE-framed text and yields parsed events
 * (`{ event, data }` where data is JSON-decoded if possible), each with
 * its character offset into the collected text so events can be joined
 * back to the arrival marks.
 */

export interface SseEvent {
  event?: string;
  data: unknown;
  /** Raw `data:` payload before JSON parse — preserved for debugging. */
  raw: string;
  /** Character offset of this event's block in the collected text —
   *  join key against `ChunkMark.upto` for arrival timing. */
  offset: number;
}

/** One network chunk's arrival, relative to tee start (≈ response headers). */
export interface ChunkMark {
  /** ms since the tee started when this chunk arrived. */
  at_ms: number;
  /** Cumulative collected-text length AFTER appending this chunk. */
  upto: number;
}

export interface CollectedStream {
  text: string;
  marks: ChunkMark[];
}

/**
 * Split an upstream Response body into two streams. Returns:
 *   - `clientStream`: pass back to the original caller via Hono's response.
 *   - `capturePromise`: resolves to the full collected text + per-chunk
 *     arrival marks once upstream finishes.
 *
 * The `capturePromise` never blocks the client stream — if the consumer
 * downstream errors before reading everything, we still finish reading
 * for capture purposes (best-effort).
 */
export function teeAndCollect(
  source: ReadableStream<Uint8Array>,
): { clientStream: ReadableStream<Uint8Array>; capturePromise: Promise<CollectedStream> } {
  const [a, b] = source.tee();
  const decoder = new TextDecoder();
  const t0 = Date.now();
  const capturePromise = (async () => {
    const reader = b.getReader();
    let collected = "";
    const marks: ChunkMark[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          collected += decoder.decode(value, { stream: true });
          marks.push({ at_ms: Date.now() - t0, upto: collected.length });
        }
      }
      collected += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return { text: collected, marks };
  })();
  return { clientStream: a, capturePromise };
}

/**
 * ms-since-tee-start at which the character at `offset` had arrived —
 * the first mark whose cumulative length covers it. Undefined when the
 * marks can't answer (no marks, or offset past the collected text —
 * a caller bug, not a timing of 0).
 */
export function timeAtOffset(marks: ChunkMark[], offset: number): number | undefined {
  for (const m of marks) {
    if (m.upto > offset) return m.at_ms;
  }
  return undefined;
}

/**
 * Parse SSE-framed text (per the WHATWG spec subset both Anthropic and
 * OpenAI use): events are separated by blank lines, each event has zero
 * or more `field: value` lines. We keep `event:` and `data:`. Multi-line
 * `data:` is concatenated with `\n`. JSON-parse the result if it looks
 * like JSON; otherwise pass the raw string through. Each event records
 * the offset of its block so arrival timing can be recovered via
 * `timeAtOffset`.
 */
export function parseSseStream(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const sep = /\r?\n\r?\n/g;
  let blockStart = 0;
  const blocks: Array<{ block: string; offset: number }> = [];
  for (;;) {
    const m = sep.exec(text);
    if (!m) {
      blocks.push({ block: text.slice(blockStart), offset: blockStart });
      break;
    }
    blocks.push({ block: text.slice(blockStart, m.index), offset: blockStart });
    blockStart = m.index + m[0].length;
  }
  for (const { block, offset } of blocks) {
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
      events.push({ event: eventName, data: "[DONE]", raw, offset });
      continue;
    }
    try {
      data = JSON.parse(raw);
    } catch {
      // not JSON — keep raw
    }
    events.push({ event: eventName, data, raw, offset });
  }
  return events;
}
