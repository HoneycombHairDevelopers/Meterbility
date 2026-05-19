import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { DEFAULT_SPOOLIGNORE, IgnoreMatcher } from "./spoolignore.ts";

/**
 * Property-based tests for the `.spoolignore` matcher (SPEC v0.3 §10.2).
 *
 * Existing example-based tests in spoolignore.test.ts pin down the
 * documented behaviors (trailing-slash dir-only, leading-slash root
 * anchor, `**` globstar, etc.). These tests express the *general*
 * invariants the matcher must hold for any input — catching whole
 * classes of bugs that ad-hoc examples would miss.
 *
 * Note: v0.3 deliberately does NOT support negation (`!pattern`) per
 * the source comment in spoolignore.ts:18. Tests here assume the v0.3
 * scope; add negation properties when v0.4 lands the feature.
 */

/**
 * Arbitraries: build POSIX-style repo-relative paths and gitignore-
 * compatible pattern lines. We build path segments from a bounded
 * alphabet via `fc.string({ unit })` so every generated segment is
 * a valid identifier-like string by construction. Using `.filter()`
 * on a broader alphabet would have rejection rates high enough to
 * starve fast-check's run budget.
 */
const SEG_CHAR = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-".split(""),
);
const segment = fc
  .string({ unit: SEG_CHAR, minLength: 1, maxLength: 12 })
  // The only filter that survives at low rejection cost: forbid `.` / `..`
  // which would walk the path tree. These hit on roughly 2/N^k inputs, so
  // the rejection rate is negligible.
  .filter((s) => s !== "." && s !== "..");

