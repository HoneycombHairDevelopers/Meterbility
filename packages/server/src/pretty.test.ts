import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prettyTab,
  prettyValue,
  prettyMultilineString,
  reformatJsonString,
  type PrettyOptions,
} from "./pretty.ts";

const PLAIN: PrettyOptions = { mode: "plain" };
const HTML: PrettyOptions = { mode: "html" };
const ANSI: PrettyOptions = { mode: "ansi" };

// ─── scalars ─────────────────────────────────────────────────────────

test("prettyValue: null → em-dash", () => {
  assert.equal(prettyValue(null, PLAIN, 0), "—");
});

test("prettyValue: undefined → em-dash", () => {
  assert.equal(prettyValue(undefined, PLAIN, 0), "—");
});

test("prettyValue: empty string → em-dash", () => {
  assert.equal(prettyValue("", PLAIN, 0), "—");
});

test("prettyValue: boolean true/false render verbatim", () => {
  assert.equal(prettyValue(true, PLAIN, 0), "true");
  assert.equal(prettyValue(false, PLAIN, 0), "false");
});

test("prettyValue: number renders verbatim in plain mode", () => {
  assert.equal(prettyValue(42, PLAIN, 0), "42");
  assert.equal(prettyValue(3.14, PLAIN, 0), "3.14");
});

test("prettyValue: single-line string renders as-is", () => {
  assert.equal(prettyValue("hello world", PLAIN, 0), "hello world");
});

// ─── multi-line strings ──────────────────────────────────────────────

test("prettyMultilineString: \\n splits into ┃ block", () => {
  const out = prettyMultilineString("line one\nline two\nline three", PLAIN);
  assert.equal(out, "┃ line one\n┃ line two\n┃ line three");
});

test("prettyMultilineString: \\r\\n normalized to \\n", () => {
  const out = prettyMultilineString("a\r\nb\r\nc", PLAIN);
  assert.equal(out, "┃ a\n┃ b\n┃ c");
});

test("prettyMultilineString: truncates at maxStringLen with hint", () => {
  const big = "a".repeat(5000) + "\nshould be cut";
  const out = prettyMultilineString(big, { mode: "plain", maxStringLen: 100 });
  assert.match(out, /… \(4914 more chars\)/);
  // Should still have ┃ prefix on the truncated content
  assert.match(out, /^┃ a/);
});

test("prettyValue: string with \\n routes through multiline block", () => {
  const out = prettyValue("a\nb", PLAIN, 0);
  assert.equal(out, "┃ a\n┃ b");
});

// ─── arrays ──────────────────────────────────────────────────────────

test("prettyValue: empty array → em-dash", () => {
  assert.equal(prettyValue([], PLAIN, 0), "—");
});

test("prettyValue: small array of primitives renders inline with quotes", () => {
  const out = prettyValue(["a", "b", "c"], PLAIN, 0);
  assert.equal(out, '["a", "b", "c"]');
});

test("prettyValue: mixed array of primitives quotes strings, not numbers", () => {
  const out = prettyValue(["a", 1, true, null], PLAIN, 0);
  assert.equal(out, '["a", 1, true, null]');
});

test("prettyValue: very wide array of primitives spills per-line", () => {
  const arr = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "ffffffff", "gggggggg"];
  const out = prettyValue(arr, PLAIN, 0);
  // Should start with newline + per-element indented lines
  assert.match(out, /^\n {2}/);
  // Each element should be quoted on its own line
  for (const s of arr) assert.match(out, new RegExp(`"${s}"`));
});

// ─── depth cap ───────────────────────────────────────────────────────

test("prettyValue: hits depth cap at 16 and emits marker", () => {
  // Build a 20-deep nested object
  let v: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 20; i++) {
    v = { nested: v };
  }
  const out = prettyValue(v, PLAIN, 0);
  assert.match(out, /… \(deeper structure\)/);
});

// ─── prettyTab: cost ─────────────────────────────────────────────────

