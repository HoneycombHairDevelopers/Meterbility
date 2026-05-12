import { readFile } from "node:fs/promises";
import type { CodexRecord } from "./types.ts";

export interface ParsedCodexRecord {
  record: CodexRecord;
  offset: number;
  length: number;
}

export async function readCodexSession(
  path: string,
  startOffset = 0,
): Promise<ParsedCodexRecord[]> {
  const buf = await readFile(path);
  return parseBuffer(buf, startOffset);
}

export function parseBuffer(
  buf: Buffer,
  startOffset = 0,
): ParsedCodexRecord[] {
  const records: ParsedCodexRecord[] = [];
  let offset = startOffset;
  if (startOffset > 0) {
    while (offset < buf.length && buf[offset - 1] !== 0x0a) offset += 1;
  }
  let lineStart = offset;
  for (let i = offset; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      const line = buf.subarray(lineStart, i).toString("utf-8").trim();
      if (line.length > 0) {
        try {
          records.push({
            record: JSON.parse(line) as CodexRecord,
            offset: lineStart,
            length: i - lineStart + (i < buf.length ? 1 : 0),
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[spool/codex] skipping malformed JSONL at ${lineStart}: ${(err as Error).message}`,
          );
        }
      }
      lineStart = i + 1;
    }
  }
  return records;
}

export function endOffset(records: ParsedCodexRecord[], fallback = 0): number {
  if (records.length === 0) return fallback;
  const last = records[records.length - 1]!;
  return last.offset + last.length;
}
