import { test } from "node:test";
import assert from "node:assert/strict";
import type { Step } from "@spool-ai/shared";
import { renderStepCardFragment } from "./html.ts";

/**
 * Markup regression for the pretty-print toggle work.
 *
 * Each step card now ships BOTH raw and pretty bodies pre-rendered
 * server-side, plus a per-step toggle button. These assertions lock
 * the contract the client JS depends on:
 *   - .pretty-toggle button exists per step, aria-pressed="false" at render
 *   - every action/outcome/decision/cost tab has both `<pre class="body raw">`
 *     and `<pre class="body pretty">` siblings
 *   - the pretty body contains schema-aware spans (.p-section, .p-key, etc.)
 */

function fakeStep(): Step {
  return {
    step_id: "stp_abc123",
    run_id: "run_xyz",
    sequence: 0,
    timestamp: "2026-05-19T00:00:00Z",
    model: "claude-opus-4-7",
    context_snapshot_id: "ctx_ref",
    decision_ref: "dec_ref",
    action: {
      kind: "tool_call",
      tool_name: "Edit",
      tool_use_id: "tu_e",
      tool_input: { file_path: "x.ts" },
    },
    outcome: {
      status: "ok",
      summary: "edit applied",
    },
    tokens: { input: 10, output: 5, cached_read: 0, cache_creation: 0 },
    latency_ms: 100,
    cost_cents: 1,
    tags: [],
    status: "ok",
  };
}

test("step card renders pretty-toggle button with aria-pressed=false and per-step data attrs", () => {
  const html = renderStepCardFragment(fakeStep(), "{}", []);
  assert.match(html, /class="pretty-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /data-step-id="stp_abc123"/);
  assert.match(html, /data-run-id="run_xyz"/);
  assert.match(html, /Pretty \(all tabs\)/);
});

test("step card emits both raw and pretty pre bodies for each of the four tabs", () => {
  const html = renderStepCardFragment(fakeStep(), "{}", []);
  // Each tab has both bodies. Count instances:
  const rawCount = (html.match(/class="body raw"/g) ?? []).length;
  const prettyCount = (html.match(/class="body pretty"/g) ?? []).length;
  assert.equal(rawCount, 4, "expected 4 raw <pre> bodies (decision/action/outcome/cost)");
  assert.equal(prettyCount, 4, "expected 4 pretty <pre> bodies");
});

test("step card pretty bodies contain schema-aware span classes", () => {
  const html = renderStepCardFragment(fakeStep(), "{}", []);
  assert.match(html, /<span class="p-section">action<\/span>/);
  assert.match(html, /<span class="p-section">outcome<\/span>/);
  assert.match(html, /<span class="p-section">cost<\/span>/);
  // Status field in outcome should use the ok-color class
  assert.match(html, /<span class="p-ok">ok<\/span>/);
});

test("step card raw bodies remain byte-identical to pre-PR JSON.stringify output for action", () => {
  const step = fakeStep();
  const html = renderStepCardFragment(step, "{}", []);
  // The raw action pre body should contain the literal JSON.stringify
  // (modulo HTML escaping of <, >, &, "). For this fixture there are
  // no special chars to escape, so it should match verbatim.
  const expected = JSON.stringify(step.action, null, 2);
  // Escape the same way html.ts esc() does for our assertion:
  const expectedEscaped = expected
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  assert.ok(
    html.includes(expectedEscaped),
    "raw action body changed — possible regression",
  );
});

test("step card decision tab handles malformed JSON without throwing", () => {
  const html = renderStepCardFragment(fakeStep(), "not json", []);
  assert.match(html, /class="body raw"/);
  assert.match(html, /not JSON/);
});