test("prettyTab cost: full cost block formats tokens/latency/cents/tags", () => {
  const out = prettyTab(
    "cost",
    {
      tokens: { input: 128, output: 64, cached_read: 1234, cache_creation: 0 },
      latency_ms: 312,
      cost_cents: 0.21,
      tags: ["simulate_miss"],
    },
    PLAIN,
  );
  assert.match(out, /^cost\n/);
  assert.match(out, /tokens.*128 in · 64 out · 1\.2k cached read/);
  assert.match(out, /latency.*312 ms/);
  assert.match(out, /cost.*\$0\.0021/);
  assert.match(out, /tags.*simulate_miss/);
});

test("prettyTab cost: empty tags → em-dash", () => {
  const out = prettyTab(
    "cost",
    {
      tokens: { input: 1, output: 1 },
      latency_ms: 10,
      cost_cents: 0,
      tags: [],
    },
    PLAIN,
  );
  assert.match(out, /tags.*—/);
  assert.match(out, /cost.*\$0\.00/);
});

// ─── prettyTab: action ───────────────────────────────────────────────

test("prettyTab action: kind=none → em-dash", () => {
  const out = prettyTab("action", { kind: "none" }, PLAIN);
  assert.equal(out, "action  —");
});

test("prettyTab action: tool_call with tool_input renders nested", () => {
  const out = prettyTab(
    "action",
    {
      kind: "tool_call",
      tool_name: "Edit",
      tool_use_id: "toolu_01ab",
      tool_input: {
        file_path: "x.ts",
        old_string: "foo\nbar",
      },
    },
    PLAIN,
  );
  assert.match(out, /^action\n/);
  assert.match(out, /kind.*tool_call/);
  assert.match(out, /tool.*Edit.*\[toolu_01ab\]/);
  assert.match(out, /file_path.*x\.ts/);
  assert.match(out, /old_string.*┃ foo/);
  assert.match(out, /┃ bar/);
});

test("prettyTab action: message renders text as ┃ block", () => {
  const out = prettyTab(
    "action",
    { kind: "message", text: "all done\nfinished" },
    PLAIN,
  );
  assert.match(out, /message.*┃ all done/);
  assert.match(out, /┃ finished/);
});

test("prettyTab action: thinking_only renders text under 'thinking'", () => {
  const out = prettyTab(
    "action",
    { kind: "thinking_only", text: "let me think" },
    PLAIN,
  );
  assert.match(out, /thinking.*let me think/);
});

// ─── prettyTab: outcome ──────────────────────────────────────────────

test("prettyTab outcome: ok status + summary", () => {
  const out = prettyTab(
    "outcome",
    { status: "ok", summary: "edit applied · +4 −4 lines" },
    PLAIN,
  );
  assert.match(out, /^outcome\n/);
  assert.match(out, /status.*ok/);
  assert.match(out, /summary.*edit applied/);
});

test("prettyTab outcome: tool_result_ref with toolResultText inlines content", () => {
  const out = prettyTab(
    "outcome",
    { status: "ok", tool_result_ref: "abcd1234efgh5678" },
    { mode: "plain", toolResultText: "the actual result text" },
  );
  assert.match(out, /result/);
  assert.match(out, /blob abcd1234efgh…/);
  assert.match(out, /the actual result text/);
});

test("prettyTab outcome: tool_result_ref without text shows ref only", () => {
  const out = prettyTab(
    "outcome",
    { status: "ok", tool_result_ref: "abcd1234efgh5678" },
    PLAIN,
  );
  assert.match(out, /result.*blob abcd1234efgh…/);
});

test("prettyTab outcome: state_delta renders as nested block", () => {
  const out = prettyTab(
    "outcome",
    {
      status: "ok",
      state_delta: { cwd: "/tmp/foo" },
    },
    PLAIN,
  );
  assert.match(out, /state_delta/);
  assert.match(out, /cwd.*\/tmp\/foo/);
});

// ─── prettyTab: decision ─────────────────────────────────────────────

