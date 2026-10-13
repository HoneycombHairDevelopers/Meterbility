/**
 * Shape probe — Codex rollout drift detector.
 *
 * Codex CLI's rollout JSONL is undocumented and moves between releases.
 * The adapter once listened for `event_msg/patch_apply_end`, a payload
 * that no rollout from CLI 0.130–0.142 contains; the real file-change
 * event is `event_msg/item_completed` with `item.type === "FileChange"`.
 * That drift was invisible because unknown kinds were skipped silently.
 *
 * This probe counts the kinds the adapter does not know about — record
 * envelopes, `response_item` payload types, `event_msg` payload types,
 * and `item_completed` item types — dedupes them per kind, and logs
 * each once per process so a new type shows up in the ingest log the
 * first time it appears instead of never. Best-effort: never throws.
 *
 * Adding a new known type: extend the matching set below (and handle
 * it in ingest.ts if it carries step or file-change material).
 */

import type { CodexRecord } from "./types.ts";

/** Observed across the local corpus (2026-08 → 2026-10) + handled kinds. */
export const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set([
  "session_meta",
  "turn_context",
  "response_item",
  "event_msg",
]);

export const KNOWN_RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "web_search_call",
]);

export const KNOWN_EVENT_MSG_TYPES: ReadonlySet<string> = new Set([
  "item_started",
  "item_completed",
  "task_started",
  "task_complete",
  "token_count",
  "thread_settings_applied",
  "agent_message",
  "agent_reasoning",
  // Legacy write-mode envelope (pre-0.130); kept for additive support.
  "patch_apply_begin",
  "patch_apply_end",
]);

export const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set([
  "AgentMessage",
  "UserMessage",
  "Reasoning",
  "CommandExecution",
  "FileChange",
  "WebSearch",
  "McpToolCall",
  "EnteredReviewMode",
  "ExitedReviewMode",
]);

export type CodexDriftKind =
  | "record"
  | "response_item"
  | "event_msg"
  | "item_completed";

export interface CodexShapeWarning {
  /** Which discriminator was unknown. */
  kind: CodexDriftKind;
  /** The unknown discriminator value (or "<missing>"). */
  typeName: string;
  /** Dedupe key: `${kind}:${typeName}`. */
  driftKey: string;
  /** Records sharing this key in the probed batch. */
  count: number;
  /** Top-level keys of the first offending payload — the shape hint. */
  exampleKeys: string[];
}

/** Keys already logged in this process; live ticks must not re-log. */
const reportedInProcess = new Set<string>();

/** Test seam: forget what has been logged so far. */
export function resetCodexDriftLog(): void {
  reportedInProcess.clear();
}

export class CodexShapeProbe {
  private readonly warnings = new Map<string, CodexShapeWarning>();

  probe(record: unknown): void {
    try {
      this.probeInner(record);
    } catch {
      // Never let diagnostics break ingest.
    }
  }

  private probeInner(record: unknown): void {
    if (typeof record !== "object" || record === null) {
      this.note("record", "<non-object>", []);
      return;
    }
    const r = record as Partial<CodexRecord> & Record<string, unknown>;
    const type = typeof r.type === "string" ? r.type : "<missing>";
    if (!KNOWN_RECORD_TYPES.has(type)) {
      this.note("record", type, Object.keys(r));
      return;
    }
    const payload = r.payload as Record<string, unknown> | undefined;
    if (typeof payload !== "object" || payload === null) return;
    const ptype =
      typeof payload.type === "string" ? payload.type : "<missing>";

    if (type === "response_item") {
      if (!KNOWN_RESPONSE_ITEM_TYPES.has(ptype)) {
        this.note("response_item", ptype, Object.keys(payload));
      }
      return;
    }
    if (type === "event_msg") {
      if (!KNOWN_EVENT_MSG_TYPES.has(ptype)) {
        this.note("event_msg", ptype, Object.keys(payload));
        return;
      }
      if (ptype === "item_completed") {
        const item = payload.item as Record<string, unknown> | undefined;
        const itype =
          typeof item === "object" && item !== null && typeof item.type === "string"
            ? item.type
            : "<missing>";
        if (!KNOWN_ITEM_TYPES.has(itype)) {
          this.note(
            "item_completed",
            itype,
            typeof item === "object" && item !== null ? Object.keys(item) : [],
          );
        }
      }
    }
  }

  private note(kind: CodexDriftKind, typeName: string, keys: string[]): void {
    const driftKey = `${kind}:${typeName}`;
    const existing = this.warnings.get(driftKey);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.warnings.set(driftKey, {
      kind,
      typeName,
      driftKey,
      count: 1,
      exampleKeys: keys.slice().sort(),
    });
  }

  results(): CodexShapeWarning[] {
    return [...this.warnings.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * Log each warning to stderr, once per drift key per process. Later
   * ingests (live ticks, other sessions) only bump counts silently.
   */
  report(sessionLabel: string): void {
    for (const w of this.results()) {
      if (reportedInProcess.has(w.driftKey)) continue;
      reportedInProcess.add(w.driftKey);
      // eslint-disable-next-line no-console
      console.warn(formatCodexWarning(w, sessionLabel));
    }
  }
}

export function formatCodexWarning(
  w: CodexShapeWarning,
  sessionLabel: string,
): string {
  return (
    `[meter] codex shape drift in ${sessionLabel}: unknown ${w.kind} type=${w.typeName}` +
    (w.exampleKeys.length > 0 ? ` keys=[${w.exampleKeys.join(",")}]` : "") +
    ` ×${w.count}`
  );
}

/** One-shot probe over parsed records (CI / fixture harness path). */
export function probeCodexRecords(
  records: ReadonlyArray<unknown>,
): CodexShapeWarning[] {
  const probe = new CodexShapeProbe();
  for (const r of records) probe.probe(r);
  return probe.results();
}
