export * from "./pricing.ts";

/**
 * Trace format version. Bumped to 0.2.0 in v0.1 of Spool to reflect the
 * cross-vendor source_runtime values, fork/regression metadata, and the
 * agent-SDK content_ref convention (true blob hashes everywhere).
 *
 * Backward compatibility: v0.1.0 traces import cleanly — every additive
 * field is optional, and the run.source_runtime values overlap. Spool
 * writes 0.2.0 going forward; older readers should fall back to skipping
 * unknown components rather than failing.
 */
export const TRACE_FORMAT_VERSION = "0.2.0";

export const SUPPORTED_TRACE_VERSIONS = ["0.1.0", "0.2.0"] as const;
export type TraceFormatVersion = (typeof SUPPORTED_TRACE_VERSIONS)[number];
