import { randomUUID } from "node:crypto";
import type { Run, Step, StepStatus } from "@spool/shared";
import { getRun, listRuns, listSteps } from "@spool/collector";
import type { Store } from "@spool/collector";

/**
 * Regression suite (v0.1).
 *
 * A test is a named bundle of assertions. Assertions are pure: they take
 * a (run, steps) pair and return pass/fail. v0.1 supports the structural
 * checks called out in SPEC §7.3 — tool-call presence, output-text
 * matching, step counts, final status, cost ceiling. LLM-judge
 * assertions are deferred to v1.
 *
 * Tests are stored in the local SQLite store as JSON-encoded assertion
 * arrays so they round-trip cleanly via export/import.
 */

export type AssertionKind =
  | "includes_tool_call"
  | "excludes_tool_call"
  | "tool_call_count"
  | "output_contains"
  | "output_does_not_contain"
  | "min_steps"
  | "max_steps"
  | "final_status"
  | "max_cost_cents"
  | "no_error_step"
  | "step_status_at";

export interface Assertion {
  kind: AssertionKind;
  /** A flexible payload — string for text assertions, number for counts, etc. */
  value: string | number;
  /** Optional sequence index for `step_status_at`. */
  at?: number;
  /** Friendly label for reports. */
  label?: string;
}

export interface RegressionTest {
  test_id: string;
  name: string;
  description?: string;
  assertions: Assertion[];
  canonical_run_id?: string;
  created_at: string;
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  reason: string;
}

export interface RegressionResult {
  result_id: string;
  test_id: string;
  test_name: string;
  run_id: string;
  passed: boolean;
  assertions: AssertionResult[];
  created_at: string;
}

export function listTests(store: Store): RegressionTest[] {
  const rows = store.db
    .prepare(
      "SELECT test_id, name, description, assertions_json, canonical_run_id, created_at FROM regression_tests ORDER BY name",
    )
    .all() as Array<{
    test_id: string;
    name: string;
    description: string | null;
    assertions_json: string;
    canonical_run_id: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    test_id: r.test_id,
    name: r.name,
    description: r.description ?? undefined,
    assertions: JSON.parse(r.assertions_json) as Assertion[],
    canonical_run_id: r.canonical_run_id ?? undefined,
    created_at: r.created_at,
  }));
}

export function getTestByName(
  store: Store,
  name: string,
): RegressionTest | undefined {
  const r = store.db
    .prepare(
      "SELECT test_id, name, description, assertions_json, canonical_run_id, created_at FROM regression_tests WHERE name = ?",
    )
    .get(name) as
    | {
        test_id: string;
        name: string;
        description: string | null;
        assertions_json: string;
        canonical_run_id: string | null;
        created_at: string;
      }
    | undefined;
  if (!r) return undefined;
  return {
    test_id: r.test_id,
    name: r.name,
    description: r.description ?? undefined,
    assertions: JSON.parse(r.assertions_json) as Assertion[],
    canonical_run_id: r.canonical_run_id ?? undefined,
    created_at: r.created_at,
  };
}

