import { randomUUID } from "node:crypto";
import { sha256 } from "@meterbility/shared";
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
 *      `x-meterbility-run-id: <id>` (SDKs and manual callers set it;
 *      `meter run` does not inject it today), use it. This is the
 *      cleanest signal and skips the rest of the heuristic. Explicit
 *      ids are provider-scoped: the same id sent through two different
 *      upstreams yields two Runs, keeping the one-provider-per-run
 *      invariant honest.
 *
 *   2. **Conversation seed.** Hash the provider name + the first user
 *      message + the system prompt + the model name. Provider is in the
 *      seed so identical prompts to the same model name through two
 *      different upstreams (an A/B comparison) land in distinct Runs.
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
  /** Provider that created this entry ("" when unknown). Explicit
   *  run-id entries are provider-scoped so one Run never mixes
   *  upstreams — the invariant Run.provider documents. */
  provider: string;
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
    provider?: string,
  ): { run_id: string; is_new: boolean; step_sequence: number; entry: GroupEntry } {
    const providerKey = provider ?? "";
    if (explicitRunId) {
      // Explicit ids are provider-scoped: the first provider to use an
      // id keeps the raw id as run_id (back compat); a DIFFERENT
      // provider reusing the same id gets its own Run under a scoped
      // key. Without this, one Run would mix upstreams while its
      // provider/upstream_host label claimed otherwise — the exact
      // "one provider per run" invariant Run.provider promises.
      let key = explicitRunId;
      let existing = this.entries.get(key);
      if (existing && existing.provider !== providerKey) {
        key = `${providerKey}\n${explicitRunId}`;
        existing = this.entries.get(key);
      }
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
      const run_id = key === explicitRunId ? explicitRunId : `run_${randomUUID()}`;
      const fresh = this._fresh(run_id, parsed.history.length, nowMs, providerKey);
      this.entries.set(key, fresh);
      this._evictIfNeeded();
      return { run_id: fresh.run_id, is_new: true, step_sequence: 0, entry: fresh };
    }

    const seed = this._seed(parsed, provider);
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
    const fresh = this._fresh(run_id, parsed.history.length, nowMs, providerKey);
    this.entries.set(seed, fresh);
    this._evictIfNeeded();
    return { run_id, is_new: true, step_sequence: 0, entry: fresh };
  }

  /** For tests + admin endpoints. */
  size(): number {
    return this.entries.size;
  }

  private _fresh(
    run_id: string,
    messagesCount: number,
    nowMs: number,
    provider: string,
  ): GroupEntry {
    return {
      run_id,
      provider,
      step_count: 1,
      last_messages_count: messagesCount,
      last_seen_ms: nowMs,
      pending_tool_calls: new Map(),
    };
  }

  private _seed(parsed: ParsedRequest, provider?: string): string {
    // Use the first user message as the seed signal — that's the bit that
    // stays constant across a multi-turn conversation. Add the model so
    // two parallel agents started with the same prompt against different
    // models don't collide, and the provider so the same model name via
    // two different upstreams doesn't either. The seed lives only in
    // memory, so the formula can change without a migration.
    const firstUser = parsed.history.find((m) => m.role === "user")?.content ?? "";
    return sha256(
      `${provider ?? ""}\n${parsed.model}\n${parsed.systemPrompt ?? ""}\n${firstUser}`,
    );
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

