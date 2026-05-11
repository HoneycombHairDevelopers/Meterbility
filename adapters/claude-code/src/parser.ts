import { readFile } from "node:fs/promises";
import type { ClaudeRecord } from "./types.ts";

/**
 * Read a Claude Code session JSONL file from disk and return the parsed
 * records. Lines that fail to parse are dropped with a warning so a single
 * corrupted line can't break an entire session ingest. The line offset
 * (bytes from start) is preserved for incremental resume.
 */
export interface ParsedRecord {
  record: ClaudeRecord;
  offset: number;
  length: number;
}

export async function readSession(path: string): Promise<ParsedRecord[]> {
  const buf = await readFile(path);
  return parseBuffer(buf);
}

export async function readSessionFromOffset(
  path: string,
  startOffset: number,
): Promise<ParsedRecord[]> {
  const buf = await readFile(path);
  return parseBuffer(buf, startOffset);
}

export function parseBuffer(
  buf: Buffer,
  startOffset = 0,
): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  let offset = startOffset;
  // Find the start of the next newline-aligned record after startOffset.
  // If startOffset points mid-line (shouldn't normally), advance.
  if (startOffset > 0) {
    while (offset < buf.length && buf[offset - 1] !== 0x0a) offset += 1;
  }
  let lineStart = offset;
  for (let i = offset; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      const line = buf.subarray(lineStart, i).toString("utf-8").trim();
      if (line.length > 0) {
        try {
          const record = JSON.parse(line) as ClaudeRecord;
          records.push({
            record,
            offset: lineStart,
            length: i - lineStart + (i < buf.length ? 1 : 0),
          });
        } catch (err) {
          // Skip malformed lines — Claude Code occasionally writes partial
          // lines on crash. We log to stderr so it's visible but not fatal.
          // eslint-disable-next-line no-console
          console.warn(
            `[spool] skipping malformed JSONL at offset ${lineStart}: ${(err as Error).message}`,
          );
        }
      }
      lineStart = i + 1;
    }
  }
  return records;
}

/**
 * The byte offset just past the last record we successfully parsed. Used
 * to checkpoint into `ingest_progress` so the next ingest of the same
 * file picks up where we left off.
 */
export function endOffset(records: ParsedRecord[], fallback = 0): number {
  if (records.length === 0) return fallback;
  const last = records[records.length - 1]!;
  return last.offset + last.length;
}
