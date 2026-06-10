import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { upsertProjectByCwd, getBaselineTree } from "./queries.ts";
import { captureBaseline } from "./baseline.ts";
import { parseManifest } from "./replay.ts";
import { IgnoreMatcher } from "@spool-ai/shared";

/**
 * v0.3 Turn 5 — captureBaseline tests.
 *
 * Each test runs against a tmpdir-built fake repo so the walker has
 * real bytes to hash without depending on the running machine's
 * actual `pwd`. The tmpdir gets torn down with the process; we
 * never write to the user's home outside of $SPOOL_HOME.
 */

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-baseline-store-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

function freshRepo(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "spool-baseline-repo-"));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test("captureBaseline walks cwd and produces a manifest of every captured file", async () => {
  const store = freshStore();
  const project = upsertProjectByCwd(store, "/p1", "p1");
  const cwd = freshRepo({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    "README.md": "# hi\n",
  });
  const r = await captureBaseline(store, project.project_id, cwd);
  assert.ok(r);
  assert.equal(r!.file_count, 3);
  assert.equal(r!.skipped, 0);
  assert.equal(r!.reused_existing, false);
  // Manifest contains those three files, sorted by path bytewise.
  const manifestBuf = await store.blobs.getBuffer(r!.manifest_blob_ref);
  const parsed = parseManifest(manifestBuf);
  const paths = parsed.map((e) => e.path);
  assert.deepEqual(paths, ["README.md", "src/a.ts", "src/b.ts"]);
  // Each entry has a real blob_ref the store can read back.
  for (const e of parsed) {
    const bytes = await store.blobs.getString(e.blob_ref);
    assert.ok(bytes.length > 0);
  }
  store.close();
});

test("captureBaseline respects .spoolignore defaults: ignores node_modules + .env", async () => {
  const store = freshStore();
  const project = upsertProjectByCwd(store, "/p2", "p2");
  const cwd = freshRepo({
    "src/keep.ts": "ok\n",
    "node_modules/dep/index.js": "garbage\n",
    "node_modules/dep/package.json": "{}\n",
    ".env": "SECRET=do_not_capture\n",
    ".env.local": "ALSO=secret\n",
    "package-lock.json": "{}\n",
  });
  const r = await captureBaseline(store, project.project_id, cwd);
  assert.ok(r);
  const manifestBuf = await store.blobs.getBuffer(r!.manifest_blob_ref);
  const paths = parseManifest(manifestBuf).map((e) => e.path);
  // src/keep.ts and package-lock.json are kept; everything else is ignored.
  assert.deepEqual(paths.sort(), ["package-lock.json", "src/keep.ts"]);
  store.close();
});

test("captureBaseline stacks user .spoolignore on top of defaults", async () => {
  const store = freshStore();
  const project = upsertProjectByCwd(store, "/p3", "p3");
  const cwd = freshRepo({
    "src/x.ts": "x\n",
    "src/y.ts": "y\n",
    "fixtures/big.bin": "binary-ish\n",
    ".spoolignore": "fixtures/\n",
  });
  const r = await captureBaseline(store, project.project_id, cwd);
  assert.ok(r);
  const paths = parseManifest(
    await store.blobs.getBuffer(r!.manifest_blob_ref),
  ).map((e) => e.path);
  // .spoolignore itself is kept (defaults don't ignore it); fixtures/
  // is filtered by the user's rule.
  assert.ok(paths.includes("src/x.ts"));
  assert.ok(paths.includes("src/y.ts"));
  assert.ok(paths.includes(".spoolignore"));
  assert.ok(!paths.some((p) => p.startsWith("fixtures/")));
  store.close();
});

test("captureBaseline dedups via manifest hash on second call (reused_existing=true)", async () => {
  const store = freshStore();
  const project = upsertProjectByCwd(store, "/p4", "p4");
  const cwd = freshRepo({ "src/x.ts": "same content\n" });
  const r1 = await captureBaseline(store, project.project_id, cwd);
  const r2 = await captureBaseline(store, project.project_id, cwd);
  assert.ok(r1 && r2);
  assert.equal(r1!.reused_existing, false);
  assert.equal(r2!.reused_existing, true);
  assert.equal(r1!.baseline_tree_id, r2!.baseline_tree_id);
  // And the row is reachable from the queries layer.
  const fetched = getBaselineTree(store, r1!.baseline_tree_id);
  assert.ok(fetched);
  store.close();
});

