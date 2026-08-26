/**
 * Minimal unified-diff generator for text-only FileChange.patch_text.
 *
 * Scope intentionally small: we need a readable diff for the Files tab
 * in the web UI (v0.3 §8.1), not a git-compatible patch the user could
 * `git apply`. The `lines_added` / `lines_removed` counts on the row
 * are what get used for the sparkline + summary numbers; the rendered
 * diff is "good enough to read."
 *
 * Strategy: an LCS-based line diff. O(n*m) in time and memory, which is
 * fine for the sizes v0.3 caps at — the §11.1 policy already excludes
 * anything over 5 MB from full snapshots, so the diff workload is
 * bounded.
 */

export interface DiffStats {
  added: number;
  removed: number;
}

export interface DiffResult {
  unified: string;
  stats: DiffStats;
}

/**
 * Diff two strings line-by-line. Returns a unified diff with a single
 * `@@ ... @@` hunk header spanning the whole file — pretty enough for
 * the v0.3 UI, deferring true multi-hunk output to v0.4's renderer
 * upgrades.
 */
export function diffLines(before: string, after: string): DiffResult {
  // Normalize line endings for diff purposes only — the on-disk blobs
  // keep their original bytes (PR 1 binary-safety + the spec's
  // §11.6 byte-exact rule).
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const ops = lcsDiff(a, b);
  let added = 0;
  let removed = 0;
  const body: string[] = [];
  for (const op of ops) {
    if (op.kind === "eq") {
      for (const line of op.lines) body.push(` ${line}`);
    } else if (op.kind === "add") {
      for (const line of op.lines) {
        body.push(`+${line}`);
        added += 1;
      }
    } else {
      for (const line of op.lines) {
        body.push(`-${line}`);
        removed += 1;
      }
    }
  }
  const header = `@@ -1,${a.length} +1,${b.length} @@`;
  // If nothing changed, return an empty patch_text. The caller decides
  // whether to even emit a FileChange row in that case (it won't —
  // op="modify" requires content delta).
  if (added === 0 && removed === 0) {
    return { unified: "", stats: { added: 0, removed: 0 } };
  }
  return {
    unified: `${header}\n${body.join("\n")}\n`,
    stats: { added, removed },
  };
}

interface DiffOp {
  kind: "eq" | "add" | "del";
  lines: string[];
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  // Compute LCS length table, then backtrack to produce ops.
  // Standard dynamic-programming LCS — same shape as `diff -u` uses.
  const n = a.length;
  const m = b.length;
  // Short-circuit common cases. Saves the O(n*m) allocation on creates,
  // deletes, and pure-append/prepend edits.
  if (n === 0) {
    return b.length > 0 ? [{ kind: "add", lines: b }] : [];
  }
  if (m === 0) {
    return a.length > 0 ? [{ kind: "del", lines: a }] : [];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  // Backtrack.
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      pushOp(ops, "eq", a[i - 1]!);
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      pushOp(ops, "add", b[j - 1]!);
      j -= 1;
    } else {
      pushOp(ops, "del", a[i - 1]!);
      i -= 1;
    }
  }
  ops.reverse();
  // After reversing, the lines inside each op are also reversed
  // (we prepended via pushOp). Flip them back.
  for (const op of ops) op.lines.reverse();
  return ops;
}

function pushOp(ops: DiffOp[], kind: DiffOp["kind"], line: string): void {
  const tail = ops[ops.length - 1];
  if (tail && tail.kind === kind) {
    tail.lines.push(line);
    return;
  }
  ops.push({ kind, lines: [line] });
}
