import { createHash } from "node:crypto";

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable JSON serialization for content addressing. Sorts object keys so
 * the same logical value always hashes identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, sortReplacer);
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}
