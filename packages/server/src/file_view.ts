import type { FileChange, FileOp, Run, Step } from "@spool-ai/shared";

/**
 * `/runs/:run_id/files` page renderer.
 *
 * Server-rendered two-pane layout per SPEC-V0_3 §8.3 + the locked
 * design decisions D3–D14 (see plan file Design Review section):
 *
 *   D3  — tree sorts risk-first within each dir (D > R > M > A, then alpha)
 *   D4  — run-header strip reuses .files-summary token + flag chips
 *   D5  — partial-diff Final tab gets an amber banner with byte counts
 *   D6  — empty state copy is branched by cause
 *   D7  — image/* renders inline via <img>; other binary gets a placard
 *   D8  — default-selected file = first in the risk-first sorted tree
 *   D9  — directory chevron is decorative; whole row toggles expand
 *   D11 — Raw tab is a dense table, not a link list
 *   D12 — three breakpoints (>1100 two-pane, 600-1100 stacked, <600 dropdown)
 *   D14 — URL fragment encodes expanded paths + selected file
 *
 * Plus plan-direct token mapping: 2px cerulean left border on selected
 * row, .tab-bar + .tab-btn for tab chrome, .tab-count pill for counts.
 */

/**
 * Tree node. Directories carry children + an aggregated op badge
 * derived from the worst-severity op of any descendant; files carry
 * the FileChange list (one path may have multiple touches).
 */
export interface FileTreeNode {
  /** Last path segment, or the whole repo-relative path for files. */
  name: string;
  /** Full repo-relative POSIX path. */
  path: string;
  /** True for directory nodes (contain children); false for file leaves. */
  isDir: boolean;
  /**
   * Worst-severity op among this node's content. Used for the badge
   * shown at the row level. Per D3: D > R > M > A → mint A wins last.
   */
  worstOp?: FileOp;
  /** Whether any FileChange under this subtree has partial_diff=true. */
  anyPartial: boolean;
  /** Whether any FileChange under this subtree has redacted=true. */
  anyRedacted: boolean;
  /** Whether any FileChange under this subtree is binary. */
  anyBinary: boolean;
  /** Child nodes (dirs first then files, each group risk-first per D3). */
  children: FileTreeNode[];
  /** For leaves: every FileChange touching this path, ordered by step seq. */
  changes: FileChange[];
}

const OP_RANK: Record<FileOp, number> = {
  delete: 0,
  rename: 1,
  modify: 2,
  create: 3,
  chmod: 4,
};

/**
 * Compare two ops by risk severity per D3. Returns negative if `a`
 * is more severe than `b` (sorts first).
 */
function compareOpsByRisk(a: FileOp | undefined, b: FileOp | undefined): number {
  const ra = a !== undefined ? OP_RANK[a] : 99;
  const rb = b !== undefined ? OP_RANK[b] : 99;
  return ra - rb;
}

/**
 * Worst (most severe) op among the supplied list. Returns undefined
 * for an empty list. Used to aggregate badges on dir nodes and to
 * pick the default-selected file (D8).
 */
function worstOpAmong(fcs: FileChange[]): FileOp | undefined {
  if (fcs.length === 0) return undefined;
  let best = fcs[0]!.op;
  for (let i = 1; i < fcs.length; i++) {
    if (compareOpsByRisk(fcs[i]!.op, best) < 0) best = fcs[i]!.op;
  }
  return best;
}

/**
 * Build the file tree from a run's FileChange list. Groups changes
 * by path, derives one leaf per unique path with all its touches,
 * stacks directories. Risk-first sort applies at every level (D3).
 */
