import { test } from "node:test";
import assert from "node:assert/strict";
import { costCents, pricingFor } from "./pricing.ts";

/**
 * Regressions that pin the cost-formula behavior. These caught a real bug
 * where Spool priced 1h cache writes at the 5m rate, under-reporting cost
 * by ~37% on long Claude Code sessions.
 */

test("1h cache write costs the documented 2× input rate", () => {
  // Opus 4.7: input $15/M → 1h cache should be $30/M = 3000¢/M
  const r = costCents("claude-opus-4-7", {
    input: 0,
    output: 0,
    cached_read: 0,
    cache_creation: 0,
    cache_creation_1h: 1_000_000,
  });
  assert.equal(r.cost_cents, 3000, "1M tokens of 1h cache = 3000¢ on Opus");
});

test("5m cache write costs the documented 1.25× input rate", () => {
  const r = costCents("claude-opus-4-7", {
    input: 0,
    output: 0,
    cached_read: 0,
    cache_creation: 1_000_000,
  });
  assert.equal(r.cost_cents, 1875, "1M tokens of 5m cache = 1875¢ on Opus");
});

test("1h cache is meaningfully more expensive than 5m for the same token count", () => {
  const a = costCents("claude-opus-4-7", {
    input: 0, output: 0, cached_read: 0,
    cache_creation: 100_000,
  });
  const b = costCents("claude-opus-4-7", {
    input: 0, output: 0, cached_read: 0,
    cache_creation: 0, cache_creation_1h: 100_000,
  });
  assert.ok(b.cost_cents > a.cost_cents);
  // Ratio should be 30/18.75 = 1.6
  const ratio = b.cost_cents / a.cost_cents;
  assert.ok(
    ratio > 1.59 && ratio < 1.61,
    `expected 1h:5m ratio ≈ 1.6, got ${ratio.toFixed(3)}`,
  );
});

test("missing cache_creation_1h falls back to 0 (no spurious charges)", () => {
  const r = costCents("claude-opus-4-7", {
    input: 100,
    output: 0,
    cached_read: 0,
    cache_creation: 0,
    // cache_creation_1h omitted
  });
  // 100 input tokens × 1500¢/M = 0.15¢
  assert.equal(r.cost_cents, 0.15);
});

test("unknown model falls back to fallback pricing and is flagged approx", () => {
  const r = costCents("imaginary-model-9000", {
    input: 1_000_000, output: 0, cached_read: 0, cache_creation: 0,
  });
  assert.equal(r.approx, true);
  assert.equal(r.cost_cents, 1500); // fallback mirrors Opus input rate
});

test("Sonnet 4.6 1h cache rate is exactly 2× input rate", () => {
  const { pricing } = pricingFor("claude-sonnet-4-6");
  assert.equal(
    pricing.cache_creation_1h_per_million_cents,
    pricing.input_per_million_cents * 2,
  );
});
