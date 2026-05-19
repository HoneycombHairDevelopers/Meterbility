/**
 * pretty.ts — schema-aware pretty-print for the four step-detail tabs
 * (action, outcome, decision, cost) shown by `spool inspect` and the
 * web step cards.
 *
 * Raw JSON stays the default everywhere; pretty mode is opt-in via the
 * CLI `--pretty-print` flag or the per-step `Pretty (all tabs)` button
 * on the web. This module is the single source of truth for both.
 *
 * Pure: no I/O. Callers pre-resolve blob refs and pass text in via
 * `opts.toolResultText`.
 */

import { fmtCents, fmtTokens } from "@spool/shared";

export type PrettyMode = "ansi" | "plain" | "html";

export interface PrettyOptions {
  mode: PrettyMode;
  /** Cap for individual string values. Anything longer truncates with "… (N more chars)". */
  maxStringLen?: number;
  /** Spaces per indent level. */
  indent?: number;
  /** Caller pre-resolves outcome.tool_result_ref and passes the text here. */
  toolResultText?: string;
  /** Caller signal: the source decision string hit a slice cap upstream. */
  truncated?: boolean;
  /** Web-only: link to the raw blob endpoint (e.g. "/api/blob/abc..."). */
  rawBlobHref?: string;
}

export type TabKind = "action" | "outcome" | "decision" | "cost";

const DEFAULT_MAX_STR = 4096;
const DEFAULT_INDENT = 2;
const MAX_DEPTH = 16;
const INLINE_ARRAY_WIDTH = 80;
const BLOCK = "┃"; // ┃

/**
 * Server-side slice limit for the decision preview blob (see
 * `loadDecisionPreviews` in `web.ts`). When a decision string lands at
 * the renderer with `length >= this`, the caller treats it as
 * truncated and pretty mode swaps the `(not JSON)` fallback for
 * `(truncated · view raw)`.
 */
export const DECISION_PREVIEW_LIMIT = 32_000;

// ─── color paint ─────────────────────────────────────────────────────

type Color =
  | "section"
  | "key"
  | "str"
  | "num"
  | "bool"
  | "null"
  | "meta"
  | "ok"
  | "error"
  | "pending"
  | "block";

const ANSI: Record<Color, [string, string]> = {
  section: ["\x1b[1m", "\x1b[22m"],       // bold
  key:     ["\x1b[2m", "\x1b[22m"],       // dim
  str:     ["\x1b[35m", "\x1b[39m"],      // magenta (≈ violet)
  num:     ["\x1b[36m", "\x1b[39m"],      // cyan
  bool:    ["\x1b[36m", "\x1b[39m"],      // cyan
  null:    ["\x1b[2m", "\x1b[22m"],       // dim
  meta:    ["\x1b[2m", "\x1b[22m"],       // dim
  ok:      ["\x1b[32m", "\x1b[39m"],      // green
  error:   ["\x1b[31m", "\x1b[39m"],      // red
  pending: ["\x1b[33m", "\x1b[39m"],      // yellow
  block:   ["\x1b[2m", "\x1b[22m"],       // dim — for ┃ bar itself
};