export function buildFileTree(fcs: FileChange[]): FileTreeNode[] {
  // Group touches by path. Sort each group's touches by sequence so
  // the History tab walks in chronological order.
  const byPath = new Map<string, FileChange[]>();
  for (const fc of fcs) {
    const list = byPath.get(fc.path);
    if (list) list.push(fc);
    else byPath.set(fc.path, [fc]);
  }
  for (const list of byPath.values()) {
    list.sort((a, b) => a.sequence - b.sequence);
  }

  // Build the tree by walking each path's segments. Dirs become
  // intermediate nodes; the file is a leaf.
  type MutableDir = {
    name: string;
    path: string;
    isDir: true;
    dirs: Map<string, MutableDir>;
    files: FileTreeNode[];
  };
  const root: MutableDir = {
    name: "",
    path: "",
    isDir: true,
    dirs: new Map(),
    files: [],
  };

  for (const [path, touches] of byPath) {
    const segments = path.split("/").filter(Boolean);
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      let next = cursor.dirs.get(seg);
      if (!next) {
        const dirPath = cursor.path ? `${cursor.path}/${seg}` : seg;
        next = {
          name: seg,
          path: dirPath,
          isDir: true,
          dirs: new Map(),
          files: [],
        };
        cursor.dirs.set(seg, next);
      }
      cursor = next;
    }
    const fileName = segments[segments.length - 1] ?? path;
    const leaf: FileTreeNode = {
      name: fileName,
      path,
      isDir: false,
      worstOp: worstOpAmong(touches),
      anyPartial: touches.some((t) => t.partial_diff),
      anyRedacted: touches.some((t) => t.redacted),
      anyBinary: touches.some(
        (t) => !t.partial_diff && !t.redacted && t.patch_format === "binary",
      ),
      children: [],
      changes: touches,
    };
    cursor.files.push(leaf);
  }

  /**
   * Recursively materialize the mutable dir tree into the public
   * FileTreeNode shape with proper sorting + aggregated metadata.
   */
  function materialize(dir: MutableDir): FileTreeNode[] {
    const childDirs: FileTreeNode[] = [];
    for (const [, sub] of dir.dirs) {
      const subChildren = materialize(sub);
      const allLeaves = collectLeaves(subChildren);
      childDirs.push({
        name: sub.name,
        path: sub.path,
        isDir: true,
        worstOp: worstOpAmong(allLeaves.flatMap((l) => l.changes)),
        anyPartial: allLeaves.some((l) => l.anyPartial),
        anyRedacted: allLeaves.some((l) => l.anyRedacted),
        anyBinary: allLeaves.some((l) => l.anyBinary),
        children: subChildren,
        changes: [],
      });
    }
    // Risk-first sort within each kind, dirs before files (D3 hybrid
    // applies here: dirs and files are sorted in their own groups).
    childDirs.sort(
      (a, b) =>
        compareOpsByRisk(a.worstOp, b.worstOp) || a.name.localeCompare(b.name),
    );
    const childFiles = [...dir.files].sort(
      (a, b) =>
        compareOpsByRisk(a.worstOp, b.worstOp) || a.name.localeCompare(b.name),
    );
    return [...childDirs, ...childFiles];
  }

  return materialize(root);
}

/**
 * Walk a tree and collect every leaf (file) node. Used during dir
 * aggregation to compute worst-op + flag-aggregate over all
 * descendants without re-walking the original path list.
 */
function collectLeaves(nodes: FileTreeNode[]): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const n of nodes) {
    if (n.isDir) out.push(...collectLeaves(n.children));
    else out.push(n);
  }
  return out;
}

/**
 * Flatten the tree into the risk-first ordering used for the default
 * selection (D8). Returns leaves only, in pre-order so the very first
 * entry is the highest-risk file on the page.
 */
export function flattenForDefaultSelection(
  tree: FileTreeNode[],
): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  function walk(nodes: FileTreeNode[]) {
    for (const n of nodes) {
      if (n.isDir) walk(n.children);
      else out.push(n);
    }
  }
  walk(tree);
  return out;
}

// ─── Empty-state copy (D6) ──────────────────────────────────────────

export type EmptyReason =
  | "capture_disabled"
  | "no_writes"
  | "all_skipped"
  | "unknown";

/**
 * Branch the empty-state copy by why this run has zero FileChanges.
 * Per D6: each variant has one specific action link instead of a
 * generic "no files captured" message. Caller passes the resolved
 * setting + the count of redacted=true stubs to pick the right one.
 */
export function pickEmptyReason(args: {
  captureEnabled: boolean;
  totalFileChanges: number;
  redactedStubs: number;
}): EmptyReason {
  if (!args.captureEnabled) return "capture_disabled";
  if (args.totalFileChanges === 0) return "no_writes";
  // totalFileChanges > 0 with redactedStubs == totalFileChanges →
  // every file got skipped by the size cap.
  if (args.redactedStubs > 0 && args.redactedStubs === args.totalFileChanges) {
    return "all_skipped";
  }
  return "unknown";
}

export function renderEmptyState(reason: EmptyReason): string {
  switch (reason) {
    case "capture_disabled":
      return `<div class="files-empty">
        <p class="files-empty-headline">File capture is disabled for this run.</p>
        <p class="files-empty-sub">
          Re-enable via <code>capture.files.enabled</code> in
          <a href="/settings">Settings →</a>
        </p>
      </div>`;
    case "no_writes":
      return `<div class="files-empty">
        <p class="files-empty-headline">
          This run didn't modify any files.
        </p>
        <p class="files-empty-sub">All tool calls were read-only.</p>
      </div>`;
    case "all_skipped":
      return `<div class="files-empty">
        <p class="files-empty-headline">
          All files in this run exceeded the 50MB capture cap.
        </p>
        <p class="files-empty-sub">
          Adjust <code>capture.files.max_skip_bytes</code> in
          <a href="/settings">Settings →</a>
        </p>
      </div>`;
    case "unknown":
    default:
      return `<div class="files-empty">
        <p class="files-empty-headline">No files captured for this run.</p>
      </div>`;
  }
}

// ─── HTML rendering ─────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const OP_BADGE: Record<FileOp, { letter: string; cls: string; label: string }> =
  {
    create: { letter: "A", cls: "file-op-create", label: "Created" },
    modify: { letter: "M", cls: "file-op-modify", label: "Modified" },
    delete: { letter: "D", cls: "file-op-delete", label: "Deleted" },
    rename: { letter: "R", cls: "file-op-rename", label: "Renamed" },
    chmod: { letter: "P", cls: "file-op-chmod", label: "Permissions" },
  };

