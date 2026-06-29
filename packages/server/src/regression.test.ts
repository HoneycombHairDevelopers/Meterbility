import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, listRuns } from "@meterbility/collector";
import { MeterbilityTracer } from "@meterbility/agent";
import {
  createTest,
  deriveAssertionsFromRun,
  getTestByName,
  listTests,
  runTest,
} from "./regression.ts";
import { listSteps } from "@meterbility/collector";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "meter-regression-"));
  process.env.METERBILITY_HOME = dir;
  return dir;
}

async function buildSampleRun(): Promise<{ runId: string; store: Store }> {
  fresh();
  const tracer = new MeterbilityTracer({
    project: "/tmp/regtest",
    agent: "tester",
  });
  const s1 = tracer.startStep({ model: "claude-opus-4-7" });
  s1.recordToolCall("Bash", { command: "ls" }, "tu1")
    .recordToolResult("file1\nfile2", { isError: false })
    .recordTokens({ tokens: { input: 50, output: 5, cached_read: 0, cache_creation: 0 } });
  await s1.end();
  const s2 = tracer.startStep({ model: "claude-opus-4-7" });
  s2.recordMessage("done")
    .recordOutcome({ outcome: { status: "ok" } })
    .recordTokens({ tokens: { input: 60, output: 10, cached_read: 0, cache_creation: 0 } });
  await s2.end();
  await tracer.end();
  const inspect = Store.open();
  const runs = listRuns(inspect);
  return { runId: runs[0]!.run_id, store: inspect };
}

test("derive assertions creates a sensible starter set", async () => {
  const { runId, store } = await buildSampleRun();
  const run = listRuns(store)[0]!;
  const steps = listSteps(store, runId);
  const assertions = deriveAssertionsFromRun(run, steps);
  const kinds = assertions.map((a) => a.kind);
  assert.ok(kinds.includes("final_status"));
  assert.ok(kinds.includes("includes_tool_call"));
  assert.ok(kinds.includes("max_steps"));
  store.close();
});

test("runTest passes when assertions match", async () => {
  const { runId, store } = await buildSampleRun();
  const t = createTest(store, {
    name: "must-call-bash",
    assertions: [
      { kind: "includes_tool_call", value: "Bash" },
      { kind: "final_status", value: "ok" },
      { kind: "no_error_step", value: 0 },
    ],
  });
  const r = runTest(store, t, runId);
  assert.equal(r.passed, true);
  store.close();
});

test("runTest fails informatively when an assertion is violated", async () => {
  const { runId, store } = await buildSampleRun();
  const t = createTest(store, {
    name: "must-call-write",
    assertions: [{ kind: "includes_tool_call", value: "Write" }],
  });
  const r = runTest(store, t, runId);
  assert.equal(r.passed, false);
  assert.ok(r.assertions[0]!.reason.includes("never called"));
  store.close();
});

test("listTests returns named tests", async () => {
  const { store } = await buildSampleRun();
  createTest(store, { name: "alpha", assertions: [] });
  createTest(store, { name: "beta", assertions: [] });
  const all = listTests(store);
  assert.ok(all.find((t) => t.name === "alpha"));
  assert.ok(all.find((t) => t.name === "beta"));
  assert.ok(getTestByName(store, "alpha"));
  store.close();
});
