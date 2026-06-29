import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { DEFAULT_RULES, redactString } from "./redact.ts";

/**
 * Property-based tests for the redaction layer (SPEC v0.3 §10.1).
 *
 * Combinatorial tests pin specific (rule, scenario) cells. These tests
 * express invariants that hold across the entire input space: any
 * string that fast-check can generate must satisfy them. Each property
 * runs the default 100 randomized cases per `fc.assert` call, with
 * automatic shrinking on failure.
 */

/**
 * Arbitraries for fake-but-shape-correct secrets matching each rule.
 * Each one uses a bounded alphabet via `fc.string({ unit })` so every
 * generated string matches the rule by construction — no `.filter()`
 * fallback (which would have rejection rates so high fast-check would
 * spin for minutes).
 */
const charFrom = (chars: string) => fc.constantFrom(...chars.split(""));
const ALPHA_NUM_DASH_UNDERSCORE = charFrom(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-",
);
const ALPHA_NUM = charFrom(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
);
const UPPER_NUM = charFrom("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
const BEARER_BODY = charFrom(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.=",
);

const secret = {
  anthropic: fc
    .string({
      unit: ALPHA_NUM_DASH_UNDERSCORE,
      minLength: 20,
      maxLength: 40,
    })
    .map((s) => `sk-ant-api03-${s}`),
  openai: fc
    .string({
      unit: ALPHA_NUM_DASH_UNDERSCORE,
      minLength: 20,
      maxLength: 40,
    })
    .map((s) => `sk-proj-${s}`),
  github: fc
    .string({ unit: ALPHA_NUM, minLength: 36, maxLength: 50 })
    .map((s) => `ghp_${s}`),
  aws: fc
    .string({ unit: UPPER_NUM, minLength: 16, maxLength: 16 })
    .map((s) => `AKIA${s}`),
  bearer: fc
    .string({ unit: BEARER_BODY, minLength: 20, maxLength: 40 })
    .map((s) => `Bearer ${s}`),
};

const anySecret = fc.oneof(
  secret.anthropic,
  secret.openai,
  secret.github,
  secret.aws,
  secret.bearer,
);

/**
 * Innocuous string that can't form any rule's prefix by construction.
 * Alphabet deliberately omits `s`, `k`, `g`, `h`, all uppercase, and
 * `-` so the generator literally cannot produce `sk-`, `ghp_`, `AKIA`,
 * `Bearer `, or `-----BEGIN`. No `.filter()` needed — every generated
 * string is safe-by-construction. Faster, and immune to the
 * `string.filter` rejection-rate trap that earlier versions hit.
 */
const INNOCUOUS_CHARS = charFrom("abcdefijlmnopqrtuvwxyz0123456789 .,\n");
const innocuous = fc.string({
  unit: INNOCUOUS_CHARS,
  minLength: 0,
  maxLength: 100,
});

/* ────────────────────────────────────────────────────────────────────
 * Property 1 — Idempotence.
 *
 * Redacting an already-redacted string is a no-op. If this fails, the
 * placeholder format `«meter:redacted:NAME»` accidentally matches some
 * rule's regex, and repeated passes would inflate the redaction count
 * or corrupt the text.
 * ──────────────────────────────────────────────────────────────────── */
test("property: redactString is idempotent — redact(redact(x)) === redact(x)", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(innocuous, anySecret), { maxLength: 6 }),
      (parts) => {
        const input = parts.join("\n");
        const once = redactString(input);
        const twice = redactString(once.text);
        return twice.text === once.text && twice.redactions.length === 0;
      },
    ),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 2 — No secret survives.
 *
 * After redaction, no rule's pattern matches the output. This is the
 * security-critical invariant: a real secret leaking past the
 * redactor is the failure mode redaction exists to prevent.
 * ──────────────────────────────────────────────────────────────────── */
test("property: after redaction, no rule pattern matches the output", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(innocuous, anySecret), { minLength: 1, maxLength: 10 }),
      (parts) => {
        const input = parts.join(" ");
        const { text } = redactString(input);
        for (const rule of DEFAULT_RULES) {
          // Clone the regex with a fresh lastIndex — DEFAULT_RULES uses
          // the `g` flag so reusing it across calls would skip matches.
          const fresh = new RegExp(rule.pattern.source, rule.pattern.flags);
          if (fresh.test(text)) {
            return false;
          }
        }
        return true;
      },
    ),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 3 — Redaction count never exceeds input matches.
 *
 * A rule should redact at most as many things as actually exist in
 * the input. If it ever reports more, the rule has accidentally
 * expanded its match surface mid-string (a bug we'd never see on
 * single-secret hand-written tests).
 * ──────────────────────────────────────────────────────────────────── */
test("property: per-rule redaction count is bounded by the rule's match count on the raw input", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(innocuous, anySecret), { maxLength: 8 }),
      (parts) => {
        const input = parts.join("\n");
        const result = redactString(input);
        for (const r of result.redactions) {
          const rule = DEFAULT_RULES.find((d) => d.name === r.rule)!;
          // Count matches on the ORIGINAL input — that's the upper bound.
          // Rules that fire later may see fewer matches because earlier
          // rules redacted overlapping substrings, but the count for
          // any given rule must never exceed its standalone match count.
          const fresh = new RegExp(rule.pattern.source, rule.pattern.flags);
          const standalone = input.match(fresh)?.length ?? 0;
          if (r.count > standalone) {
            return false;
          }
        }
        return true;
      },
    ),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 4 — METERBILITY_REDACT=off is a perfect pass-through.
 *
 * The off switch must return input verbatim with zero redactions,
 * regardless of how many secrets the input contains. This is the
 * test-mode / debug-mode contract — anyone setting the env var
 * needs the bytes to come through unchanged.
 * ──────────────────────────────────────────────────────────────────── */
test("property: METERBILITY_REDACT=off returns the input verbatim with zero redactions", () => {
  const original = process.env.METERBILITY_REDACT;
  process.env.METERBILITY_REDACT = "off";
  try {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(innocuous, anySecret), { maxLength: 8 }),
        (parts) => {
          const input = parts.join("\n");
          const result = redactString(input);
          return result.text === input && result.redactions.length === 0;
        },
      ),
    );
  } finally {
    if (original === undefined) delete process.env.METERBILITY_REDACT;
    else process.env.METERBILITY_REDACT = original;
  }
});

/* ────────────────────────────────────────────────────────────────────
 * Property 5 — The placeholder format is inert.
 *
 * Spelled out for the literal placeholder string with every rule
 * name. If any rule's regex matches its own placeholder, repeated
 * redaction would recursively replace itself and break property 1
 * (idempotence). Property 1 covers this empirically; this one pins
 * it directly so the failure message is precise.
 * ──────────────────────────────────────────────────────────────────── */
test("property: no rule's regex matches the placeholder for any other rule", () => {
  for (const rule of DEFAULT_RULES) {
    const placeholder = `«meter:redacted:${rule.name}»`;
    for (const other of DEFAULT_RULES) {
      const fresh = new RegExp(other.pattern.source, other.pattern.flags);
      assert.equal(
        fresh.test(placeholder),
        false,
        `rule ${other.name} matches placeholder for ${rule.name}`,
      );
    }
  }
});