/**
 * Render the run-header strip (D4): diffstat + flag chips + back link.
 * Pulls counts from the aggregate stats.
 */
export function renderRunHeaderStrip(args: {
  run: Run;
  fileChanges: FileChange[];
  stepCount: number;
}): string {
  const totals = args.fileChanges.reduce(
    (acc, fc) => ({
      added: acc.added + (fc.lines_added ?? 0),
      removed: acc.removed + (fc.lines_removed ?? 0),
      partial: acc.partial + (fc.partial_diff ? 1 : 0),
      redacted: acc.redacted + (fc.redacted ? 1 : 0),
      uniquePaths: acc.uniquePaths,
    }),
    { added: 0, removed: 0, partial: 0, redacted: 0, uniquePaths: 0 },
  );
  totals.uniquePaths = new Set(args.fileChanges.map((fc) => fc.path)).size;
  const runShort = args.run.run_id.slice(0, 12);
  // The back-link closes the journey loop (Pass 3) — operator can
  // return to the run detail page without using the browser back btn.
  const flagChips: string[] = [];
  if (totals.partial > 0) {
    flagChips.push(
      `<span class="file-flag flag-partial">${totals.partial} partial</span>`,
    );
  }
  if (totals.redacted > 0) {
    flagChips.push(
      `<span class="file-flag flag-redacted">${totals.redacted} redacted</span>`,
    );
  }
  return `<div class="files-header-strip" role="region" aria-label="Run files summary">
    <a class="files-back-link" href="/runs/${esc(args.run.run_id)}">← Run ${esc(runShort)}</a>
    <div class="files-summary">
      <span class="files-stat-add">+${totals.added}</span>
      <span class="files-stat-rm">−${totals.removed}</span>
      <span class="files-stat-count">${totals.uniquePaths} file${totals.uniquePaths === 1 ? "" : "s"}</span>
      <span class="files-stat-count">${args.stepCount} step${args.stepCount === 1 ? "" : "s"} touched</span>
      ${flagChips.join(" ")}
    </div>
  </div>`;
}

/**
 * Render one tree node (recursive). Directories show a chevron that
 * rotates on expand; files show the op badge inline. The selected
 * file gets aria-current="page" + a left-border highlight.
 */
function renderTreeNode(
  node: FileTreeNode,
  selectedPath: string,
  expanded: Set<string>,
  depth: number,
): string {
  if (node.isDir) {
    const isOpen = expanded.has(node.path);
    const children = isOpen
      ? `<div class="file-tree-children">${node.children
          .map((c) => renderTreeNode(c, selectedPath, expanded, depth + 1))
          .join("")}</div>`
      : "";
    // D9 — whole row toggles expand; chevron is decorative. data-dir
    // hooks the keyboard nav + click handler in files-nav.js.
    const badge = node.worstOp
      ? `<span class="file-op-badge ${OP_BADGE[node.worstOp].cls}" aria-label="${OP_BADGE[node.worstOp].label}">${OP_BADGE[node.worstOp].letter}</span>`
      : "";
    return `<div class="file-tree-dir" data-dir-path="${esc(node.path)}">
      <button class="file-tree-row file-tree-row-dir"
              data-action="toggle-dir"
              data-path="${esc(node.path)}"
              aria-expanded="${isOpen}"
              style="padding-left: ${depth * 12 + 8}px">
        <span class="file-tree-chevron${isOpen ? " is-open" : ""}" aria-hidden="true">▸</span>
        ${badge}
        <span class="file-tree-name">${esc(node.name)}</span>
      </button>
      ${children}
    </div>`;
  }
  // File leaf.
  const isSelected = node.path === selectedPath;
  const badge = node.worstOp
    ? `<span class="file-op-badge ${OP_BADGE[node.worstOp].cls}" aria-label="${OP_BADGE[node.worstOp].label}">${OP_BADGE[node.worstOp].letter}</span>`
    : "";
  const chipParts: string[] = [];
  if (node.anyPartial) chipParts.push(`<span class="file-flag flag-partial">partial</span>`);
  if (node.anyRedacted) chipParts.push(`<span class="file-flag flag-redacted">redacted</span>`);
  if (node.anyBinary) chipParts.push(`<span class="file-flag flag-binary">binary</span>`);
  return `<a class="file-tree-row file-tree-row-file${isSelected ? " is-selected" : ""}"
             href="#path=${encodeURIComponent(node.path)}"
             data-action="select-file"
             data-path="${esc(node.path)}"
             title="${esc(node.path)}"
             aria-current="${isSelected ? "page" : "false"}"
             style="padding-left: ${depth * 12 + 24}px">
    ${badge}
    <span class="file-tree-name">${esc(node.name)}</span>
    ${chipParts.join(" ")}
  </a>`;
}

/**
 * Render the right pane for one file: file header + tab strip + the
 * Final tab body (default). Other tabs (History, Raw) get lazy-loaded
 * via the fragment endpoint when the user clicks them.
 */
