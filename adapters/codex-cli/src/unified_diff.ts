/**
 * Minimal unified-diff *apply* — the inverse of `diffLines` in
 * `@meterbility/shared`, which only *produces* diffs.
 *
 * Codex's `FileChange` items carry an `update` as a unified diff only
 * (no before- or after-content). When the adapter already knows the
 * path's current content (the after-image of an earlier `add` /
 * `update` in the same session), applying the hunks to it recovers the
 * full after-image and lets the row carry both blobs.
 *
 * Scope: hunk headers `@@ -a[,b] +c[,d] @@`, body lines ` `/`-`/`+`, the
 * `\ No newline at end of file` marker, and leading `---`/`+++`/
 * `diff`/`index` headers (ignored). Hunks must match exactly at their
 * declared position or, failing that, at the nearest position in the
 * file where their old-side lines match (a small fuzz for drifted
 * offsets). Any hunk that cannot be placed makes the whole apply fail
 * — a derived before-image is only useful when it is byte-exact.
 */

interface Hunk {
  oldStart: number;
  /** Old-side lines (context + removed), in order. */
  oldLines: string[];
  /** New-side lines (context + added), in order. */
  newLines: string[];
  /** `\ No newline at end of file` seen after a new-side line. */
  newNoEol: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): Hunk[] | undefined {
  const lines = diff.split("\n");
  // A trailing "\n" yields a final empty element — drop it so it is
  // not mistaken for an empty context line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let lastKind: "+" | "-" | " " | undefined;

  for (const raw of lines) {
    const m = raw.match(HUNK_RE);
    if (m) {
      cur = {
        oldStart: Number(m[1]),
        oldLines: [],
        newLines: [],
        newNoEol: false,
      };
      hunks.push(cur);
      lastKind = undefined;
      continue;
    }
    if (!cur) {
      // Preamble: file headers or anything before the first hunk.
      continue;
    }
    if (raw.startsWith("\\")) {
      if (lastKind === "+" || lastKind === " ") cur.newNoEol = true;
      continue;
    }
    const kind = raw[0];
    const body = raw.slice(1);
    if (kind === " ") {
      cur.oldLines.push(body);
      cur.newLines.push(body);
      lastKind = " ";
    } else if (kind === "-") {
      cur.oldLines.push(body);
      lastKind = "-";
    } else if (kind === "+") {
      cur.newLines.push(body);
      lastKind = "+";
    } else if (raw === "") {
      // Some emitters strip the leading space from blank context lines.
      cur.oldLines.push("");
      cur.newLines.push("");
      lastKind = " ";
    } else {
      // Unknown line inside a hunk (e.g. a second preamble) — refuse
      // rather than guess.
      return undefined;
    }
  }
  return hunks;
}

/**
 * Apply `diff` to `before`. Returns the new content, or `undefined`
 * when the diff does not parse or any hunk fails to match.
 */
export function applyUnifiedDiff(
  before: string,
  diff: string,
): string | undefined {
  const hunks = parseUnifiedDiff(diff);
  if (!hunks || hunks.length === 0) return undefined;

  const hadTrailingNewline = before.endsWith("\n");
  const src =
    before.length === 0
      ? []
      : (hadTrailingNewline ? before.slice(0, -1) : before).split("\n");

  const out: string[] = [];
  let cursor = 0; // next unread index into src
  let offset = 0; // cumulative line delta from applied hunks
  let trailingNewline = hadTrailingNewline;

  for (const h of hunks) {
    // `@@ -0,0` means "insert before line 1".
    const declared = Math.max(0, h.oldStart - 1) + offset;
    const pos = locate(src, h.oldLines, declared, cursor);
    if (pos === undefined) return undefined;

    for (let i = cursor; i < pos; i++) out.push(src[i]!);
    for (const l of h.newLines) out.push(l);
    cursor = pos + h.oldLines.length;
    offset += h.newLines.length - h.oldLines.length;

    if (cursor >= src.length) {
      // The hunk reaches end-of-file on the old side: the new side's
      // EOL marker decides the trailing newline.
      trailingNewline = !h.newNoEol;
    }
  }
  for (let i = cursor; i < src.length; i++) out.push(src[i]!);

  if (out.length === 0) return "";
  return out.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * Find where `needle` matches in `src`, preferring `declared`, then
 * the nearest position at or after `min` (hunks apply in order, so an
 * earlier position would overlap the previous hunk).
 */
function locate(
  src: string[],
  needle: string[],
  declared: number,
  min: number,
): number | undefined {
  const matchesAt = (p: number): boolean => {
    if (p < min || p + needle.length > src.length) return false;
    for (let i = 0; i < needle.length; i++) {
      if (src[p + i] !== needle[i]) return false;
    }
    return true;
  };
  if (needle.length === 0) {
    // Pure insertion: trust the declared position, clamped.
    const p = Math.min(Math.max(declared, min), src.length);
    return p;
  }
  if (matchesAt(declared)) return declared;
  const span = Math.max(declared - min, src.length - declared);
  for (let d = 1; d <= span; d++) {
    if (matchesAt(declared - d)) return declared - d;
    if (matchesAt(declared + d)) return declared + d;
  }
  return undefined;
}
