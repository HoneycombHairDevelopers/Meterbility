import { test } from "node:test";
import assert from "node:assert/strict";
import { RunGrouper } from "./grouping.ts";
import type { ParsedRequest } from "./types.ts";

function req(history: Array<{ role: "user" | "assistant" | "tool"; content: string }>): ParsedRequest {
  return {
    model: "claude-opus-4-7",
    history,
    pendingToolResults: [],
    isStream: false,
  };
}

test("RunGrouper: same first user message + same model groups into one run", () => {
  const g = new RunGrouper();
  const a = g.resolve(req([{ role: "user", content: "hi" }]), undefined, 1_000);
  const b = g.resolve(
    req([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
      { role: "user", content: "how are you?" },
    ]),
    undefined,
    2_000,
  );
  assert.equal(a.run_id, b.run_id);
  assert.equal(a.is_new, true);
  assert.equal(b.is_new, false);
  assert.equal(b.step_sequence, 1);
});

test("RunGrouper: different first user message starts a new run", () => {
  const g = new RunGrouper();
  const a = g.resolve(req([{ role: "user", content: "hi" }]), undefined, 1_000);
  const b = g.resolve(req([{ role: "user", content: "different start" }]), undefined, 2_000);
  assert.notEqual(a.run_id, b.run_id);
  assert.equal(b.is_new, true);
});

test("RunGrouper: explicit x-meterbility-run-id wins over heuristic", () => {
  const g = new RunGrouper();
  const a = g.resolve(req([{ role: "user", content: "hi" }]), "run_explicit_1", 1_000);
  const b = g.resolve(req([{ role: "user", content: "totally different" }]), "run_explicit_1", 2_000);
  assert.equal(a.run_id, "run_explicit_1");
  assert.equal(b.run_id, "run_explicit_1");
  assert.equal(b.is_new, false);
});

test("RunGrouper: gap longer than window starts a new run", () => {
  const g = new RunGrouper();
  const a = g.resolve(req([{ role: "user", content: "hi" }]), undefined, 1_000);
  // 31 minutes later
  const b = g.resolve(req([{ role: "user", content: "hi" }]), undefined, 1_000 + 31 * 60 * 1000);
  assert.notEqual(a.run_id, b.run_id);
});
