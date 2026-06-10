import type { ModelPricing } from "@spool-ai/shared";

/**
 * Cents per million tokens. Source: Anthropic public pricing as of May 2026.
 * If a model isn't listed, cost calc falls back to {@link PRICING_FALLBACK}
 * and the run is tagged `cost:approx`.
 *
 * Cache write rates: Anthropic charges 1.25× input for the 5-minute
 * ephemeral cache and 2× input for the 1-hour ephemeral cache. Claude
 * Code uses the 1-hour cache for the long-lived system prompt + tool
 * defs, which is typically the dominant cost line on long sessions.
 *
 * Numbers chosen conservatively — pricing tables drift, and Spool's role is
 * "give the operator a magnitude," not "audit the invoice."
 */
export const PRICING: ModelPricing[] = [
  {
    model: "claude-opus-4-7",
    input_per_million_cents: 1500,
    output_per_million_cents: 7500,
    cached_read_per_million_cents: 150,
    cache_creation_per_million_cents: 1875,
    cache_creation_1h_per_million_cents: 3000,
  },
  {
    model: "claude-opus-4-6",
    input_per_million_cents: 1500,
    output_per_million_cents: 7500,
    cached_read_per_million_cents: 150,
    cache_creation_per_million_cents: 1875,
    cache_creation_1h_per_million_cents: 3000,
  },
  {
    model: "claude-opus-4-5",
    input_per_million_cents: 1500,
    output_per_million_cents: 7500,
    cached_read_per_million_cents: 150,
    cache_creation_per_million_cents: 1875,
    cache_creation_1h_per_million_cents: 3000,
  },
  {
    model: "claude-sonnet-4-6",
    input_per_million_cents: 300,
    output_per_million_cents: 1500,
    cached_read_per_million_cents: 30,
    cache_creation_per_million_cents: 375,
    cache_creation_1h_per_million_cents: 600,
  },
  {
    model: "claude-sonnet-4-5",
    input_per_million_cents: 300,
    output_per_million_cents: 1500,
    cached_read_per_million_cents: 30,
    cache_creation_per_million_cents: 375,
    cache_creation_1h_per_million_cents: 600,
  },
  {
    model: "claude-haiku-4-5-20251001",
    input_per_million_cents: 80,
    output_per_million_cents: 400,
    cached_read_per_million_cents: 8,
    cache_creation_per_million_cents: 100,
    cache_creation_1h_per_million_cents: 160,
  },
  // ── OpenAI ────────────────────────────────────────────────────────────
  // OpenAI prompt caching exposes only one tier (no 5m/1h split), so the
  // cache_creation rate matches input (writes are free), and cached_read
  // gets the discounted rate. cache_creation_1h is N/A — left as 2× input
  // by the costCents() fallback so the math doesn't break.
  {
    model: "gpt-5",
    input_per_million_cents: 125,
    output_per_million_cents: 1000,
    cached_read_per_million_cents: 12,
    cache_creation_per_million_cents: 125,
  },
  {
    model: "gpt-5-mini",
    input_per_million_cents: 25,
    output_per_million_cents: 200,
    cached_read_per_million_cents: 2,
    cache_creation_per_million_cents: 25,
  },
  {
    model: "gpt-4o",
    input_per_million_cents: 250,
    output_per_million_cents: 1000,
    cached_read_per_million_cents: 125,
    cache_creation_per_million_cents: 250,
  },
  {
    model: "gpt-4o-mini",
    input_per_million_cents: 15,
    output_per_million_cents: 60,
    cached_read_per_million_cents: 7,
    cache_creation_per_million_cents: 15,
  },
  {
    model: "gpt-4-turbo",
    input_per_million_cents: 1000,
    output_per_million_cents: 3000,
    cached_read_per_million_cents: 500,
    cache_creation_per_million_cents: 1000,
  },
  {
    model: "o1",
    input_per_million_cents: 1500,
    output_per_million_cents: 6000,
    cached_read_per_million_cents: 750,
    cache_creation_per_million_cents: 1500,
  },
  {
    model: "o1-mini",
    input_per_million_cents: 110,
    output_per_million_cents: 440,
    cached_read_per_million_cents: 55,
    cache_creation_per_million_cents: 110,
  },
  {
    model: "o3",
    input_per_million_cents: 1000,
    output_per_million_cents: 4000,
    cached_read_per_million_cents: 250,
    cache_creation_per_million_cents: 1000,
  },
  {
    model: "o3-mini",
    input_per_million_cents: 110,
    output_per_million_cents: 440,
    cached_read_per_million_cents: 55,
    cache_creation_per_million_cents: 110,
  },
];

export const PRICING_FALLBACK: ModelPricing = {
  model: "unknown",
  input_per_million_cents: 1500,
  output_per_million_cents: 7500,
  cached_read_per_million_cents: 150,
  cache_creation_per_million_cents: 1875,
  cache_creation_1h_per_million_cents: 3000,
};

export function pricingFor(model: string): { pricing: ModelPricing; approx: boolean } {
  for (const row of PRICING) {
    if (model === row.model || model.startsWith(row.model)) {
      return { pricing: row, approx: false };
    }
  }
  return { pricing: PRICING_FALLBACK, approx: true };
}

export interface UsageCents {
  input: number;
  output: number;
  cached_read: number;
  /** 5-minute ephemeral cache write tokens. */
  cache_creation: number;
  /** 1-hour ephemeral cache write tokens (optional). */
  cache_creation_1h?: number;
}

/**
 * Compute cost (in fractional cents) for one step from a token-usage breakdown.
 * Returns a float — caller rounds when persisting.
 *
 * The 1h cache rate falls back to 2× input price when a model entry
 * doesn't specify it explicitly — this matches Anthropic's published
 * formula and avoids silently zero-pricing the dominant cost line on
 * Claude Code-style sessions.
 */
export function costCents(
  model: string,
  usage: UsageCents,
): { cost_cents: number; approx: boolean } {
  const { pricing, approx } = pricingFor(model);
  const cache1hRate =
    pricing.cache_creation_1h_per_million_cents ??
    pricing.input_per_million_cents * 2;
  const cost =
    (usage.input * pricing.input_per_million_cents) / 1_000_000 +
    (usage.output * pricing.output_per_million_cents) / 1_000_000 +
    (usage.cached_read * pricing.cached_read_per_million_cents) / 1_000_000 +
    (usage.cache_creation * pricing.cache_creation_per_million_cents) / 1_000_000 +
    ((usage.cache_creation_1h ?? 0) * cache1hRate) / 1_000_000;
  return { cost_cents: cost, approx };
}
