import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_METERBILITYIGNORE, IgnoreMatcher } from "./meterbilityignore.ts";

/**
 * Tests for the v0.3 `.meterbilityignore` matcher (SPEC §10.2).
 *
 * Focus on the patterns the defaults actually rely on, plus the
 * gitignore-syntax subset documented in the module docstring. The
 * matcher is *intentionally* a subset — these tests pin the surface
 * we promise to support so v0.4 extensions don't accidentally regress
 * v0.3 behavior.
 */

test("defaults match common build-artifact directories anywhere in the tree", () => {
  // Walker contract (matches gitignore): `pattern/` matches the
  // *directory entry itself*. The walker checks each entry before
  // descending — when a directory matches, it's pruned and the walker
  // never queries paths inside it. So we test the directory entry,
  // not paths under it.
  const m = IgnoreMatcher.fromDefaults();
  assert.equal(m.matches("node_modules", true), true);
  assert.equal(m.matches("packages/cli/node_modules", true), true);
  // `dist/`, `build/`, `.next/`, `target/`, `.cache/` — same shape.
  for (const dir of ["dist", "build", ".next", "target", ".cache"]) {
    assert.equal(m.matches(dir, true), true, `expected ${dir} to be ignored`);
    assert.equal(m.matches(`packages/x/${dir}`, true), true);
  }
});

test("defaults match `*.pyc` files anywhere", () => {
  const m = IgnoreMatcher.fromDefaults();
  assert.equal(m.matches("foo.pyc", false), true);
  assert.equal(m.matches("pkg/sub/cache.pyc", false), true);
  assert.equal(m.matches("foo.py", false), false); // not .pyc, must pass
});

test("defaults match the sensitive-by-default file set", () => {
  const m = IgnoreMatcher.fromDefaults();
  assert.equal(m.matches(".env", false), true);
  assert.equal(m.matches(".env.local", false), true);
  assert.equal(m.matches(".env.production.local", false), true);
  assert.equal(m.matches("secrets/.env", false), true);
  assert.equal(m.matches("server.pem", false), true);
  assert.equal(m.matches("config/cert.key", false), true);
  assert.equal(m.matches("id_rsa", false), true);
  assert.equal(m.matches("id_rsa.pub", false), true);
  assert.equal(m.matches("id_ed25519", false), true);
  assert.equal(m.matches("credentials.json", false), true);
});

test("defaults skip plain source files", () => {
  const m = IgnoreMatcher.fromDefaults();
  for (const path of [
    "src/auth.ts",
    "packages/server/src/web.ts",
    "README.md",
    "scripts/build.sh",
  ]) {
    assert.equal(m.matches(path, false), false, `${path} must not be ignored`);
  }
});

test("trailing-slash patterns only match directory entries", () => {
  // A file literally named `node_modules` (someone made an unusual
  // choice) should NOT be ignored — the trailing slash on the default
  // pattern gates that. Walker semantics: dir-only patterns never
  // match a file entry.
  const m = IgnoreMatcher.fromDefaults();
  assert.equal(m.matches("node_modules", false), false);
  // A bare-name pattern (no slash) like `.DS_Store` DOES match files,
  // proving the gate is the trailing slash, not the matcher itself.
  assert.equal(m.matches(".DS_Store", false), true);
});

test("leading-slash patterns are repo-root anchored", () => {
  const m = IgnoreMatcher.fromLines(["/secrets.json"]);
  assert.equal(m.matches("secrets.json", false), true);
  assert.equal(m.matches("nested/secrets.json", false), false);
});

test("** matches any number of segments", () => {
  const m = IgnoreMatcher.fromLines(["**/__snapshots__/**"]);
  assert.equal(m.matches("__snapshots__/foo.snap", false), true);
  assert.equal(m.matches("src/a/b/__snapshots__/c.snap", false), true);
});

test("comments and blanks are ignored at compile time", () => {
  const m = IgnoreMatcher.fromLines([
    "# this is a comment",
    "",
    "   ",
    "real.txt",
  ]);
  assert.equal(m.size(), 1);
  assert.equal(m.matches("real.txt", false), true);
});

test("fromDefaultsPlus stacks user .meterbilityignore on top of defaults", () => {
  const m = IgnoreMatcher.fromDefaultsPlus(["custom-rules/"]);
  assert.equal(m.matches("node_modules", true), true); // defaults still apply
  assert.equal(m.matches("custom-rules", true), true); // user rule active
  assert.equal(m.matches("src/auth.ts", false), false); // unrelated path safe
});

test("DEFAULT_METERBILITYIGNORE is the spec's documented set (regression guard)", () => {
  // If the defaults change, this test fails loudly — that's intentional.
  // The list is documented in SPEC §10.2; drift here is a spec drift.
  assert.ok(DEFAULT_METERBILITYIGNORE.includes("node_modules/"));
  assert.ok(DEFAULT_METERBILITYIGNORE.includes(".env"));
  assert.ok(DEFAULT_METERBILITYIGNORE.includes("credentials.json"));
  assert.ok(DEFAULT_METERBILITYIGNORE.includes(".git/objects/"));
});
