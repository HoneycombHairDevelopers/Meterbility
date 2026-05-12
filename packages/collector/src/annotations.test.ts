import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import {
  insertAnnotation,
  listAnnotations,
  upsertAgent,
  upsertProjectByCwd,
  insertRun,
  getRun,
} from "./queries.ts";

function fresh(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-ann-"));
  process.env.SPOOL_HOME = dir;
  return Store.open();
}

/**
 * Regression for the prefix-id bug: the CLI accepted `run_abc12345` as a
 * prefix and stored the annotation under that prefix instead of the
 * resolved full UUID, so subsequent reads (which use the full id) saw
 * no annotation. The fix is in annotate.ts + web.ts; this test pins the
 * invariant at the storage layer so any caller that goes through
 * getRun() before insertAnnotation() will round-trip cleanly.
 */
test("annotations stored with full run_id are visible to reads keyed by full run_id", () => {
  const store = fresh();
  const project = upsertProjectByCwd(store, "/tmp/p");
  const agent = upsertAgent(store, project.project_id, "test");
  const fullRunId = "run_aaaabbbb-cccc-dddd-eeee-ffff00000000";
  insertRun(store, {
    run_id: fullRunId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
    status: "ok",
    started_at: new Date().toISOString(),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
  });

  // The CLI/API resolution path: caller passes a 12-char prefix,
  // resolves via getRun (which supports prefix matching), then uses
  // the resolved full id for the insert.
  const resolved = getRun(store, "run_aaaabbbb");
  assert.ok(resolved);
  assert.equal(resolved!.run_id, fullRunId);

  insertAnnotation(store, {
    targetKind: "run",
    targetId: resolved!.run_id,
    author: "test",
    verdict: "good_decision",
    note: "audit pass",
  });

  // Read keyed by the full id: should find the annotation.
  const found = listAnnotations(store, "run", fullRunId);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.note, "audit pass");

  // And the prefix-only key should still be empty — proving the
  // annotation didn't accidentally land under both keys.
  const stillEmpty = listAnnotations(store, "run", "run_aaaabbbb");
  assert.equal(stillEmpty.length, 0);

  store.close();
});
