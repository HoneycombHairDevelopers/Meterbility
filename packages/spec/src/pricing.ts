import type { ModelPricing } from "@spool/shared";

/**
 * Cents per million tokens. Source: Anthropic public pricing as of May 2026.
 * If a model isn't listed, cost calc falls back to {@link PRICING_FALLBACK}
 * and the run is tagged `cost:approx`.
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
  },
  {
    model: "claude-opus-4-6",
    input_per_million_cents: 1500,
    output_per_million_cents: 7500,
    cached_read_per_million_cents: 150,
    cache_creation_per_million_cents: 1875,
  },
  {
    model: "claude-opus-4-5",
    input_per_million_cents: 1500,
    output_per_million_cents: 7500,
    cached_read_per_million_cents: 150,
    cache_creation_per_million_cents: 1875,
  },
  {
    model: "claude-sonnet-4-6",
    input_per_million_cents: 300,
    output_per_million_cents: 1500,
    cached_read_per_million_cents: 30,
    cache_creation_per_million_cents: 375,
  },
  {
    model: "claude-sonnet-4-5",
    input_per_million_cents: 300,
    output_per_million_cents: 1500,
    cached_read_per_million_cents: 30,
    cache_creation_per_million_cents: 375,
  },
  {
    model: "claude-haiku-4-5-20251001",
    input_per_million_cents: 80,
    output_per_million_cents: 400,
    cached_read_per_million_cents: 8,
    cache_creation_per_million_cents: 100,
  },
];

export const PRICING_FALLBACK: ModelPricing = {
  model: "unknown",
  input_per_million_cents: 1500,
  output_per_million_cents: 7500,
  cached_read_per_million_cents: 150,
  cache_creation_per_million_cents: 1875,
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
  cache_creation: number;
}

/**
 * Compute cost (in fractional cents) for one step from a token-usage breakdown.
 * Returns a float — caller rounds when persisting.
 */
export function costCents(
  model: string,
  usage: UsageCents,
): { cost_cents: number; approx: boolean } {
  const { pricing, approx } = pricingFor(model);
  const cost =
    (usage.input * pricing.input_per_million_cents) / 1_000_000 +
    (usage.output * pricing.output_per_million_cents) / 1_000_000 +
    (usage.cached_read * pricing.cached_read_per_million_cents) / 1_000_000 +
    (usage.cache_creation * pricing.cache_creation_per_million_cents) / 1_000_000;
  return { cost_cents: cost, approx };
}
