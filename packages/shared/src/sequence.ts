/**
 * Reserved sequence band floor. Step sequences at/above this value are
 * synthetic capture-plane steps (hooks / admin usage / checkpoints) —
 * not part of the source conversation walk — and are excluded from walk
 * reconciliation (trims, shift rebuilds) and live activity heuristics
 * (stall/context/loop detection, "latest step" displays).
 */
export const RESERVED_SEQUENCE_BASE = 100_000;

/**
 * Sub-band floors within the reserved space. Hooks own
 * [RESERVED_SEQUENCE_BASE, ADMIN_SEQUENCE_BASE); Admin-API usage owns
 * [ADMIN_SEQUENCE_BASE, CHECKPOINT_SEQUENCE_BASE); checkpoint fallback
 * starts at CHECKPOINT_SEQUENCE_BASE. Authoritative band semantics live
 * in adapters/cursor/src/bands.ts (which re-exports these); the floors
 * live here so non-adapter consumers (CLI band labels) don't need an
 * adapter dependency.
 */
export const ADMIN_SEQUENCE_BASE = 200_000;
export const CHECKPOINT_SEQUENCE_BASE = 300_000;