test("captureBaseline returns undefined for a nonexistent cwd (no throw)", async () => {
  const store = freshStore();
  const project = upsertProjectByCwd(store, "/p5", "p5");
  const r = await captureBaseline(
    store,
    project.project_id,
    "/var/nope/does/not/exist/spool-test",
  );
  assert.equal(r, undefined);
  store.close();
});

test("captureBaseline skips oversize files but still captures the rest", async () => {
  const store = freshStore();
  const project = upsertProjectByCwd(store, "/p6", "p6");
  const cwd = freshRepo({
    "small.ts": "ok\n",
    // 200-byte file (well under the override below)
    "medium.ts": "x".repeat(200) + "\n",
  });
  // Set the cap to 100 bytes so `medium.ts` skips but `small.ts` survives.
  const r = await captureBaseline(store, project.project_id, cwd, {
    maxFileBytes: 100,
  });
  assert.ok(r);
  assert.equal(r!.skipped, 1);
  const paths = parseManifest(
    await store.blobs.getBuffer(r!.manifest_blob_ref),
  ).map((e) => e.path);
  assert.deepEqual(paths, ["small.ts"]);
  store.close();
});

test("two cwds with identical content + matcher produce identical manifest hashes", async () => {
  // The dedup story: a baseline_tree row is content-addressed by its
  // manifest blob. Two physically separate directories with the same
  // files must produce the same manifest_blob_ref. That's what makes
  // forks + cross-run replay share storage in the dominant case.
  const store = freshStore();
  const projectA = upsertProjectByCwd(store, "/pA", "pA");
  const projectB = upsertProjectByCwd(store, "/pB", "pB");
  const repoA = freshRepo({ "a.ts": "shared\n", "b.ts": "shared\n" });
  const repoB = freshRepo({ "a.ts": "shared\n", "b.ts": "shared\n" });
  // Use the same explicit matcher for both so external state (e.g.
  // .gitignore presence) can't drift them apart.
  const matcher = IgnoreMatcher.fromDefaults();
  const rA = await captureBaseline(store, projectA.project_id, repoA, { matcher });
  const rB = await captureBaseline(store, projectB.project_id, repoB, { matcher });
  assert.ok(rA && rB);
  assert.equal(rA!.manifest_blob_ref, rB!.manifest_blob_ref);
  // Different baseline_tree_id rows (scoped per project), same
  // underlying manifest blob.
  assert.notEqual(rA!.baseline_tree_id, rB!.baseline_tree_id);
  store.close();
});

test("captured file bytes round-trip through the blob store", async () => {
  // Sanity check: the bytes we read off disk match what comes back via
  // store.blobs.getBuffer. Guards against any binary-safety regression
  // that might creep into the walker later.
  const store = freshStore();
  const project = upsertProjectByCwd(store, "/p7", "p7");
  const cwd = freshRepo({
    "text.ts": "hello\n",
    // Binary-ish: NUL byte triggers PR 1's binary path.
    "binary.bin": String.fromCharCode(0) + "raw bytes",
  });
  const r = await captureBaseline(store, project.project_id, cwd);
  assert.ok(r);
  const parsed = parseManifest(await store.blobs.getBuffer(r!.manifest_blob_ref));
  const text = parsed.find((e) => e.path === "text.ts")!;
  const binary = parsed.find((e) => e.path === "binary.bin")!;
  assert.equal(await store.blobs.getString(text.blob_ref), "hello\n");
  const binaryBuf = await store.blobs.getBuffer(binary.blob_ref);
  assert.equal(binaryBuf[0], 0);
  assert.equal(binaryBuf.toString("utf-8", 1), "raw bytes");
  store.close();
});