export function renderRightPane(args: {
  runId: string;
  node: FileTreeNode;
  tab?: "final" | "history" | "raw";
  /** Used to ?lang=... hint on the render endpoint. */
  langHint?: string;
}): string {
  const tab = args.tab ?? "final";
  const touches = args.node.changes;
  const totals = touches.reduce(
    (acc, fc) => ({
      added: acc.added + (fc.lines_added ?? 0),
      removed: acc.removed + (fc.lines_removed ?? 0),
    }),
    { added: 0, removed: 0 },
  );
  const op = args.node.worstOp;
  const opLabel = op ? OP_BADGE[op].label : "";
  const touchCount = touches.length;
  const finalActive = tab === "final";
  const historyActive = tab === "history";
  const rawActive = tab === "raw";

  // Pick the freshest blob with content for the Final tab. Walk
  // touches in reverse order; first one with an after_blob_ref is
  // the end-of-run content. Tracks partial / redacted state so the
  // banner (D5) can fire.
  let finalBlobRef: string | undefined;
  let finalIsPartial = false;
  let finalIsRedacted = false;
  let finalSizeBefore: number | undefined;
  let finalSizeAfter: number | undefined;
  for (let i = touches.length - 1; i >= 0; i--) {
    const t = touches[i]!;
    if (t.after_blob_ref) {
      finalBlobRef = t.after_blob_ref;
      finalIsPartial = t.partial_diff;
      finalIsRedacted = t.redacted;
      finalSizeBefore = t.size_before;
      finalSizeAfter = t.size_after;
      break;
    }
  }
  // Walk forward looking for partial/redacted state when no
  // after-blob is present (delete case).
  if (!finalBlobRef) {
    const last = touches[touches.length - 1];
    if (last) {
      finalIsPartial = last.partial_diff;
      finalIsRedacted = last.redacted;
      finalSizeBefore = last.size_before;
      finalSizeAfter = last.size_after;
    }
  }

  const headerHtml = `<div class="file-pane-header">
    <span class="file-pane-path">${esc(args.node.path)}</span>
    <span class="file-pane-stats">
      <span class="files-stat-add">+${totals.added}</span>
      <span class="files-stat-rm">−${totals.removed}</span>
    </span>
    <span class="file-pane-op">${esc(opLabel)} · ${touchCount} touch${touchCount === 1 ? "" : "es"}</span>
  </div>`;

  const tabStrip = `<div class="tab-bar" role="tablist">
    <button class="tab-btn${finalActive ? " is-active" : ""}"
            role="tab"
            aria-selected="${finalActive}"
            data-action="select-tab"
            data-tab="final"
            data-key="1">Final</button>
    <button class="tab-btn${historyActive ? " is-active" : ""}"
            role="tab"
            aria-selected="${historyActive}"
            data-action="select-tab"
            data-tab="history"
            data-key="2">History <span class="tab-count">${touchCount}</span></button>
    <button class="tab-btn${rawActive ? " is-active" : ""}"
            role="tab"
            aria-selected="${rawActive}"
            data-action="select-tab"
            data-tab="raw"
            data-key="3">Raw <span class="tab-count">${touches.length}</span></button>
  </div>`;

  // Final tab body — handles redacted (D5 coral banner), partial (D5
  // amber banner), binary (D7 placard), delete (no content), and the
  // normal text case (Shiki via /api/blob/:hash/render).
  let finalBody = "";
  if (finalActive) {
    if (finalIsRedacted) {
      finalBody = `<div class="file-banner banner-redacted" role="status">
        ⛔ Content not captured (file exceeded 50MB cap).
        Original size: ${fmtBytes(finalSizeBefore ?? finalSizeAfter)}.
        <a href="/settings#capture.files.max_skip_bytes">Why? →</a>
      </div>`;
    } else if (!finalBlobRef && op === "delete") {
      finalBody = `<div class="file-banner banner-deleted" role="status">
        🗑 File deleted in this run. No final content.
      </div>`;
    } else if (!finalBlobRef) {
      finalBody = `<div class="file-banner banner-missing" role="status">
        ℹ No final content available for this file.
      </div>`;
    } else if (args.node.anyBinary) {
      // D7 — non-image binary gets a placard with download link.
      finalBody = `<div class="file-binary-placard">
        <p>Binary file · ${fmtBytes(finalSizeAfter ?? finalSizeBefore)}</p>
        <a href="/api/blob/${esc(finalBlobRef)}" class="btn-secondary">Download →</a>
      </div>`;
    } else {
      // Text — Shiki render via the new endpoint. D5 partial-banner
      // sticks above it when applicable.
      const partialBanner = finalIsPartial
        ? `<div class="file-banner banner-partial" role="status">
          ⚠ First ${fmtBytes(finalSizeAfter)} of ${fmtBytes(finalSizeBefore ?? finalSizeAfter)} shown
          — file exceeded capture policy.
          <a href="/api/blob/${esc(finalBlobRef)}">Download full blob →</a>
        </div>`
        : "";
      const langQS = args.langHint
        ? `?lang=${encodeURIComponent(args.langHint)}&path=${encodeURIComponent(args.node.path)}`
        : `?path=${encodeURIComponent(args.node.path)}`;
      finalBody = `${partialBanner}
        <div class="file-final-render"
             data-blob-ref="${esc(finalBlobRef)}"
             data-render-url="/api/blob/${esc(finalBlobRef)}/render${langQS}">
          <iframe class="file-final-frame"
                  src="/api/blob/${esc(finalBlobRef)}/render${langQS}"
                  sandbox="allow-same-origin"
                  loading="lazy"
                  title="Rendered ${esc(args.node.path)}"></iframe>
        </div>`;
    }
  }

  // History tab — stacked per-touch diffs. Reuses renderStepFilesPanel
  // shape by emitting per-touch wrappers; the actual diff body is
  // rendered server-side in html.ts when the fragment endpoint is
  // hit. For the initial render of "history" we walk touches inline.
  let historyBody = "";
  if (historyActive) {
    if (touches.length === 0) {
      historyBody = `<p class="file-pane-empty">No touches recorded.</p>`;
    } else {
      historyBody = touches
        .map((t) => renderTouchSummary(t))
        .join("\n");
    }
  }

  // Raw tab — dense table per D11. One row per touch.
  let rawBody = "";
  if (rawActive) {
    rawBody = renderRawTab(touches);
  }

  return `<section class="file-pane" data-selected-path="${esc(args.node.path)}">
    ${headerHtml}
    ${tabStrip}
    <div class="file-pane-body" role="tabpanel">
      ${finalBody}${historyBody}${rawBody}
    </div>
  </section>`;
}

