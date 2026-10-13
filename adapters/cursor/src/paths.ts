/**
 * Path canonicalization shared by every Cursor channel that writes
 * file_change rows (toolFormerData, checkpoints, hooks).
 *
 * Cursor records absolute paths everywhere — `params.relativeWorkspacePath`
 * is absolute in real data despite its name, checkpoint URIs are
 * `file://` paths, hook payloads carry `file_path` absolute. The
 * checkpoint fallback dedupes against tool-attributed rows by path, so
 * all three channels MUST canonicalize identically or every path gets a
 * duplicate `cursor-checkpoint` row.
 */

/** The placeholder cwd for ephemeral windows with no workspace folder. */
export const PLACEHOLDER_CWD = "(cursor)";

/**
 * Strip `cwd` from an absolute path. Paths outside the workspace (or
 * any path when the cwd is unknown / the placeholder) pass through
 * unchanged apart from separator normalization.
 */
export function toRepoRelative(absPath: string, cwd: string | undefined): string {
  const normCwd = (cwd ?? "").replace(/\/+$/, "");
  if (normCwd.length > 0 && normCwd !== PLACEHOLDER_CWD) {
    if (absPath === normCwd) return "";
    if (absPath.startsWith(normCwd + "/")) {
      return absPath.slice(normCwd.length + 1).split("\\").join("/");
    }
  }
  return absPath.split("\\").join("/");
}
