import { randomUUID } from "node:crypto";
import { sha256 } from "@spool/shared";
import type { ParsedRequest } from "./types.ts";

/**
 * Conversation-continuity Run grouping.
 *
 * The proxy gets one HTTP request per "step." We need to decide whether
 * each request belongs to a brand-new Run or extends an existing one.
 *
 * Heuristic (matches how the Claude Code JSONL adapter groups sessions):
 *
 *   1. **Explicit grouping wins.** If the client sent
 *      `x-spool-run-id: <id>` (e.g. via SPOOL_RUN_ID injection from
 *      `spool run`), use it. This is the cleanest signal and skips the
 *      rest of the heuristic.
 *
 *   2. **Conversation seed.** Hash the first user message + the system
 *      prompt + the model name. This becomes the "seed" key.
 *
 *   3. **Sliding window.** Keep an in-memory map of seed → run_id +
 *      messages_count + last_seen. If the same seed shows up within
 *      `WINDOW_SECONDS` and the new request's history strictly extends
 *      the prior one (more messages), append to the existing run.
 *
 *   4. **Else, new Run.** Mint a fresh run_id, register it under the seed.
 *
 * This is intentionally simple — over-merging is preferable to
 * over-splitting because a user can always fork a step out into its
 * own Run via the web UI's "split" action (TODO). Under-merging would
 * fragment a single conversation across N rows, which is much harder to
 * recover from.
 */

const WINDOW_SECONDS = 30 * 60; // 30 minutes
const MAX_ENTRIES = 1024;

interface GroupEntry {
  run_id: string;
  step_count: number;
  last_messages_count: number;
  last_seen_ms: number;
  /**
   * Map of tool_use_id → { step_id, sequence } for the most recent
   * tool_call action in this Run that hasn't seen its tool_result yet.
   * Used by retro-attach (proxy server consults this when a request
   * comes in with `pendingToolResults`).
   */
  pending_tool_calls: Map<string, { step_id: string; sequence: number }>;
}

export class RunGrouper {
  private entries = new Map<string, GroupEntry>();

  /**
   * Decide what Run this request belongs to.
   * @returns the run id and whether it's new (caller will insert a Run row).
   */
  resolve(
    parsed: ParsedRequest,
    explicitRunId: string | undefined,
    nowMs: number,
  ): { run_id: string; is_new: boolean; step_sequence: number; entry: GroupEntry } {
    if (explicitRunId) {
      const existing = this.entries.get(explicitRunId);
      if (existing) {
        existing.step_count += 1;
        existing.last_messages_count = parsed.history.length;
        existing.last_seen_ms = nowMs;
        return {
          run_id: existing.run_id,
          is_new: false,
          step_sequence: existing.step_count - 1,
          entry: existing,
        };
      }
      const fresh = this._fresh(explicitRunId, parsed.history.length, nowMs);
      this.entries.set(explicitRunId, fresh);
      return { run_id: fresh.run_id, is_new: true, step_sequence: 0, entry: fresh };
    }

    const seed = this._seed(parsed);
    const existing = this.entries.get(seed);
    if (
      existing &&
      nowMs - existing.last_seen_ms < WINDOW_SECONDS * 1000 &&
      parsed.history.length >= existing.last_messages_count
    ) {
      existing.step_count += 1;
      existing.last_messages_count = parsed.history.length;
      existing.last_seen_ms = nowMs;
      return {
        run_id: existing.run_id,
        is_new: false,
        step_sequence: existing.step_count - 1,
        entry: existing,
      };
    }
    const run_id = `run_${randomUUID()}`;
    const fresh = this._fresh(run_id, parsed.history.length, nowMs);
    this.entries.set(seed, fresh);
    this._evictIfNeeded();
    return { run_id, is_new: true, step_sequence: 0, entry: fresh };
  }

  /** For tests + admin endpoints. */
  size(): number {
    return this.entries.size;
  }

  private _fresh(run_id: string, messagesCount: number, nowMs: number): GroupEntry {
    return {
      run_id,
      step_count: 1,
      last_messages_count: messagesCount,
      last_seen_ms: nowMs,
      pending_tool_calls: new Map(),
    };
  }

  private _seed(parsed: ParsedRequest): string {
    // Use the first user message as the seed signal — that's the bit that
    // stays constant across a multi-turn conversation. Add the model so
    // two parallel agents started with the same prompt against different
    // models don't collide.
    const firstUser = parsed.history.find((m) => m.role === "user")?.content ?? "";
    return sha256(`${parsed.model}\n${parsed.systemPrompt ?? ""}\n${firstUser}`);
  }

  private _evictIfNeeded(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    // Drop the oldest 10% by last_seen.
    const sorted = [...this.entries.entries()].sort(
      ([, a], [, b]) => a.last_seen_ms - b.last_seen_ms,
    );
    const dropCount = Math.floor(MAX_ENTRIES * 0.1);
    for (let i = 0; i < dropCount; i++) {
      this.entries.delete(sorted[i]![0]);
    }
  }
}

