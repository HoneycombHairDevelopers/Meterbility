import { RESERVED_SEQUENCE_BASE } from "@meterbility/shared";
import type { Store } from "@meterbility/collector";

/**
 * Cursor sequence bands — the reserved ranges where each synthetic
 * capture plane writes its steps, all inside [RESERVED_SEQUENCE_BASE,
 * SEQUENCE_REBUILD_OFFSET) so the DB adapter's bounded reconciliation
 * (trims/offsets in ingest.ts) never touches them:
 *
 *   [HOOK_SEQUENCE_BASE,       ADMIN_SEQUENCE_BASE)      — hooks plane
 *   [ADMIN_SEQUENCE_BASE,      CHECKPOINT_SEQUENCE_BASE) — Admin API usage
 *   [CHECKPOINT_SEQUENCE_BASE, SEQUENCE_REBUILD_OFFSET)  — checkpoint fallback
 *
 * SEQUENCE_REBUILD_OFFSET is the DB adapter's rebuild-vacate offset —
 * far above every band, so offset rows can never collide with them.
 */
export const HOOK_SEQUENCE_BASE = RESERVED_SEQUENCE_BASE;
export const ADMIN_SEQUENCE_BASE = 200_000;
export const CHECKPOINT_SEQUENCE_BASE = 300_000;
export const SEQUENCE_REBUILD_OFFSET = 1_000_000;

/**
 * Next free sequence inside a band: base + count of existing rows in
 * [base, limitExclusive). Call inside a write transaction when the
 * subsequent insert must not race a concurrent process computing the
 * same value.
 */
export function nextSequenceInBand(
  store: Store,
  runId: string,
  base: number,
  limitExclusive: number,
): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM steps WHERE run_id = ? AND sequence >= ? AND sequence < ?`,
    )
    .get(runId, base, limitExclusive) as { n: number };
  return base + row.n;
}
