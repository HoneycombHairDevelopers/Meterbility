import type { CursorDb } from "./parser.ts";
import { FILE_TOOLS } from "./file_changes.ts";

/**
 * Shape probe — Cursor changes its cursorDiskKV schema without notice,
 * and until 2026-10-13 nothing here noticed: the fixture tests pinned a
 * shape from one capture while real data silently degraded (content-id
 * prefix drift, `status: "error"`, absolute `relativeWorkspacePath`).
 *
 * The probe walks the composers the adapter would ingest and reports
 * every vocabulary value the adapter has no opinion about. The corpus
 * test pins the report against a real (redacted) capture, so a Cursor
 * upgrade that introduces a new tool name, status, or result key shows
 * up as a test diff instead of as zero-line file_change rows.
 *
 * Everything reported is DATA from the user's Cursor database.
 */

export interface CursorShapeReport {
  composers: number;
  bubbles: number;
  /** Tool names the file-change extractor derives nothing from. */
  tool_names_without_file_changes: string[];
  /** toolFormerData.status values ingest.ts does not map. */
  unknown_tool_statuses: string[];
  /** composerData.status values composerStatus() maps to in_progress by default. */
  unknown_composer_statuses: string[];
  /** fullConversationHeadersOnly[].type values other than 1 (user) / 2 (assistant). */
  unknown_bubble_types: number[];
  /** `<tool>.<key>` for result keys on file-tool bubbles the extractor does not read. */
  unread_file_tool_result_keys: string[];
}

const KNOWN_TOOL_STATUSES = new Set(["completed", "error", "errored", "pending"]);
const KNOWN_COMPOSER_STATUSES = new Set([
  "completed",
  "error",
  "errored",
  "abandoned",
]);
const KNOWN_BUBBLE_TYPES = new Set([1, 2]);
const READ_RESULT_KEYS: Record<string, Set<string>> = {
  edit_file_v2: new Set(["beforeContentId", "afterContentId", "isNewlyCreated"]),
  search_replace: new Set(["diff"]),
  write: new Set(["diff"]),
  delete_file: new Set(),
};

export function probeCursorShapes(
  cursor: CursorDb,
  composerIds?: string[],
): CursorShapeReport {
  const toolNames = new Set<string>();
  const toolStatuses = new Set<string>();
  const composerStatuses = new Set<string>();
  const bubbleTypes = new Set<number>();
  const resultKeys = new Set<string>();
  let bubbles = 0;

  const composers = cursor
    .listComposers()
    .filter((c) => !composerIds || composerIds.includes(c.composerId));
  for (const comp of composers) {
    if (typeof comp.status === "string" && !KNOWN_COMPOSER_STATUSES.has(comp.status)) {
      composerStatuses.add(comp.status);
    }
    for (const h of comp.fullConversationHeadersOnly ?? []) {
      if (typeof h.type === "number" && !KNOWN_BUBBLE_TYPES.has(h.type)) {
        bubbleTypes.add(h.type);
      }
    }
    for (const bubble of cursor.iterBubbles(comp)) {
      bubbles += 1;
      const tf = bubble.toolFormerData;
      if (!tf) continue;
      if (typeof tf.status === "string" && !KNOWN_TOOL_STATUSES.has(tf.status)) {
        toolStatuses.add(tf.status);
      }
      if (typeof tf.name !== "string") continue;
      if (!FILE_TOOLS.has(tf.name)) {
        toolNames.add(tf.name);
        continue;
      }
      const result = parseMaybeJson(tf.result);
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const known = READ_RESULT_KEYS[tf.name] ?? new Set();
        for (const k of Object.keys(result)) {
          if (!known.has(k)) resultKeys.add(`${tf.name}.${k}`);
        }
      }
    }
  }

  return {
    composers: composers.length,
    bubbles,
    tool_names_without_file_changes: [...toolNames].sort(),
    unknown_tool_statuses: [...toolStatuses].sort(),
    unknown_composer_statuses: [...composerStatuses].sort(),
    unknown_bubble_types: [...bubbleTypes].sort((a, b) => a - b),
    unread_file_tool_result_keys: [...resultKeys].sort(),
  };
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
