import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, listRuns, listSteps } from "@spool-ai/collector";
import { SpoolTracer, helpers, traceAnthropic } from "./index.ts";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-sdk-"));
  process.env.SPOOL_HOME = dir;
  return dir;
}

test("SDK tracer creates a run with one step", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/test-proj",
    agent: "tester",
    runTitle: "smoke",
  });
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    systemPrompt: "you are a test",
    history: [{ role: "user", content: "do a thing" }],
  });
  step
    .recordToolCall("Bash", { command: "ls" }, "tu1")
    .recordToolResult("file1\nfile2", { isError: false })
    .recordTokens({
      tokens: {
        input: 100,
        output: 20,
        cached_read: 0,
        cache_creation: 0,
      },
    });
  await step.end();
  await tracer.end();

  const inspect = Store.open();
  const runs = listRuns(inspect);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.title, "smoke");
  assert.equal(runs[0]!.step_count, 1);
  const steps = listSteps(inspect, runs[0]!.run_id);
  assert.equal(steps[0]!.action.kind, "tool_call");
  assert.equal(steps[0]!.action.tool_name, "Bash");
  assert.equal(steps[0]!.outcome.status, "ok");
  assert.ok(steps[0]!.outcome.tool_result_ref);
  assert.equal(steps[0]!.tokens.input, 100);
  inspect.close();
});

test("traceAnthropic captures one step per call", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/test-anth",
    agent: "tester",
  });
  const fakeClient = async (req: any) => ({
    model: req.model,
    content: [
      {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { path: "/etc/hosts" },
      },
    ],
    usage: {
      input_tokens: 50,
      output_tokens: 12,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    },
  });
  const traced = traceAnthropic(tracer, fakeClient);
  await traced({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: "be careful",
    messages: [{ role: "user", content: "read the hosts file" }],
  });
  await tracer.end();

  const inspect = Store.open();
  const runs = listRuns(inspect);
  const steps = listSteps(inspect, runs[0]!.run_id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.action.kind, "tool_call");
  assert.equal(steps[0]!.action.tool_name, "Read");
  assert.equal(steps[0]!.tokens.cached_read, 1000);
  assert.ok(steps[0]!.latency_ms >= 0);
  inspect.close();
});

test("traceAnthropic captures errors as error outcomes", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/test-err",
    agent: "tester",
  });
  const failing = async () => {
    throw new Error("rate limit");
  };
  const traced = traceAnthropic(tracer, failing as any);
  await assert.rejects(
    traced({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "x" }],
    }),
    /rate limit/,
  );
  await tracer.end({ status: "error" });

  const inspect = Store.open();
  const runs = listRuns(inspect);
  assert.equal(runs[0]!.status, "error");
  const steps = listSteps(inspect, runs[0]!.run_id);
  assert.equal(steps[0]!.outcome.status, "error");
  assert.equal(steps[0]!.outcome.is_error, true);
  inspect.close();
});

test("helpers produce well-shaped actions", () => {
  const t = helpers.toolCall("Read", { path: "/a" }, "t1");
  assert.equal(t.kind, "tool_call");
  assert.equal(t.tool_name, "Read");
  const m = helpers.message("hi");
  assert.equal(m.kind, "message");
});
