export * from "./pricing.ts";

/**
 * Trace format version.
 *
 * - **0.1.0** — v0 of Spool. Run + steps only.
 * - **0.2.0** — v0.1. Cross-vendor source_runtime values, fork/regression
 *   metadata, agent-SDK content_ref convention (true blob hashes everywhere).
 * - **0.3.0** — v0.3 (this constant). Adds file-capture data: `file_changes`
 *   array, `baseline_trees` array, plus the new `run.baseline_tree_id` and
 *   `run.probe_state` columns surfaced via the run object. Per SPEC-V0_3 §12,
 *   the format is additive: v0.2 readers ignore unknown components per the
 *   v0.2 §11 skip-unknown rule.
 *
 * Backward compatibility: v0.1.0 + v0.2.0 traces import cleanly — every
 * additive field is optional and the run.source_runtime values overlap.
 * Spool writes 0.3.0 going forward; older readers should fall back to
 * skipping unknown components rather than failing.
 */
export const TRACE_FORMAT_VERSION = "0.3.0";

export const SUPPORTED_TRACE_VERSIONS = ["0.1.0", "0.2.0", "0.3.0"] as const;
export type TraceFormatVersion = (typeof SUPPORTED_TRACE_VERSIONS)[number];