/**
 * Render one touch row for the History tab. Compact summary that
 * shows the step #, op, +/- counts, and a link into the per-step
 * file-change detail. Per design, History stacks oldest → newest.
 */
function renderTouchSummary(t: FileChange): string {
  const badge = OP_BADGE[t.op];
  return `<div class="file-history-touch">
    <span class="file-op-badge ${badge.cls}" aria-label="${badge.label}">${badge.letter}</span>
    <span class="file-history-meta">
      seq <code>${t.sequence}</code> ·
      step <code>${esc(t.step_id.slice(0, 12))}</code> ·
      <span class="files-stat-add">+${t.lines_added ?? 0}</span>
      <span class="files-stat-rm">−${t.lines_removed ?? 0}</span>
      ${t.partial_diff ? `<span class="file-flag flag-partial">partial</span>` : ""}
      ${t.redacted ? `<span class="file-flag flag-redacted">redacted</span>` : ""}
    </span>
    ${
      t.patch_text
        ? `<pre class="file-history-diff">${esc(t.patch_text)}</pre>`
        : ""
    }
  </div>`;
}

/**
 * Render the Raw tab dense table per D11.
 */
function renderRawTab(touches: FileChange[]): string {
  if (touches.length === 0) {
    return `<p class="file-pane-empty">No blob refs recorded.</p>`;
  }
  const rows = touches
    .map((t) => {
      const badge = OP_BADGE[t.op];
      const beforeCell = t.before_blob_ref
        ? `<a href="/api/blob/${esc(t.before_blob_ref)}" class="raw-blob-link" title="${esc(t.before_blob_ref)}">${esc(shortHash(t.before_blob_ref))}</a>`
        : `<span class="raw-blob-none">—</span>`;
      const afterCell = t.after_blob_ref
        ? `<a href="/api/blob/${esc(t.after_blob_ref)}" class="raw-blob-link" title="${esc(t.after_blob_ref)}">${esc(shortHash(t.after_blob_ref))}</a>`
        : `<span class="raw-blob-none">—</span>`;
      return `<tr>
        <td>${t.sequence}</td>
        <td><span class="file-op-badge ${badge.cls}">${badge.letter}</span></td>
        <td>${beforeCell}</td>
        <td>${afterCell}</td>
        <td>${fmtBytes(t.size_before)}</td>
        <td>${fmtBytes(t.size_after)}</td>
        <td>${esc(t.patch_format ?? "")}</td>
      </tr>`;
    })
    .join("\n");
  return `<table class="raw-tab-table">
    <thead>
      <tr>
        <th>seq</th>
        <th>op</th>
        <th>before</th>
        <th>after</th>
        <th>size before</th>
        <th>size after</th>
        <th>format</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function shortHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return hash.slice(0, 8) + "…" + hash.slice(-4);
}

function fmtBytes(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Top-level page render ──────────────────────────────────────────

export interface RenderFilesPageArgs {
  run: Run;
  fileChanges: FileChange[];
  steps: Step[];
  captureEnabled: boolean;
  /** URL-fragment derived state. */
  selectedPath?: string;
  expandedPaths?: string[];
  tab?: "final" | "history" | "raw";
}

/**
 * Top-level page renderer. Composes the run-header strip, the file
 * tree (left pane), and the right pane. Picks defaults per D8
 * (risk-first first file selected) when the URL fragment leaves it
 * unspecified.
 */
export function renderFilesPage(args: RenderFilesPageArgs): {
  bodyHtml: string;
  stylesHtml: string;
  scriptsHtml: string;
} {
  const headerStrip = renderRunHeaderStrip({
    run: args.run,
    fileChanges: args.fileChanges,
    stepCount: args.steps.length,
  });

  // Empty state — branched copy per D6.
  if (args.fileChanges.length === 0 || !args.captureEnabled) {
    const stubsRedacted = args.fileChanges.filter((fc) => fc.redacted).length;
    const reason = pickEmptyReason({
      captureEnabled: args.captureEnabled,
      totalFileChanges: args.fileChanges.length,
      redactedStubs: stubsRedacted,
    });
    return {
      bodyHtml: `${headerStrip}${renderEmptyState(reason)}`,
      stylesHtml: FILES_PAGE_STYLES,
      scriptsHtml: "",
    };
  }

  const tree = buildFileTree(args.fileChanges);
  // D8: default selected = first file in risk-first sort.
  const flat = flattenForDefaultSelection(tree);
  const selected =
    args.selectedPath && flat.find((n) => n.path === args.selectedPath)
      ? flat.find((n) => n.path === args.selectedPath)!
      : flat[0];

  // Expand all dirs on the path to the selected file by default so
  // the row is visible without user interaction. The URL fragment
  // can add more (D14) but never less than this minimum.
  const expanded = new Set<string>(args.expandedPaths ?? []);
  if (selected) {
    const segs = selected.path.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]!}` : segs[i]!;
      expanded.add(acc);
    }
  }

  const treeHtml = `<nav class="file-tree" role="tree" aria-label="Files changed in run">
    ${tree.map((n) => renderTreeNode(n, selected?.path ?? "", expanded, 0)).join("\n")}
  </nav>`;

  const paneHtml = selected
    ? renderRightPane({
        runId: args.run.run_id,
        node: selected,
        tab: args.tab,
      })
    : `<section class="file-pane"><p>Select a file on the left.</p></section>`;

  // D12 — responsive breakpoints + tree dropdown on mobile. We render
  // a `<select>` mirror of the tree that the JS module wires up.
  const mobileDropdown = `<select class="file-tree-mobile-select"
      aria-label="Pick a file"
      data-action="mobile-select-file">
    ${flat
      .map(
        (n) =>
          `<option value="${esc(n.path)}"${
            n.path === selected?.path ? " selected" : ""
          }>${esc(n.path)}</option>`,
      )
      .join("")}
  </select>`;

  return {
    bodyHtml: `${headerStrip}
      ${mobileDropdown}
      <div class="files-two-pane">
        <aside class="files-tree-pane">${treeHtml}</aside>
        <main class="files-content-pane">${paneHtml}</main>
      </div>`,
    stylesHtml: FILES_PAGE_STYLES,
    scriptsHtml: FILES_PAGE_SCRIPTS,
  };
}