export function createTest(
  store: Store,
  args: {
    name: string;
    description?: string;
    assertions: Assertion[];
    canonical_run_id?: string;
  },
): RegressionTest {
  const test: RegressionTest = {
    test_id: `tst_${randomUUID()}`,
    name: args.name,
    description: args.description,
    assertions: args.assertions,
    canonical_run_id: args.canonical_run_id,
    created_at: new Date().toISOString(),
  };
  store.db
    .prepare(
      `INSERT INTO regression_tests(test_id, name, description, assertions_json, canonical_run_id, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      test.test_id,
      test.name,
      test.description ?? null,
      JSON.stringify(test.assertions),
      test.canonical_run_id ?? null,
      test.created_at,
    );
  return test;
}

export function deleteTest(store: Store, name: string): boolean {
  const res = store.db
    .prepare("DELETE FROM regression_tests WHERE name = ?")
    .run(name);
  return res.changes > 0;
}

export function addAssertion(
  store: Store,
  testName: string,
  assertion: Assertion,
): RegressionTest {
  const t = getTestByName(store, testName);
  if (!t) throw new Error(`test not found: ${testName}`);
  t.assertions.push(assertion);
  store.db
    .prepare(
      "UPDATE regression_tests SET assertions_json = ? WHERE test_id = ?",
    )
    .run(JSON.stringify(t.assertions), t.test_id);
  return t;
}

/**
 * Build a starter test from a canonical run. Each tool used in the run
 * becomes an `includes_tool_call`; final status becomes `final_status`;
 * total step count becomes `max_steps × 1.5` and `min_steps × 0.5` — a
 * loose envelope the operator can tighten by hand later.
 */
export function deriveAssertionsFromRun(run: Run, steps: Step[]): Assertion[] {
  const toolCounts = new Map<string, number>();
  for (const s of steps) {
    if (s.action.kind === "tool_call" && s.action.tool_name) {
      toolCounts.set(
        s.action.tool_name,
        (toolCounts.get(s.action.tool_name) ?? 0) + 1,
      );
    }
  }
  const out: Assertion[] = [
    { kind: "final_status", value: run.status, label: "final status" },
    { kind: "no_error_step", value: 0, label: "no errored step" },
    {
      kind: "min_steps",
      value: Math.max(1, Math.floor(steps.length * 0.5)),
      label: "min steps (50% of canonical)",
    },
    {
      kind: "max_steps",
      value: Math.ceil(steps.length * 1.5),
      label: "max steps (150% of canonical)",
    },
    {
      kind: "max_cost_cents",
      value: Math.ceil(run.cost_cents * 1.5),
      label: "max cost (150% of canonical)",
    },
  ];
  for (const [tool] of toolCounts) {
    out.push({
      kind: "includes_tool_call",
      value: tool,
      label: `must call ${tool}`,
    });
  }
  return out;
}

export function runTest(
  store: Store,
  test: RegressionTest,
  runId: string,
): RegressionResult {
  const run = getRun(store, runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  const steps = listSteps(store, run.run_id);
  const results: AssertionResult[] = test.assertions.map((a) =>
    evaluateAssertion(a, run, steps),
  );
  const passed = results.every((r) => r.passed);
  const result: RegressionResult = {
    result_id: `res_${randomUUID()}`,
    test_id: test.test_id,
    test_name: test.name,
    run_id: run.run_id,
    passed,
    assertions: results,
    created_at: new Date().toISOString(),
  };
  store.db
    .prepare(
      `INSERT INTO regression_results(result_id, test_id, run_id, passed, details_json, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      result.result_id,
      result.test_id,
      result.run_id,
      passed ? 1 : 0,
      JSON.stringify(results),
      result.created_at,
    );
  return result;
}

function evaluateAssertion(
  assertion: Assertion,
  run: Run,
  steps: Step[],
): AssertionResult {
  switch (assertion.kind) {
    case "includes_tool_call": {
      const want = String(assertion.value);
      const found = steps.some(
        (s) => s.action.kind === "tool_call" && s.action.tool_name === want,
      );
      return {
        assertion,
        passed: found,
        reason: found ? `${want} was called` : `${want} was never called`,
      };
    }
    case "excludes_tool_call": {
      const want = String(assertion.value);
      const found = steps.some(
        (s) => s.action.kind === "tool_call" && s.action.tool_name === want,
      );
      return {
        assertion,
        passed: !found,
        reason: !found
          ? `${want} was correctly absent`
          : `${want} was called (banned)`,
      };
    }
    case "tool_call_count": {
      const want = Number(assertion.value);
      const count = steps.filter((s) => s.action.kind === "tool_call").length;
      return {
        assertion,
        passed: count === want,
        reason: `expected ${want} tool calls, got ${count}`,
      };
    }
    case "output_contains": {
      const want = String(assertion.value);
      const last = steps.findLast?.((s) => s.action.kind === "message") ??
        [...steps].reverse().find((s) => s.action.kind === "message");
      const text = last?.action.text ?? "";
      const found = text.includes(want);
      return {
        assertion,
        passed: found,
        reason: found
          ? `final message contained "${want.slice(0, 40)}"`
          : `final message did not contain "${want.slice(0, 40)}"`,
      };
    }
    case "output_does_not_contain": {
      const want = String(assertion.value);
      const last = steps.findLast?.((s) => s.action.kind === "message") ??
        [...steps].reverse().find((s) => s.action.kind === "message");
      const text = last?.action.text ?? "";
      const found = text.includes(want);
      return {
        assertion,
        passed: !found,
        reason: !found
          ? `forbidden phrase absent`
          : `final message contained forbidden phrase`,
      };
    }
    case "min_steps": {
      const want = Number(assertion.value);
      return {
        assertion,
        passed: steps.length >= want,
        reason: `expected ≥${want} steps, got ${steps.length}`,
      };
    }
    case "max_steps": {
      const want = Number(assertion.value);
      return {
        assertion,
        passed: steps.length <= want,
        reason: `expected ≤${want} steps, got ${steps.length}`,
      };
    }
    case "final_status": {
      const want = String(assertion.value) as StepStatus;
      return {
        assertion,
        passed: run.status === want,
        reason: `expected status=${want}, got ${run.status}`,
      };
    }
    case "max_cost_cents": {
      const want = Number(assertion.value);
      return {
        assertion,
        passed: run.cost_cents <= want,
        reason: `expected ≤${want.toFixed(2)}¢, got ${run.cost_cents.toFixed(2)}¢`,
      };
    }
    case "no_error_step": {
      const errored = steps.find((s) => s.status === "error");
      return {
        assertion,
        passed: !errored,
        reason: errored
          ? `step #${errored.sequence} errored`
          : "no errored steps",
      };
    }
    case "step_status_at": {
      if (assertion.at === undefined) {
        return {
          assertion,
          passed: false,
          reason: "step_status_at requires `at`",
        };
      }
      const step = steps.find((s) => s.sequence === assertion.at);
      if (!step) {
        return {
          assertion,
          passed: false,
          reason: `no step at sequence ${assertion.at}`,
        };
      }
      const want = String(assertion.value) as StepStatus;
      return {
        assertion,
        passed: step.status === want,
        reason: `step #${assertion.at}: expected status=${want}, got ${step.status}`,
      };
    }
  }
}

export function listResults(
  store: Store,
  testId?: string,
  limit = 50,
): RegressionResult[] {
  const rows = (testId
    ? store.db
        .prepare(
          "SELECT * FROM regression_results WHERE test_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(testId, limit)
    : store.db
        .prepare(
          "SELECT * FROM regression_results ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit)) as Array<{
    result_id: string;
    test_id: string;
    run_id: string;
    passed: number;
    details_json: string;
    created_at: string;
  }>;
  // Resolve test name lazily.
  const tests = listTests(store);
  const nameMap = new Map(tests.map((t) => [t.test_id, t.name]));
  return rows.map((r) => ({
    result_id: r.result_id,
    test_id: r.test_id,
    test_name: nameMap.get(r.test_id) ?? "(deleted)",
    run_id: r.run_id,
    passed: r.passed === 1,
    assertions: JSON.parse(r.details_json) as AssertionResult[],
    created_at: r.created_at,
  }));
}
