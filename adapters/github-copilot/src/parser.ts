import { readFile } from "node:fs/promises";
import type { CopilotEvent } from "./types.ts";

/**
 * Read a Copilot CLI events.jsonl file and return parsed events with
 * byte offsets preserved. Same contract as the claude-code parser:
 * malformed lines are skipped with a warning (the CLI can write partial
 * lines on crash), and the offset feeds `ingest_progress` — which for
 * this adapter is a CHANGE DETECTOR only. Any growth triggers a whole-
 * file re-read and re-carve (design doc: "Incremental ingest = change
 * detection, not partial parse"), so carve state never persists across
 * ingests and mid-band resume is a non-problem.
 */
export interface ParsedEvent {
  event: CopilotEvent;
  offset: number;
  length: number;
}

export async function readEvents(path: string): Promise<ParsedEvent[]> {
  const buf = await readFile(path);
  return parseEventsBuffer(buf);
}

export function parseEventsBuffer(buf: Buffer): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let lineStart = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      const line = buf.subarray(lineStart, i).toString("utf-8").trim();
      if (line.length > 0) {
        try {
          const event = JSON.parse(line) as CopilotEvent;
          events.push({
            event,
            offset: lineStart,
            length: i - lineStart + (i < buf.length ? 1 : 0),
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[meter] skipping malformed events.jsonl line at offset ${lineStart}: ${(err as Error).message}`,
          );
        }
      }
      lineStart = i + 1;
    }
  }
  return events;
}