// ─── Styles + scripts (inline because Spool's server doesn't ship a
// build pipeline; one file per route is the existing pattern) ──

const FILES_PAGE_STYLES = `<style>
  .files-header-strip {
    display: flex; align-items: center; gap: 16px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }
  .files-back-link {
    font-size: 12.5px; color: var(--text-secondary);
    text-decoration: none;
  }
  .files-back-link:hover { color: var(--cerulean-400); }
  .files-empty {
    padding: 80px 20px; text-align: center;
    color: var(--text-secondary);
  }
  .files-empty-headline {
    font-size: 15px; color: var(--text-primary); margin: 0 0 8px;
  }
  .files-empty-sub {
    font-size: 13px; color: var(--text-tertiary); margin: 0;
  }
  .files-empty code {
    font-family: var(--font-mono); font-size: 12px;
    background: var(--surface-2); padding: 1px 6px; border-radius: 3px;
  }
  .files-two-pane {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 0;
    min-height: calc(100vh - 120px);
  }
  .files-tree-pane {
    border-right: 1px solid var(--border);
    background: var(--surface-1);
    overflow-y: auto;
    max-height: calc(100vh - 120px);
  }
  .files-content-pane {
    background: var(--surface-0);
    overflow: hidden;
  }
  .file-tree {
    padding: 4px 0;
    font-size: 13px;
  }
  .file-tree-row {
    display: flex; align-items: center; gap: 8px;
    width: 100%; min-height: 28px;
    padding: 4px 12px 4px 8px;
    border: none; background: none; color: var(--text-primary);
    text-align: left; cursor: pointer;
    font-family: inherit; font-size: 13px;
    text-decoration: none;
    border-left: 2px solid transparent;
  }
  .file-tree-row:hover { background: var(--surface-2); }
  .file-tree-row:focus-visible {
    outline: var(--focus-ring); outline-offset: -2px;
  }
  .file-tree-row.is-selected {
    background: rgba(56,189,248,0.08);
    border-left-color: var(--cerulean-400);
  }
  .file-tree-chevron {
    display: inline-block;
    color: var(--text-tertiary);
    transition: transform 120ms ease;
    width: 12px; text-align: center;
  }
  .file-tree-chevron.is-open { transform: rotate(90deg); }
  .file-tree-name {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .file-op-badge {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px;
    font-family: var(--font-mono); font-size: 11px; font-weight: 600;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .file-tree-mobile-select { display: none; }

  .file-pane {
    padding: 20px 24px;
    height: 100%;
    overflow-y: auto;
  }
  .file-pane-header {
    display: flex; align-items: baseline; gap: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 12px;
  }
  .file-pane-path {
    font-family: var(--font-mono); font-size: 12.5px;
    color: var(--text-primary);
    flex: 1; overflow-wrap: anywhere;
  }
  .file-pane-stats { display: inline-flex; gap: 6px; font-size: 12px; }
  .file-pane-op {
    font-size: 11.5px; color: var(--text-tertiary);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .file-banner {
    padding: 10px 14px; margin-bottom: 12px;
    border-radius: 4px; font-size: 12.5px;
    border-left: 3px solid;
  }
  .banner-partial {
    background: var(--amber-bg); border-left-color: var(--amber-400);
    color: var(--text-primary);
  }
  .banner-redacted {
    background: rgba(248,113,113,0.08); border-left-color: var(--coral-400);
    color: var(--text-primary);
  }
  .banner-deleted, .banner-missing {
    background: var(--surface-2); border-left-color: var(--text-tertiary);
    color: var(--text-secondary);
  }
  .file-banner a { color: var(--cerulean-400); }
  .file-final-render { background: var(--surface-0); border-radius: 4px; }
  .file-final-frame {
    width: 100%; min-height: 60vh; border: none;
    background: var(--surface-0);
  }
  .file-binary-placard {
    padding: 32px 20px; text-align: center;
    background: var(--surface-2); border-radius: 4px;
    color: var(--text-secondary);
  }
  .btn-secondary {
    display: inline-block; margin-top: 8px;
    padding: 6px 14px; border-radius: 4px;
    background: var(--surface-3); color: var(--text-primary);
    text-decoration: none; font-size: 12.5px;
  }
  .file-history-touch {
    padding: 10px 0; border-bottom: 1px solid var(--border);
  }
  .file-history-touch:last-child { border-bottom: none; }
  .file-history-meta {
    font-size: 12px; color: var(--text-tertiary);
    margin-left: 8px;
  }
  .file-history-diff {
    margin-top: 8px;
    font-family: var(--font-mono); font-size: 12px;
    background: var(--surface-1); padding: 10px 12px;
    border-radius: 4px; overflow-x: auto;
  }
  .raw-tab-table {
    width: 100%; border-collapse: collapse;
    font-size: 12.5px;
  }
  .raw-tab-table th {
    text-align: left; padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text-tertiary);
    font-weight: 500; text-transform: uppercase;
    font-size: 10.5px; letter-spacing: 0.04em;
  }
  .raw-tab-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
  .raw-blob-link {
    color: var(--cerulean-400); text-decoration: none;
    font-family: var(--font-mono);
  }
  .raw-blob-none { color: var(--text-tertiary); }
  .file-pane-empty {
    color: var(--text-tertiary); padding: 24px 0;
  }

  /* D12 — responsive breakpoints. */
  @media (max-width: 1100px) {
    .files-two-pane {
      grid-template-columns: 1fr;
    }
    .files-tree-pane {
      max-height: 40vh;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
  }
  @media (max-width: 600px) {
    .files-tree-pane { display: none; }
    .file-tree-mobile-select {
      display: block; width: calc(100% - 40px);
      margin: 12px 20px;
      padding: 8px 12px;
      background: var(--surface-2); color: var(--text-primary);
      border: 1px solid var(--border); border-radius: 4px;
      font-family: var(--font-mono); font-size: 12.5px;
    }
  }
</style>`;

