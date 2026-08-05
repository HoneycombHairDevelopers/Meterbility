import { createHash } from "node:crypto";

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable JSON serialization for content addressing. Sorts object keys so
 * the same logical value always hashes identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, sortReplacer);
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Shape of ids minted by deterministicStepId — distinguishes them from
 *  legacy randomUUID-based ids (hyphenated), which predate deterministic
 *  ids. */
export const DETERMINISTIC_STEP_ID_RE = /^stp_[0-9a-f]{32}$/;

/**
 * Deterministic step id for an ingest unit: the same (runId, key) pair
 * always yields the same id, so re-ingest upserts existing rows instead
 * of appending duplicates. The format (`stp_` + first 32 hex chars of
 * hashJson([runId, key])) is load-bearing — existing databases store
 * these ids byte-for-byte, so it must never change.
 */
export function deterministicStepId(runId: string, key: string): string {
  return `stp_${hashJson([runId, key]).slice(0, 32)}`;
}