test("prettyTab decision: valid JSON renders parsed object", () => {
  const out = prettyTab(
    "decision",
    JSON.stringify({ thinking: "hello", next_tool: "Read" }),
    PLAIN,
  );
  assert.match(out, /^decision\n/);
  assert.match(out, /thinking.*hello/);
  assert.match(out, /next_tool.*Read/);
});

test("prettyTab decision: valid JSON with multi-line string renders ┃ block", () => {
  const out = prettyTab(
    "decision",
    JSON.stringify({ thinking: "line one\nline two" }),
    PLAIN,
  );
  assert.match(out, /thinking.*┃ line one/);
  assert.match(out, /┃ line two/);
});

test("prettyTab decision: malformed JSON falls back to (not JSON) block", () => {
  const out = prettyTab("decision", "sorry, I cannot help with that", PLAIN);
  assert.match(out, /^decision\s+\(not JSON\)/);
  assert.match(out, /┃ sorry, I cannot help with that/);
});

test("prettyTab decision: truncated JSON shows (truncated · view raw)", () => {
  // Caller signals truncation explicitly.
  const partial = '{"thinking": "this got cut off ';
  const out = prettyTab("decision", partial, {
    mode: "plain",
    truncated: true,
  });
  assert.match(out, /^decision\s+\(truncated · view raw\)/);
  assert.match(out, /┃ \{"thinking": "this got cut off/);
});

test("prettyTab decision: empty/null → em-dash", () => {
  assert.equal(prettyTab("decision", "", PLAIN), "decision  —");
});

// ─── modes ───────────────────────────────────────────────────────────

test("ansi mode emits ANSI escape codes", () => {
  const out = prettyTab(
    "cost",
    { tokens: { input: 1, output: 1 }, latency_ms: 1, cost_cents: 1, tags: [] },
    ANSI,
  );
  // Should contain at least one escape sequence
  // eslint-disable-next-line no-control-regex
  assert.match(out, /\x1b\[/);
});

test("ansi mode + NO_COLOR=1 falls back to plain", () => {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const out = prettyTab(
      "cost",
      { tokens: { input: 1, output: 1 }, latency_ms: 1, cost_cents: 1, tags: [] },
      ANSI,
    );
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\x1b\[/);
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});

test("html mode emits spans and escapes HTML", () => {
  const out = prettyTab(
    "action",
    {
      kind: "tool_call",
      tool_name: "Edit",
      tool_input: { html_field: '<script>alert("x")</script>' },
    },
    HTML,
  );
  assert.match(out, /<span class="p-section">action<\/span>/);
  assert.match(out, /<span class="p-key">/);
  // The angle brackets and quotes in the value must be escaped
  assert.match(out, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test("html mode: outcome with rawBlobHref renders 'view raw' anchor", () => {
  const out = prettyTab(
    "outcome",
    { status: "ok", tool_result_ref: "abcd1234efgh5678" },
    {
      mode: "html",
      toolResultText: "result body",
      rawBlobHref: "/api/blob/abcd1234efgh5678",
    },
  );
  assert.match(out, /<a href="\/api\/blob\/abcd1234efgh5678"[^>]*>view raw<\/a>/);
});

test("html mode: error status uses p-error class", () => {
  const out = prettyTab("outcome", { status: "error", summary: "boom" }, HTML);
  assert.match(out, /<span class="p-error">error<\/span>/);
});

// ─── reformatJsonString ──────────────────────────────────────────────

test("reformatJsonString: valid JSON gets re-indented", () => {
  const out = reformatJsonString('{"a":1,"b":[2,3]}');
  assert.equal(out, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
});

test("reformatJsonString: invalid JSON returns the input verbatim", () => {
  const input = "not actually json {[}";
  assert.equal(reformatJsonString(input), input);
});

test("reformatJsonString: empty string returned verbatim (not parseable)", () => {
  // JSON.parse("") throws — match the existing prettyJson behavior of
  // returning the input unchanged on parse failure.
  assert.equal(reformatJsonString(""), "");
});
