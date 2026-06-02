/**
 * File-size capture policy. Single source of truth for the 5MB / 50MB
 * thresholds per SPEC-V0_3 §11.1. Every adapter that captures files
 * MUST funnel through this helper before calling `insertFileChange`
 * so the policy is uniform — a future adapter (Codex, Cursor,
 * file-watcher) gets the gate for free.
 *
 * Policy (per SPEC-V0_3 §11.1):
 *
 *   ≤ max_partial_bytes (default 5 MB): full capture, both blobs kept,
 *     partial_diff = false.
 *   > max_partial_bytes AND ≤ max_skip_bytes: drop the LARGER side's
 *     buffer (keep the smaller for delta context), partial_diff = true.
 *   > max_skip_bytes: drop both buffers, redacted = true, emit a stub
 *     FileChange row that records the path + op + original sizes so
 *     the user knows something happened.
 *
 * Behaviour is pure (no I/O, no settings read inside the helper). The
 * adapter resolves settings once via `getSetting()` and passes the
 * resolved numbers in — per A7 "live-read per FileChange," settings
 * are read at the call site so a mid-run toggle takes effect on the
 * very next FileChange.
 */

export const DEFAULT_MAX_PARTIAL_BYTES = 5_000_000;
export const DEFAULT_MAX_SKIP_BYTES = 50_000_000;

export interface FileSizePolicySettings {
  /** Files at or under this size are captured in full. */
  max_partial_bytes?: number;
  /** Files at or under this size are partial-captured (larger blob dropped). */
  max_skip_bytes?: number;
}

export interface FileSizePolicyInput {
  beforeBuf?: Buffer;
  afterBuf?: Buffer;
  settings?: FileSizePolicySettings;
}

export interface FileSizePolicyResult {
  /** The (possibly nulled) buffer to persist for the before-blob. */
  beforeBuf?: Buffer;
  /** The (possibly nulled) buffer to persist for the after-blob. */
  afterBuf?: Buffer;
  /** True when at least one buffer was dropped due to max_partial_bytes. */
  partial_diff: boolean;
  /** True when both buffers were dropped due to max_skip_bytes. */
  redacted: boolean;
  /** Original (pre-policy) size of before, regardless of whether kept. */
  size_before?: number;
  /** Original (pre-policy) size of after, regardless of whether kept. */
  size_after?: number;
}

/**
 * Apply the size-cap policy to the given buffers. Pure function — no
 * I/O, no SQLite, no side effects. Throws on misconfiguration
 * (max_skip ≤ max_partial) so a bad settings value surfaces loudly
 * at ingest rather than silently producing skewed captures.
 */
export function enforceFileSizePolicy(
  input: FileSizePolicyInput,
): FileSizePolicyResult {
  const maxPartial =
    input.settings?.max_partial_bytes ?? DEFAULT_MAX_PARTIAL_BYTES;
  const maxSkip =
    input.settings?.max_skip_bytes ?? DEFAULT_MAX_SKIP_BYTES;
  if (maxSkip <= maxPartial) {
    throw new Error(
      `file_size_policy: misconfig — max_skip_bytes (${maxSkip}) must exceed max_partial_bytes (${maxPartial})`,
    );
  }

  const sizeBefore = input.beforeBuf?.length;
  const sizeAfter = input.afterBuf?.length;
  const largerSize = Math.max(sizeBefore ?? 0, sizeAfter ?? 0);

  // chmod-only / no-buf case: nothing to gate, pass through.
  if (sizeBefore === undefined && sizeAfter === undefined) {
    return {
      beforeBuf: undefined,
      afterBuf: undefined,
      partial_diff: false,
      redacted: false,
      size_before: undefined,
      size_after: undefined,
    };
  }

  // Skip case: either side exceeds the hard cap. Drop both.
  if (largerSize > maxSkip) {
    return {
      beforeBuf: undefined,
      afterBuf: undefined,
      partial_diff: false,
      redacted: true,
      size_before: sizeBefore,
      size_after: sizeAfter,
    };
  }

  // Partial case: either side exceeds the partial cap. Drop the
  // LARGER side (keep the smaller for delta context).
  if (largerSize > maxPartial) {
    const dropBefore = (sizeBefore ?? 0) >= (sizeAfter ?? 0);
    return {
      beforeBuf: dropBefore ? undefined : input.beforeBuf,
      afterBuf: dropBefore ? input.afterBuf : undefined,
      partial_diff: true,
      redacted: false,
      size_before: sizeBefore,
      size_after: sizeAfter,
    };
  }

  // Happy path: both sides under the partial cap. Pass through.
  return {
    beforeBuf: input.beforeBuf,
    afterBuf: input.afterBuf,
    partial_diff: false,
    redacted: false,
    size_before: sizeBefore,
    size_after: sizeAfter,
  };
}
