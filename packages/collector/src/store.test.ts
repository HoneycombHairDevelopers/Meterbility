import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { upsertProjectByCwd, upsertAgent, listRuns } from "./queries.ts";

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-test-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

test("store opens, schema applies, project upsert idempotent", () => {
  const store = freshStore();
  const a = upsertProjectByCwd(store, "/tmp/x", "x");
  const b = upsertProjectByCwd(store, "/tmp/x", "x");
  assert.equal(a.project_id, b.project_id);
  const agent = upsertAgent(store, a.project_id, "claude-code");
  assert.ok(agent.agent_id.startsWith("agt_"));
  assert.deepEqual(listRuns(store), []);
  store.close();
});

test("blob store dedups by sha", async () => {
  const store = freshStore();
  const h1 = await store.blobs.putString("hello");
  const h2 = await store.blobs.putString("hello");
  assert.equal(h1, h2);
  assert.equal(await store.blobs.getString(h1), "hello");
  store.close();
});

test("blob store redacts secrets before persist", async () => {
  const store = freshStore();
  const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
  const hash = await store.blobs.putString(`prefix ${secret} suffix`);
  const stored = await store.blobs.getString(hash);
  assert.ok(!stored.includes(secret));
  assert.match(stored, /«spool:redacted:anthropic-key»/);
});
