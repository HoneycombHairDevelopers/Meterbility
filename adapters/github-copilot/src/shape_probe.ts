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
  // Observed in real Copilot CLI sessions (2026-10): a skill file was
  // loaded into the conversation (data.{name, path, source, trigger,
  // content, allowedTools, description, model}). No step.
  "skill.invoked",
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
    if (missing.length > 0 || unknown) {
      const note = unknown ? "unknown event type" : undefined;
      this.record(eventType, missing, note);
    }
    this.probeFields(event, eventType);
  }

  /**
   * Payload-shape checks for the fields the carver reads beyond the
   * envelope (file-change fidelity depends on them). Each check is a
   * "present but not the shape we parse" test — absent fields are
   * legal (older CLIs), wrong-typed ones are drift. One deduped
   * warning per (type, note).
   */
  private probeFields(event: CopilotEvent, eventType: string): void {
    const d = event.data;
    if (!d || typeof d !== "object") return;
    const note = (n: string) => this.record(eventType, [], n);
    if (eventType === "tool.execution_start") {
      if (
        typeof d.toolName !== "string" &&
        typeof d.name !== "string" &&
        typeof d.tool !== "string"
      ) {
        note("tool.execution_start carries no tool name");
      }
      const args = d.arguments ?? d.input ?? d.args;
      if (args !== undefined && (args === null || typeof args !== "object")) {
        note("tool arguments is not an object");
      }
      if (d.shellToolInfo !== undefined) {
        const sti = d.shellToolInfo as Record<string, unknown> | null;
        if (
          sti === null ||
          typeof sti !== "object" ||
          (sti.possiblePaths !== undefined && !Array.isArray(sti.possiblePaths)) ||
          (sti.hasWriteFileRedirection !== undefined &&
            typeof sti.hasWriteFileRedirection !== "boolean")
        ) {
          note("shellToolInfo is not {possiblePaths[], hasWriteFileRedirection}");
        }
      }
    } else if (eventType === "tool.execution_complete") {
      if (d.success !== undefined && typeof d.success !== "boolean") {
        note("success is not a boolean");
      }
      const r = d.result;
      if (r !== undefined && r !== null) {
        if (typeof r !== "string" && typeof r !== "object") {
          note("result is neither string nor object");
        } else if (typeof r === "object") {
          const obj = r as Record<string, unknown>;
          if (obj.content !== undefined && typeof obj.content !== "string") {
            note("result.content is not a string");
          }
          if (
            obj.detailedContent !== undefined &&
            typeof obj.detailedContent !== "string"
          ) {
            note("result.detailedContent is not a string");
          }
        }
      }
      if (d.error !== undefined && d.error !== null && d.success !== false) {
        note("error present on a completion not marked success:false");
      }
    } else if (eventType === "session.shutdown") {
      const cc = d.codeChanges;
      if (cc !== undefined) {
        const obj = cc as Record<string, unknown> | null;
        if (
          obj === null ||
          typeof obj !== "object" ||
          (obj.linesAdded !== undefined && typeof obj.linesAdded !== "number") ||
          (obj.linesRemoved !== undefined && typeof obj.linesRemoved !== "number") ||
          (obj.filesModified !== undefined && !Array.isArray(obj.filesModified))
        ) {
          note("codeChanges is not {linesAdded, linesRemoved, filesModified[]}");
        }
      }
    }
    if (event.agentId !== undefined && typeof event.agentId !== "string") {
      note("envelope agentId is not a string");
    }
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
