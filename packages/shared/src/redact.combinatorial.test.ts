import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, redactString } from "./redact.ts";

/**
 * Combinatorial coverage of the redaction surface (SPEC v0.3 §10.1).
 *
 * Six rules × six scenarios. Each cell is one `test()` so a failure
 * pinpoints the exact rule × scenario that broke. Sample secrets are
 * fake-but-shape-correct: 16-char AKIA keys, 36+ char GitHub tokens,
 * 20+ char Anthropic / OpenAI / Bearer payloads, full PEM envelopes.
 *
 * The complement to this file is `redact.properties.test.ts`, which
 * uses fast-check to express invariants that hold for ALL possible
 * inputs (idempotence, no-secret-survives, placeholder safety).
 */

/** Fake-but-shape-correct sample matching each DEFAULT_RULES regex. */
const SAMPLES: Record<string, string> = {
  "anthropic-key": "sk-ant-api03-aaaaaaaaaaaaaaaaaaaa",
  "openai-key": "sk-proj-bbbbbbbbbbbbbbbbbbbb",
  "github-token":
    "ghp_cccccccccccccccccccccccccccccccccccc",
  "aws-access-key": "AKIAIOSFODNN7EXAMPLE",
  bearer: "Bearer ddddddddddddddddddddddd",
  "private-key":
    "-----BEGIN RSA PRIVATE KEY-----\n" +
    "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1\n" +
    "Pt8Qp4N4nvKBu+IZ9PMcN1zV7Z6OQ3xXrGGqv7sCAwEAAQJAIJLixBy2qpFo\n" +
    "-----END RSA PRIVATE KEY-----",
};

/**
 * Plain text that contains no secret-shaped substrings. Used as the
 * "no-match" decoy and as the wrapper for single-match scenarios.
 */
const PLAIN_PROSE =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n" +
  "Filename: report.txt, version 1.2.3, build #4567.\n";

const RULE_NAMES = DEFAULT_RULES.map((r) => r.name);

/**
 * One scenario describes how to build an input from a secret and how
 * many matches we expect. Keeping the table data-only makes adding a
 * new scenario a one-line change.
 */
interface Scenario {
  name: string;
  /** Build the test input given the secret-under-test. */
  build: (secret: string) => string;
  /** Expected match count from the rule under test. */
  expected: number;
  /** Optional env mutation for this scenario; restored after. */
  env?: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "no match (decoy content only)",
    build: () => PLAIN_PROSE,
    expected: 0,
  },
  {
    name: "single match in middle of text",
    build: (s) => `prefix ${s} suffix\n`,
    expected: 1,
  },
  {
    name: "adjacent matches separated by single space",
    build: (s) => `${s} ${s}\n`,
    expected: 2,
  },
  {
    name: "match at start-of-buffer boundary",
    build: (s) => `${s} trailing prose here`,
    expected: 1,
  },
  {
    name: "match across multiple lines (separated by newlines)",
    build: (s) => `line1: ${s}\nline2 prose\nline3: ${s}\n`,
    expected: 2,
  },
  {
    name: "SPOOL_REDACT=off neutralizes the rule",
    build: (s) => `prefix ${s} suffix\n`,
    expected: 0,
    env: { SPOOL_REDACT: "off" },
  },
];

/**
 * One test per (rule, scenario) cell. The test name includes both so
 * a failing row points at the exact axis that broke.
 */
