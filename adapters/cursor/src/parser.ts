import Database from "better-sqlite3";
import type {
  CursorBubble,
  CursorComposerData,
  CursorConversationHeader,
} from "./types.ts";

/**
 * Read-only SQLite client for Cursor's `state.vscdb`. We always open
 * with `readonly: true` and `fileMustExist: true` so we cannot
 * accidentally mutate Cursor's state.
 */
export class CursorDb {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.db.close();
  }

  /**
   * Fetch every composerId we can see in cursorDiskKV. Returns the
   * envelopes (without bubble bodies) for cheap iteration.
   */
  listComposers(): CursorComposerData[] {
    const rows = this.db
      .prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
      )
      .all() as Array<{ key: string; value: string }>;
    const out: CursorComposerData[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value);
        // Cursor stores literal "null" rows for composers it has wiped.
        // Skip anything without a composerId so downstream code can
        // assume the field exists.
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.composerId === "string"
        ) {
          out.push(parsed as CursorComposerData);
        }
      } catch {
        // Skip malformed entries — Cursor occasionally writes partial JSON
        // mid-update; we'll pick the row up next time.
      }
    }
    return out;
  }

  getComposer(composerId: string): CursorComposerData | undefined {
    const row = this.db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${composerId}`) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as CursorComposerData;
    } catch {
      return undefined;
    }
  }

  getBubble(
    composerId: string,
    bubbleId: string,
  ): CursorBubble | undefined {
    const row = this.db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`bubbleId:${composerId}:${bubbleId}`) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as CursorBubble;
    } catch {
      return undefined;
    }
  }

  /**
   * Walk the conversation in canonical order, returning bubbles in the
   * order Cursor records in `fullConversationHeadersOnly`. Missing
   * bubbles (deleted, or written-but-not-flushed) are skipped.
   */
  *iterBubbles(composer: CursorComposerData): Iterable<CursorBubble> {
    const headers = composer.fullConversationHeadersOnly ?? [];
    for (const h of headers) {
      const b = this.getBubble(composer.composerId, h.bubbleId);
      if (b) yield b;
    }
  }

  /** Schema sanity check — used by doctor and tests. */
  hasCursorDiskKV(): boolean {
    const r = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'",
      )
      .get();
    return r !== undefined;
  }

  /** Total number of cursorDiskKV rows by prefix; useful for diagnostics. */
  prefixCounts(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT substr(key, 1, instr(key, ':') - 1) AS prefix, COUNT(*) AS n FROM cursorDiskKV GROUP BY prefix",
      )
      .all() as Array<{ prefix: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.prefix] = r.n;
    return out;
  }
}

export function headerCount(c: CursorComposerData): number {
  return (c.fullConversationHeadersOnly ?? []).length;
}

export function isMeaningfulComposer(c: CursorComposerData): boolean {
  // Skip empty placeholder composers Cursor creates on launch.
  if (!c || typeof c !== "object") return false;
  if (typeof c.composerId !== "string") return false;
  return headerCount(c) > 0 && (c.text !== undefined || c.name !== undefined);
}

export function _conversationHeader(
  c: CursorComposerData,
  bubbleId: string,
): CursorConversationHeader | undefined {
  return (c.fullConversationHeadersOnly ?? []).find(
    (h) => h.bubbleId === bubbleId,
  );
}
