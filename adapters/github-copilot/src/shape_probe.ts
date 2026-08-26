/**
 * Shape probe — Copilot CLI events.jsonl drift detector.
 *
 * The format is GitHub's undocumented private exhaust and the CLI moves
 * at alpha velocity; the probe is the day-one drift alarm the design
 * doc requires ("shape probe ships M1 — it protects the earliest
 * parser"). Same philosophy as the claude-code probe: best-effort,
 * never throws, dedupes findings by drift key so one drift produces one
 * warning instead of thousands. The carver keeps working via defensive
 * lookups; a warning is the signal to update `types.ts`.
 */

import type { CopilotEvent } from "./types.ts";

export interface CopilotShapeWarning {
  /** `event.type` of the divergent events (or "<missing>"). */
  eventType: string;
  /** Dedupe key: (eventType, sorted missing envelope keys, note). */
  driftKey: string;
  /** Envelope keys we require that the event lacks. */
  missingKeys: string[];
  /** Free-form drift note (unknown event type, unroutable parentId…). */
  note?: string;
  /** Number of events sharing this drift key. */
  count: number;
}

/** Event types the carver understands. Everything else is drift signal. */
export const KNOWN_EVENT_TYPES = new Set([
  "session.start",
  "session.resume",
  "session.info",
  "session.error",
  "session.model_change",
  "session.compaction_start",
  "session.compaction_end",
  "user.message",
  "assistant.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "tool.execution_start",
  "tool.execution_complete",
  "tool.user_requested",
  "subagent.started",
  "subagent.completed",
  // Observed in real Copilot CLI ≥1.0.80 sessions (2026-08-26):
  "session.auto_mode_resolved",
  "session.usage_checkpoint",
  "session.shutdown",
  "system.message",
  "system.notification",
  "subagent.selected",
]);

/** Envelope keys every event should carry per the observed format. */
const REQUIRED_ENVELOPE_KEYS = ["type", "timestamp"] as const;

export class CopilotShapeProbe {
  private warnings = new Map<string, CopilotShapeWarning>();

  probe(event: CopilotEvent): void {
    const eventType =
      typeof event.type === "string" && event.type.length > 0
        ? event.type
        : "<missing>";
    const missing = REQUIRED_ENVELOPE_KEYS.filter(
      (k) => (event as Record<string, unknown>)[k] === undefined,
    );
    const unknown =
      eventType !== "<missing>" &&
      !KNOWN_EVENT_TYPES.has(eventType) &&
      // compaction variants beyond start/end still count as known family
      !eventType.startsWith("session.compaction");
    if (missing.length === 0 && !unknown) return;
    const note = unknown ? "unknown event type" : undefined;
    this.record(eventType, missing, note);
  }

  noteUnrouted(eventType: string): void {
    // Per-type totals live on the deduped warning's `count`.
    this.record(eventType, [], "parentId matched no known event or sub-agent");
  }

  private record(
    eventType: string,
    missingKeys: readonly string[],
    note?: string,
  ): void {
    const driftKey = `${eventType}|${[...missingKeys].sort().join(",")}|${note ?? ""}`;
    const existing = this.warnings.get(driftKey);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.warnings.set(driftKey, {
      eventType,
      driftKey,
      missingKeys: [...missingKeys],
      note,
      count: 1,
    });
  }

  results(): CopilotShapeWarning[] {
    return [...this.warnings.values()];
  }

  /** Log every deduped warning to stderr. Never throws. */
  report(sessionLabel: string): void {
    for (const w of this.results()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[meter] copilot shape drift in ${sessionLabel}: type=${w.eventType}` +
          (w.missingKeys.length > 0 ? ` missing=[${w.missingKeys.join(",")}]` : "") +
          (w.note ? ` (${w.note})` : "") +
          ` ×${w.count}`,
      );
    }
  }
}

/** One-shot probe over a parsed event list (CI / fixture harness path). */
export function probeEvents(events: CopilotEvent[]): CopilotShapeWarning[] {
  const probe = new CopilotShapeProbe();
  for (const e of events) probe.probe(e);
  return probe.results();
}