for (const rule of RULE_NAMES) {
  for (const scenario of SCENARIOS) {
    test(`redact: ${rule} × ${scenario.name}`, () => {
      const secret = SAMPLES[rule]!;
      const input = scenario.build(secret);

      const original: Record<string, string | undefined> = {};
      if (scenario.env) {
        for (const [k, v] of Object.entries(scenario.env)) {
          original[k] = process.env[k];
          process.env[k] = v;
        }
      }
      try {
        const result = redactString(input);
        const count =
          result.redactions.find((r) => r.rule === rule)?.count ?? 0;
        assert.equal(
          count,
          scenario.expected,
          `expected ${scenario.expected} ${rule} match(es); got ${count}`,
        );

        if (scenario.expected > 0) {
          // Placeholder must appear exactly `expected` times.
          const placeholder = `«spool:redacted:${rule}»`;
          const occurrences = result.text.split(placeholder).length - 1;
          assert.equal(
            occurrences,
            scenario.expected,
            `placeholder count mismatch for ${rule}`,
          );
          // And the raw secret must not survive in the output.
          assert.equal(
            result.text.includes(secret),
            false,
            `raw secret leaked through redaction for ${rule}`,
          );
        } else {
          // No matches → output equals input verbatim. This catches
          // accidental mutation in the no-match path (e.g. a future
          // global replacement that fires unconditionally).
          assert.equal(result.text, input);
        }
      } finally {
        if (scenario.env) {
          for (const [k, v] of Object.entries(original)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
        }
      }
    });
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Cross-rule interactions — cases that aren't (rule × scenario) but
 * exercise how rules compose when their patterns could overlap.
 * ──────────────────────────────────────────────────────────────────── */

test("cross-rule: multiple distinct rules fire on one buffer, each counted separately", () => {
  const input =
    "Authorization: " +
    SAMPLES["bearer"]! +
    "\nANTHROPIC_API_KEY=" +
    SAMPLES["anthropic-key"]! +
    "\nAWS_ACCESS_KEY_ID=" +
    SAMPLES["aws-access-key"]! +
    "\n";
  const result = redactString(input);
  // Three different rules should each report exactly one match. The
  // bearer + anthropic-key combo is the kind of payload a real log
  // line might leak in one go.
  const byRule = Object.fromEntries(
    result.redactions.map((r) => [r.rule, r.count]),
  );
  assert.equal(byRule["bearer"], 1, "bearer counted once");
  assert.equal(byRule["anthropic-key"], 1, "anthropic-key counted once");
  assert.equal(byRule["aws-access-key"], 1, "aws-access-key counted once");
  assert.equal(
    result.text.includes(SAMPLES["bearer"]!),
    false,
    "bearer secret was redacted",
  );
});

test("cross-rule: rule order — anthropic-key wins over the openai-key superset pattern", () => {
  // The openai-key regex `sk-(?:proj-)?[a-zA-Z0-9_-]{20,}` is a
  // superset of the anthropic-key regex `sk-ant-[a-zA-Z0-9_-]{20,}`.
  // Because anthropic-key appears first in DEFAULT_RULES, its replace
  // runs first and the openai pattern then has nothing left to match.
  // This is the contract — if rule order ever changes, this test is
  // the early warning.
  const result = redactString(`token=${SAMPLES["anthropic-key"]!}\n`);
  const anthropicCount =
    result.redactions.find((r) => r.rule === "anthropic-key")?.count ?? 0;
  const openaiCount =
    result.redactions.find((r) => r.rule === "openai-key")?.count ?? 0;
  assert.equal(anthropicCount, 1, "anthropic-key fires");
  assert.equal(openaiCount, 0, "openai-key does NOT fire on anthropic-shaped key");
});

test("cross-rule: placeholder is inert under all rules — redact(redact(x)) === redact(x)", () => {
  // The placeholder format `«spool:redacted:NAME»` must never trigger
  // any rule on a second pass, or repeated redaction would inflate
  // the count and corrupt the output. Smoke-tested here for the full
  // ruleset; the property-based test exercises the full input space.
  const input =
    `key1=${SAMPLES["anthropic-key"]!}\n` +
    `key2=${SAMPLES["openai-key"]!}\n` +
    `${SAMPLES["bearer"]!}\n` +
    `creds=${SAMPLES["github-token"]!}\n` +
    `${SAMPLES["aws-access-key"]!}\n` +
    `${SAMPLES["private-key"]!}\n`;
  const once = redactString(input);
  const twice = redactString(once.text);
  assert.equal(twice.text, once.text, "second pass is a no-op");
  assert.equal(
    twice.redactions.length,
    0,
    "second pass produces zero new redactions",
  );
});
