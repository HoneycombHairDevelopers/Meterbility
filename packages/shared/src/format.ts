/**
 * Format a cost (stored in cents) as dollars. 2 decimals for anything
 * ≥ half a cent, 4 decimals for sub-cent costs so they don't collapse
 * to "$0.00". Used everywhere terminal and web display a cost so units
 * never mix.
 */
export function fmtCents(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (Math.abs(dollars) >= 0.005) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