/**
 * Client-side JS for the files page. Implements D13 (keyboard nav)
 * and D14 (URL fragment state persistence). No framework — vanilla
 * JS matches the rest of the codebase's pattern.
 *
 *   j / ↓     — move tree selection down
 *   k / ↑     — move tree selection up
 *   → / l     — expand the focused dir, or focus the right pane
 *   ← / h     — collapse the focused dir, or focus the tree
 *   1 / 2 / 3 — switch tabs (Final / History / Raw)
 *   /         — focus the filter input (future)
 *   Esc       — clear filter / blur input
 *
 * URL fragment shape (D14):
 *   #path=src/a/b.ts&open=src,src/a
 *   - path  = currently selected file
 *   - open  = comma-separated list of expanded dir paths
 * Refreshing the page or sharing the URL preserves the view.
 */
const FILES_NAV_CLIENT_JS = String.raw`
(function() {
  function parseFragment() {
    var hash = window.location.hash.replace(/^#/, '');
    var out = { path: '', open: [] };
    hash.split('&').forEach(function(part) {
      var eq = part.indexOf('=');
      if (eq < 0) return;
      var k = decodeURIComponent(part.slice(0, eq));
      var v = decodeURIComponent(part.slice(eq + 1));
      if (k === 'path') out.path = v;
      else if (k === 'open') out.open = v ? v.split(',') : [];
    });
    return out;
  }
  function writeFragment(state) {
    var parts = [];
    if (state.path) parts.push('path=' + encodeURIComponent(state.path));
    if (state.open.length)
      parts.push('open=' + state.open.map(encodeURIComponent).join(','));
    window.history.replaceState(null, '', '#' + parts.join('&'));
  }
  function getState() {
    var frag = parseFragment();
    var selected = document.querySelector('.file-tree-row.is-selected');
    var openDirs = [];
    document.querySelectorAll('.file-tree-row-dir[aria-expanded="true"]').forEach(
      function(el) { openDirs.push(el.dataset.path); }
    );
    return {
      path: selected ? selected.dataset.path : frag.path,
      open: openDirs.length ? openDirs : frag.open,
    };
  }
  function syncFragmentFromDom() { writeFragment(getState()); }

  function focusableRows() {
    return Array.prototype.slice.call(
      document.querySelectorAll('.file-tree-row-file:not([hidden])')
    );
  }
  function currentIndex(rows) {
    var sel = document.querySelector('.file-tree-row-file.is-selected');
    if (!sel) return -1;
    return rows.indexOf(sel);
  }
  function selectByIndex(rows, idx) {
    if (idx < 0 || idx >= rows.length) return;
    rows.forEach(function(r) {
      r.classList.remove('is-selected');
      r.setAttribute('aria-current', 'false');
    });
    rows[idx].classList.add('is-selected');
    rows[idx].setAttribute('aria-current', 'page');
    rows[idx].focus();
    // Fragment fetch + swap right pane.
    var path = rows[idx].dataset.path;
    loadFragment(path);
    syncFragmentFromDom();
  }
  function loadFragment(path) {
    var runMatch = window.location.pathname.match(/\\/runs\\/([^/]+)\\/files/);
    if (!runMatch) return;
    var runId = runMatch[1];
    fetch('/runs/' + encodeURIComponent(runId) + '/files/' +
          encodeURIComponent(path) + window.location.search)
      .then(function(r) { return r.ok ? r.text() : ''; })
      .then(function(html) {
        if (!html) return;
        var pane = document.querySelector('.files-content-pane');
        if (pane) pane.innerHTML = html;
      })
      .catch(function() {});
  }

  // Initial state restoration from URL fragment.
  var initialFrag = parseFragment();
  if (initialFrag.path) {
    var initial = document.querySelector(
      '.file-tree-row-file[data-path="' + cssEsc(initialFrag.path) + '"]'
    );
    if (initial) {
      document.querySelectorAll('.file-tree-row.is-selected').forEach(
        function(el) { el.classList.remove('is-selected'); }
      );
      initial.classList.add('is-selected');
      initial.setAttribute('aria-current', 'page');
    }
  }
  initialFrag.open.forEach(function(p) {
    var dir = document.querySelector(
      '.file-tree-row-dir[data-path="' + cssEsc(p) + '"]'
    );
    if (dir) dir.setAttribute('aria-expanded', 'true');
  });

  function cssEsc(s) {
    return s.replace(/[\\\\"]/g, function(c) { return '\\\\' + c; });
  }

  // Click handler — D9 (whole row toggles dir; file row swaps pane).
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    if (action === 'toggle-dir') {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      var chev = btn.querySelector('.file-tree-chevron');
      if (chev) chev.classList.toggle('is-open');
      // toggle children visibility.
      var children = btn.nextElementSibling;
      if (children) children.style.display = open ? 'none' : '';
      syncFragmentFromDom();
      e.preventDefault();
    } else if (action === 'select-file') {
      e.preventDefault();
      var rows = focusableRows();
      var idx = rows.indexOf(btn);
      selectByIndex(rows, idx);
    } else if (action === 'select-tab') {
      e.preventDefault();
      selectTab(btn.dataset.tab);
    } else if (action === 'mobile-select-file') {
      // Handled by 'change' below.
    }
  });

  // Mobile <select> dropdown (D12).
  document.addEventListener('change', function(e) {
    var el = e.target;
    if (el.dataset && el.dataset.action === 'mobile-select-file') {
      loadFragment(el.value);
      writeFragment({ path: el.value, open: parseFragment().open });
    }
  });

  function selectTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(function(b) {
      var isActive = b.dataset.tab === tab;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    var sel = document.querySelector('.file-tree-row-file.is-selected');
    if (!sel) return;
    var path = sel.dataset.path;
    var runMatch = window.location.pathname.match(/\\/runs\\/([^/]+)\\/files/);
    if (!runMatch) return;
    var runId = runMatch[1];
    fetch('/runs/' + encodeURIComponent(runId) + '/files/' +
          encodeURIComponent(path) + '?tab=' + encodeURIComponent(tab))
      .then(function(r) { return r.ok ? r.text() : ''; })
      .then(function(html) {
        if (!html) return;
        var pane = document.querySelector('.files-content-pane');
        if (pane) pane.innerHTML = html;
      })
      .catch(function() {});
  }

  // Keyboard nav — D13.
  document.addEventListener('keydown', function(e) {
    if (e.target.matches('input, textarea, select')) return;
    var rows = focusableRows();
    var idx = currentIndex(rows);
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      selectByIndex(rows, Math.min(rows.length - 1, idx + 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectByIndex(rows, Math.max(0, idx - 1));
    } else if (e.key === '1') {
      selectTab('final');
    } else if (e.key === '2') {
      selectTab('history');
    } else if (e.key === '3') {
      selectTab('raw');
    }
  });
})();
`;

const FILES_PAGE_SCRIPTS = `<script>
${FILES_NAV_CLIENT_JS}
</script>`;

