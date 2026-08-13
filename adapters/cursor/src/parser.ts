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
      // The header key is the identity we fetched by — trust it over
      // whatever bubbleId the payload claims, so a corrupt row can't
      // impersonate another turn.
      if (b) yield { ...b, bubbleId: h.bubbleId };
    }
  }

  /** Raw KV read — used for content blobs, fate ledgers, checkpoints. */
  getRawKV(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(key) as { value: string | null } | undefined;
    return row?.value ?? undefined;
  }

  /**
   * Full before/after file bodies for edit_file_v2, stored content-
   * addressed under `composer.content.<id>`. Values are the raw file
   * text (occasionally JSON-quoted — unwrap when it round-trips).
   */
  getContentBlob(contentId: string): string | undefined {
    const raw = this.getRawKV(`composer.content.${contentId}`);
    if (raw === undefined) return undefined;
    if (raw.startsWith('"')) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string") return parsed;
      } catch {
        // fall through — treat as plain text
      }
    }
    return raw;
  }

  /**
   * composer → workspace link from the `composerHeaders` relational
   * table (the authoritative mapping; epoch-ms ids belong to ephemeral
   * windows with no folder and return undefined downstream).
   */
  workspaceIdForComposer(composerId: string): string | undefined {
    const hasTable = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='composerHeaders'",
      )
      .get();
    if (!hasTable) return undefined;
    const row = this.db
      .prepare("SELECT workspaceId FROM composerHeaders WHERE composerId = ?")
      .get(composerId) as { workspaceId: string | null } | undefined;
    return row?.workspaceId ?? undefined;
  }

  /**
   * Materialize one composer's conversation — envelope plus bubbles —
   * inside a single read transaction, so the result is one consistent
   * snapshot of Cursor's db rather than a state that never existed.
   *
   * `iterBubbles` issues an independent SELECT per bubble; Cursor can
   * commit between any two of them, tearing the view (bubble N from
   * the old conversation, bubble N+1 from the new one). Cursor runs
   * WAL mode, so a read transaction on this readonly connection pins
   * the snapshot for its duration without blocking Cursor's writer —
   * verified empirically against better-sqlite3 (its `.transaction()`
   * wraps in plain deferred BEGIN/COMMIT, both legal read-only).
   *
   * The envelope is re-fetched inside the same transaction so headers
   * and bubbles agree; if the fresh row vanished or no longer parses
   * as a meaningful composer (wiped mid-tick), we keep the caller's
   * envelope — its headers then point at bubbles the snapshot can't
   * see, which downstream torn-read guards treat as a skip, never as
   * a rewind.
   */
  readComposerSnapshot(composer: CursorComposerData): {
    composer: CursorComposerData;
    bubbles: CursorBubble[];
  } {
    const read = this.db.transaction(
      (c: CursorComposerData) => {
        const fresh = this.getComposer(c.composerId);
        const envelope = fresh && isMeaningfulComposer(fresh) ? fresh : c;
        return { composer: envelope, bubbles: [...this.iterBubbles(envelope)] };
      },
    );
    return read(composer);
  }

  /** List cursorDiskKV keys under a prefix (checkpoints, fates, ...). */
  listKeysByPrefix(prefix: string): string[] {
    const rows = this.db
      .prepare("SELECT key FROM cursorDiskKV WHERE key LIKE ? ORDER BY key")
      .all(prefix + "%") as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  /**
   * Read a value from the ItemTable (VS Code-style key/value store —
   * home of aiCodeTrackingLines). Guarded: fixtures and future Cursor
   * versions may not have the table.
   */
  getItemTable(key: string): string | undefined {
    const hasTable = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'",
      )
      .get();
    if (!hasTable) return undefined;
    const row = this.db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(key) as { value: string | Buffer | null } | undefined;
    if (!row || row.value == null) return undefined;
    return typeof row.value === "string" ? row.value : row.value.toString("utf-8");
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