function paint(text: string, color: Color, mode: PrettyMode): string {
  if (mode === "plain") return text;
  if (mode === "html") return `<span class="p-${color}">${escHtml(text)}</span>`;
  const [open, close] = ANSI[color];
  return open + text + close;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve "ansi" down to "plain" when NO_COLOR is set. HTML and plain
 * modes are unaffected (HTML uses CSS, plain is already colorless).
 */
function resolveMode(mode: PrettyMode): PrettyMode {
  if (mode === "ansi" && process.env.NO_COLOR) return "plain";
  return mode;
}

// ─── small helpers ───────────────────────────────────────────────────

function emDash(mode: PrettyMode): string {
  return paint("—", "null", mode);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function indentStr(n: number, opts: PrettyOptions): string {
  return " ".repeat(n * (opts.indent ?? DEFAULT_INDENT));
}

function maxKeyWidth(keys: string[]): number {
  let max = 0;
  for (const k of keys) {
    if (k.length > max) max = k.length;
  }
  // minimum 8 so single-letter keys still look like a column
  return Math.max(8, max);
}

/**
 * Truncate a string at maxStringLen, append "… (N more chars)" hint.
 * Used for inline-rendered string scalars. Multi-line ┃ blocks use the
 * same hint at the end.
 */
function truncateString(s: string, max: number, mode: PrettyMode): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const more = s.length - max;
  const hint = paint(`… (${more} more chars)`, "meta", mode);
  return { text: s.slice(0, max) + " " + hint, truncated: true };
}

// ─── multi-line block ────────────────────────────────────────────────

/**
 * Render a multi-line string as `┃ ` prefixed lines. Handles both \n
 * and \r\n. Truncates the rendered string at maxStringLen.
 */
export function prettyMultilineString(s: string, opts: PrettyOptions): string {
  const mode = resolveMode(opts.mode);
  const max = opts.maxStringLen ?? DEFAULT_MAX_STR;
  let body = s;
  let suffix = "";
  if (body.length > max) {
    const more = body.length - max;
    body = body.slice(0, max);
    suffix = " " + paint(`… (${more} more chars)`, "meta", mode);
  }
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const bar = paint(BLOCK, "block", mode);
  const rendered = lines.map((l) => `${bar} ${l}`).join("\n");
  return suffix ? rendered + suffix : rendered;
}

// ─── core recursive value renderer ───────────────────────────────────

/**
 * Render any JSON-ish value at the given depth. `depth` is the nesting
 * level (object/array containers); strings and primitives don't
 * increment it. Hits MAX_DEPTH at 16 and emits a marker.
 */
export function prettyValue(v: unknown, opts: PrettyOptions, depth: number): string {
  const mode = resolveMode(opts.mode);

  if (depth > MAX_DEPTH) {
    return paint("… (deeper structure)", "meta", mode);
  }

  if (v === null || v === undefined) return emDash(mode);
  if (typeof v === "string") {
    if (v.length === 0) return emDash(mode);
    if (v.includes("\n") || v.includes("\r")) {
      return prettyMultilineString(v, { ...opts, mode });
    }
    const { text } = truncateString(v, opts.maxStringLen ?? DEFAULT_MAX_STR, mode);
    return paint(text, "str", mode);
  }
  if (typeof v === "boolean") return paint(String(v), "bool", mode);
  if (typeof v === "number") return paint(String(v), "num", mode);

  if (Array.isArray(v)) return renderArray(v, opts, depth);
  if (isPlainObject(v)) return renderObject(v, opts, depth);

  // Fallback: stringify whatever it is.
  return paint(JSON.stringify(v) ?? "?", "str", mode);
}

function renderArray(arr: unknown[], opts: PrettyOptions, depth: number): string {
  const mode = resolveMode(opts.mode);
  if (arr.length === 0) return emDash(mode);

  const allPrimitive = arr.every(
    (x) => x === null || typeof x === "string" || typeof x === "number" || typeof x === "boolean",
  );

  if (allPrimitive) {
    // Build inline representation; quote strings inside arrays so the
    // reader can tell scalars apart.
    const parts = arr.map((x) => {
      if (typeof x === "string") return JSON.stringify(x);
      if (x === null || x === undefined) return "null";
      return String(x);
    });
    const inline = "[" + parts.join(", ") + "]";
    // The visible (unpainted) length is what matters for fit; paint
    // wraps in escapes that don't take screen columns.
    if (inline.length <= INLINE_ARRAY_WIDTH) {
      // Color each piece individually so quoted strings get the str color.
      const painted = arr.map((x) => {
        if (typeof x === "string") return paint(JSON.stringify(x), "str", mode);
        if (typeof x === "number") return paint(String(x), "num", mode);
        if (typeof x === "boolean") return paint(String(x), "bool", mode);
        return paint("null", "null", mode);
      });
      return "[" + painted.join(", ") + "]";
    }
    // Per-line fallback. One element per line, indented one level
    // deeper than the current scope. Render primitives in their quoted
    // JSON-ish form so strings stay visually distinct from numbers.
    const indent = indentStr(depth + 1, opts);
    return "\n" + arr
      .map((x) => {
        if (typeof x === "string") return indent + paint(JSON.stringify(x), "str", mode);
        if (typeof x === "number") return indent + paint(String(x), "num", mode);
        if (typeof x === "boolean") return indent + paint(String(x), "bool", mode);
        return indent + paint("null", "null", mode);
      })
      .join("\n");
  }

  // Array of objects: one element per line, deeper indent, render each.
  const indent = indentStr(depth + 1, opts);
  return "\n" + arr
    .map((x) => indent + prettyValue(x, opts, depth + 1))
    .join("\n");
}

function renderObject(obj: Record<string, unknown>, opts: PrettyOptions, depth: number): string {
  const mode = resolveMode(opts.mode);
  const keys = Object.keys(obj);
  if (keys.length === 0) return emDash(mode);
  return renderFields(
    keys.map((k) => ({ key: k, value: obj[k] })),
    opts,
    depth,
  );
}

/**
 * Render a list of {key, value} pairs as a left-aligned field block.
 * Each line is `<indent><key padded to keyWidth>  <value or first
 * line>`. Multi-line values continue with their lines (no extra indent
 * for content already shaped by `\n` like ┃ blocks) — that keeps the
 * left edge of the bar aligned across all lines of the value.
 */
function renderFields(
  fields: Array<{ key: string; value: unknown; meta?: string }>,
  opts: PrettyOptions,
  depth: number,
): string {
  const mode = resolveMode(opts.mode);
  if (fields.length === 0) return emDash(mode);
  const keyWidth = maxKeyWidth(fields.map((f) => f.key));
  const indent = indentStr(depth + 1, opts);
  const lines: string[] = [];

  for (const f of fields) {
    const rendered = prettyValue(f.value, opts, depth + 1);
    const paddedKey = paint(f.key.padEnd(keyWidth), "key", mode);
    const meta = f.meta ? "  " + paint(f.meta, "meta", mode) : "";

    if (rendered.startsWith("\n")) {
      // Nested block (array per-line or nested object render) — let it
      // flow on its own lines after the key line.
      lines.push(`${indent}${paddedKey}${meta}${rendered}`);
    } else if (rendered.includes("\n")) {
      // Multi-line content (e.g. ┃ block). Continuation lines align to
      // the column where the value started so the ┃ bar stays straight.
      const valueLines = rendered.split("\n");
      const continuation = " ".repeat(indent.length + keyWidth + 2);
      lines.push(`${indent}${paddedKey}  ${valueLines[0]}${meta}`);
      for (const l of valueLines.slice(1)) lines.push(continuation + l);
    } else {
      lines.push(`${indent}${paddedKey}  ${rendered}${meta}`);
    }
  }

  return "\n" + lines.join("\n");
}

// ─── tab entry points ────────────────────────────────────────────────

interface ActionShape {
  kind: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  text?: string;
  sub_agent?: string;
}

interface OutcomeShape {
  status: string;
  summary?: string;
  tool_result_ref?: string;
  is_error?: boolean;
  state_delta?: unknown;
}

interface CostShape {
  tokens: {
    input: number;
    output: number;
    cached_read?: number;
    cache_creation?: number;
  };
  latency_ms: number;
  cost_cents: number;
  tags: string[];
}

function sectionHeader(name: string, suffix: string | undefined, mode: PrettyMode): string {
  const base = paint(name, "section", mode);
  if (!suffix) return base;
  return `${base}  ${paint(suffix, "meta", mode)}`;
}

function renderAction(a: ActionShape, opts: PrettyOptions): string {
  const mode = resolveMode(opts.mode);

  if (a.kind === "none") {
    return `${paint("action", "section", mode)}  ${emDash(mode)}`;
  }

  const fields: Array<{ key: string; value: unknown; meta?: string }> = [];
  fields.push({ key: "kind", value: a.kind });

  if (a.kind === "tool_call") {
    if (a.tool_name) {
      fields.push({
        key: "tool",
        value: a.tool_name,
        meta: a.tool_use_id ? `[${a.tool_use_id}]` : undefined,
      });
    }
    if (a.tool_input !== undefined) {
      fields.push({ key: "input", value: a.tool_input });
    }
  } else if (a.kind === "message") {
    if (a.text !== undefined) {
      fields.push({ key: "message", value: a.text });
    }
  } else if (a.kind === "thinking_only") {
    if (a.text !== undefined) {
      fields.push({ key: "thinking", value: a.text });
    }
  } else if (a.kind === "sub_agent_dispatch") {
    if (a.sub_agent) fields.push({ key: "sub_agent", value: a.sub_agent });
    if (a.text !== undefined) fields.push({ key: "message", value: a.text });
  } else {
    // Unknown kinds: render whatever extra fields exist after kind.
    for (const k of Object.keys(a)) {
      if (k === "kind") continue;
      const v = (a as Record<string, unknown>)[k];
      if (v !== undefined) fields.push({ key: k, value: v });
    }
  }

  return paint("action", "section", mode) + renderFields(fields, opts, 0);
}

function renderOutcome(o: OutcomeShape, opts: PrettyOptions): string {
  const mode = resolveMode(opts.mode);
  const fields: Array<{ key: string; value: unknown; meta?: string }> = [];

  const statusColor: Color =
    o.status === "error" ? "error" : o.status === "pending" ? "pending" : "ok";
  fields.push({
    key: "status",
    value: { __painted: paint(o.status, statusColor, mode) },
  });

  if (o.summary !== undefined && o.summary !== null && o.summary !== "") {
    fields.push({ key: "summary", value: o.summary });
  }

  if (o.tool_result_ref) {
    const shortRef = o.tool_result_ref.slice(0, 12);
    if (opts.toolResultText !== undefined) {
      // Inline the resolved text. Meta is "blob abcd… · 1.2 kB" plus,
      // in HTML mode only, a non-escaped "view raw" anchor.
      const size = `${(opts.toolResultText.length / 1024).toFixed(1)} kB`;
      const metaText = `blob ${shortRef}… · ${size}`;
      const metaHtml =
        opts.mode === "html" && opts.rawBlobHref
          ? ` <a href="${escHtml(opts.rawBlobHref)}" class="p-meta">view raw</a>`
          : "";
      const painted = paint(metaText, "meta", mode) + metaHtml;
      fields.push({ key: "result", value: opts.toolResultText, metaPainted: painted });
    } else {
      const metaText = `blob ${shortRef}…`;
      fields.push({
        key: "result",
        value: { __painted: paint("(blob ref)", "meta", mode) },
        metaPainted: paint(metaText, "meta", mode),
      });
    }
  }

  if (o.is_error) {
    fields.push({ key: "is_error", value: true });
  }

  if (o.state_delta !== undefined && o.state_delta !== null) {
    fields.push({ key: "state_delta", value: o.state_delta });
  }

  return paint("outcome", "section", mode) + renderFieldsWithPaintEscape(fields, opts, 0);
}

/**
 * Variant of renderFields that allows a field's value to be a
 * pre-painted string (object with __painted key). Used by renderOutcome
 * for the status field where we colorize "ok"/"error" with the
 * status-specific color, not the generic str color.
 */
function renderFieldsWithPaintEscape(
  fields: Array<{ key: string; value: unknown; meta?: string; metaPainted?: string }>,
  opts: PrettyOptions,
  depth: number,
): string {
  const mode = resolveMode(opts.mode);
  if (fields.length === 0) return emDash(mode);
  const keyWidth = maxKeyWidth(fields.map((f) => f.key));
  const indent = indentStr(depth + 1, opts);
  const lines: string[] = [];

  for (const f of fields) {
    let rendered: string;
    if (
      isPlainObject(f.value) &&
      "__painted" in f.value &&
      typeof (f.value as { __painted: unknown }).__painted === "string"
    ) {
      rendered = (f.value as { __painted: string }).__painted;
    } else {
      rendered = prettyValue(f.value, opts, depth + 1);
    }
    const paddedKey = paint(f.key.padEnd(keyWidth), "key", mode);
    let meta = "";
    if (f.metaPainted) meta = "  " + f.metaPainted;
    else if (f.meta) meta = "  " + paint(f.meta, "meta", mode);

    if (rendered.startsWith("\n")) {
      lines.push(`${indent}${paddedKey}${meta}${rendered}`);
    } else if (rendered.includes("\n")) {
      const valueLines = rendered.split("\n");
      const continuation = " ".repeat(indent.length + keyWidth + 2);
      lines.push(`${indent}${paddedKey}  ${valueLines[0]}${meta}`);
      for (const l of valueLines.slice(1)) lines.push(continuation + l);
    } else {
      lines.push(`${indent}${paddedKey}  ${rendered}${meta}`);
    }
  }
  return "\n" + lines.join("\n");
}

function renderCost(c: CostShape, opts: PrettyOptions): string {
  const mode = resolveMode(opts.mode);
  const fields: Array<{ key: string; value: unknown; meta?: string }> = [];

  // tokens — compressed single-line summary.
  const tokParts: string[] = [];
  tokParts.push(`${fmtTokens(c.tokens.input)} in`);
  tokParts.push(`${fmtTokens(c.tokens.output)} out`);
  if (c.tokens.cached_read !== undefined && c.tokens.cached_read > 0) {
    tokParts.push(`${fmtTokens(c.tokens.cached_read)} cached read`);
  }
  if (c.tokens.cache_creation !== undefined && c.tokens.cache_creation > 0) {
    tokParts.push(`${fmtTokens(c.tokens.cache_creation)} cache create`);
  }
  fields.push({
    key: "tokens",
    value: { __painted: paint(tokParts.join(" · "), "num", mode) },
  });

  fields.push({
    key: "latency",
    value: { __painted: paint(`${c.latency_ms} ms`, "num", mode) },
  });

  fields.push({
    key: "cost",
    value: { __painted: paint(fmtCents(c.cost_cents), "num", mode) },
  });

  if (c.tags && c.tags.length > 0) {
    fields.push({ key: "tags", value: c.tags.join(", ") });
  } else {
    fields.push({ key: "tags", value: null });
  }

  return paint("cost", "section", mode) + renderFieldsWithPaintEscape(fields, opts, 0);
}

function renderDecision(text: string, opts: PrettyOptions): string {
  const mode = resolveMode(opts.mode);

  if (text === undefined || text === null || text === "") {
    return `${paint("decision", "section", mode)}  ${emDash(mode)}`;
  }

  // Try to parse. If it works, render as an object.
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed) || Array.isArray(parsed)) {
      return paint("decision", "section", mode) + prettyValue(parsed, opts, 0);
    }
    // Scalar JSON (e.g. just a number or string) — render inline.
    return `${paint("decision", "section", mode)}  ${prettyValue(parsed, opts, 0)}`;
  } catch {
    // Parse failed. Distinguish truncated vs malformed.
    const suffix = opts.truncated ? "(truncated · view raw)" : "(not JSON)";
    const header = sectionHeader("decision", suffix, mode);
    const block = prettyMultilineString(text, opts);
    return `${header}\n${indentStr(1, opts)}${block.split("\n").join("\n" + indentStr(1, opts))}`;
  }
}

// ─── public entry ────────────────────────────────────────────────────

export function prettyTab(
  kind: TabKind,
  value: unknown,
  opts: PrettyOptions,
): string {
  const resolved: PrettyOptions = {
    ...opts,
    mode: resolveMode(opts.mode),
    maxStringLen: opts.maxStringLen ?? DEFAULT_MAX_STR,
    indent: opts.indent ?? DEFAULT_INDENT,
  };

  switch (kind) {
    case "action":
      return renderAction(value as ActionShape, resolved);
    case "outcome":
      return renderOutcome(value as OutcomeShape, resolved);
    case "decision":
      return renderDecision(value as string, resolved);
    case "cost":
      return renderCost(value as CostShape, resolved);
  }
}

// ─── replacement for the 3 prettyJson copies ─────────────────────────

/**
 * Parse a JSON string and re-stringify with 2-space indent. If the
 * input is not valid JSON, return it unchanged. Pure helper; no
 * coloring, no schema awareness. Replaces:
 *   - packages/cli/src/commands/inspect.ts:456 prettyJson
 *   - packages/server/src/html.ts:3068        prettyJson
 *   - packages/server/src/html.ts:3393        prettyJsonMaybe
 */
export function reformatJsonString(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
