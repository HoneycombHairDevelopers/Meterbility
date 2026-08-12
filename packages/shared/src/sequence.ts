/**
 * Reserved sequence band floor. Step sequences at/above this value are
 * synthetic capture-plane steps (hooks / admin usage / checkpoints) —
 * not part of the source conversation walk — and are excluded from walk
 * reconciliation (trims, shift rebuilds) and live activity heuristics
 * (stall/context/loop detection, "latest step" displays).
 */
export const RESERVED_SEQUENCE_BASE = 100_000;