const repoPath = fc
  .array(segment, { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join("/"));

const simplePattern = fc.oneof(
  segment, // bare basename
  segment.map((s) => `${s}/`), // dir-only
  segment.map((s) => `/${s}`), // root-anchored
  segment.map((s) => `*.${s.slice(0, 4)}`), // suffix wildcard
);

/* ────────────────────────────────────────────────────────────────────
 * Property 1 — Determinism.
 *
 * Calling `matches(p, d)` twice with the same arguments returns the
 * same result. Caches, lazy compilation, or accidental shared mutable
 * state would break this.
 * ──────────────────────────────────────────────────────────────────── */
test("property: matches() is deterministic across repeated calls", () => {
  fc.assert(
    fc.property(
      fc.array(simplePattern, { minLength: 1, maxLength: 8 }),
      repoPath,
      fc.boolean(),
      (patterns, path, isDir) => {
        const m = IgnoreMatcher.fromLines(patterns);
        const first = m.matches(path, isDir);
        const second = m.matches(path, isDir);
        return first === second;
      },
    ),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 2 — Monotonicity under pattern addition.
 *
 * Adding a pattern to a matcher can only *increase* the set of paths
 * it matches — never decrease. (v0.3 has no negation, so this is
 * unconditional. When negation lands in v0.4, this property gets
 * narrower.)
 * ──────────────────────────────────────────────────────────────────── */
test("property: adding patterns is monotonic — matched set only grows", () => {
  fc.assert(
    fc.property(
      fc.array(simplePattern, { minLength: 1, maxLength: 6 }),
      simplePattern,
      repoPath,
      fc.boolean(),
      (basePatterns, extra, path, isDir) => {
        const before = IgnoreMatcher.fromLines(basePatterns);
        const after = IgnoreMatcher.fromLines([...basePatterns, extra]);
        // If `before` matches, `after` must also match. The reverse
        // is allowed (extra pattern adds a new match).
        if (before.matches(path, isDir) && !after.matches(path, isDir)) {
          return false;
        }
        return true;
      },
    ),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 3 — `dirOnly` safety.
 *
 * A pattern with a trailing slash must never match a non-directory
 * path. This is the gitignore contract that `node_modules/` ignores
 * the directory and its children, but NOT a file literally named
 * `node_modules` at any depth.
 *
 * We isolate the dir-only pattern from any sibling that might match
 * the same path through a different rule (e.g. a bare `node_modules`
 * pattern alongside `node_modules/`).
 * ──────────────────────────────────────────────────────────────────── */
test("property: trailing-slash patterns never match isDir=false paths in isolation", () => {
  fc.assert(
    fc.property(segment, repoPath, (name, path) => {
      const m = IgnoreMatcher.fromLines([`${name}/`]);
      // Build a path that doesn't already contain the pattern name as a
      // bare segment — otherwise the pattern's dir-only-ness is moot
      // (the path itself isn't a dir candidate).
      const withName = `${path}/${name}`;
      // isDir=false → must NOT match because the rule is dir-only.
      return m.matches(withName, false) === false;
    }),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 4 — Root-anchored patterns never match deeper paths.
 *
 * `/foo` matches `foo` at the repo root, but not `bar/foo` at any
 * depth. The current implementation enforces this via the `^` anchor
 * in the compiled regex; the property pins down the invariant.
 * ──────────────────────────────────────────────────────────────────── */
test("property: root-anchored patterns don't match the same name nested under another directory", () => {
  fc.assert(
    fc.property(
      segment,
      segment,
      fc.boolean(),
      (anchored, prefix, isDir) => {
        // Skip degenerate cases where prefix === anchored (the rooted
        // pattern would still match prefix/anchored/anchored).
        fc.pre(prefix !== anchored);
        const m = IgnoreMatcher.fromLines([`/${anchored}`]);
        // Root match → ignored.
        const rootHit = m.matches(anchored, isDir);
        // Nested match → must NOT be ignored.
        const nestedHit = m.matches(`${prefix}/${anchored}`, isDir);
        return rootHit === true && nestedHit === false;
      },
    ),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 5 — Defaults are stable across reconstruction.
 *
 * Building a defaults matcher twice yields identical match results
 * for any path. Catches any future regression where `fromDefaults()`
 * accidentally pulls in environment-dependent state.
 * ──────────────────────────────────────────────────────────────────── */
test("property: IgnoreMatcher.fromDefaults() is reproducible", () => {
  fc.assert(
    fc.property(repoPath, fc.boolean(), (path, isDir) => {
      const a = IgnoreMatcher.fromDefaults();
      const b = IgnoreMatcher.fromDefaults();
      return a.matches(path, isDir) === b.matches(path, isDir);
    }),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 6 — Comments and blank lines are silently dropped.
 *
 * A pattern list with arbitrary comments / blanks injected matches
 * the same set as the same list with them stripped. Documents that
 * comments truly are free — adding them never changes behavior.
 * ──────────────────────────────────────────────────────────────────── */
test("property: injecting comments and blank lines into a pattern list never changes matches", () => {
  fc.assert(
    fc.property(
      fc.array(simplePattern, { minLength: 1, maxLength: 6 }),
      repoPath,
      fc.boolean(),
      (patterns, path, isDir) => {
        const withNoise: string[] = [];
        for (const p of patterns) {
          withNoise.push("# a comment");
          withNoise.push("");
          withNoise.push("   ");
          withNoise.push(p);
        }
        withNoise.push("");
        withNoise.push("# trailing comment");
        const a = IgnoreMatcher.fromLines(patterns);
        const b = IgnoreMatcher.fromLines(withNoise);
        return a.matches(path, isDir) === b.matches(path, isDir);
      },
    ),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Property 7 — DEFAULT_SPOOLIGNORE covers the documented sensitive set.
 *
 * Spot-check that every "sensitive by default" path in SPEC v0.3
 * §10.2 is matched by `fromDefaults()`. Not strictly a property test
 * (the input set is fixed), but lives here because it asserts the
 * relationship between the SPEC-mandated default list and the
 * compiled matcher behavior — a regression here means the defaults
 * shipped without protecting credentials.
 * ──────────────────────────────────────────────────────────────────── */
test("property: the SPEC sensitive-default file set is matched by fromDefaults()", () => {
  const m = IgnoreMatcher.fromDefaults();
  const sensitive = [
    ".env",
    "private.pem",
    "server.key",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "credentials.json",
  ];
  for (const path of sensitive) {
    assert.equal(
      m.matches(path, false),
      true,
      `sensitive default file ${path} must be ignored`,
    );
  }
  // Sanity: a clearly-non-sensitive file must NOT be ignored.
  assert.equal(m.matches("src/index.ts", false), false);
  // And DEFAULT_SPOOLIGNORE itself stays non-empty as a regression
  // canary — if someone empties the array, every other test would
  // still pass but the security posture is gone.
  assert.ok(DEFAULT_SPOOLIGNORE.length > 0, "defaults must not be empty");
});
