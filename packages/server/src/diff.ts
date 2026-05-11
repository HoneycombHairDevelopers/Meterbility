import type { Step } from "@spool/shared";
import { listSteps } from "@spool/collector";
import type { Store } from "@spool/collector";

/**
 * Structural diff. Walks both runs in sequence order, aligning steps by
 * sequence number. v0 only supports this "parallel" mode — semantic
 * (embedding-based) alignment is on the v1 roadmap.
 */

export type DiffRowKind =
  | "shared" // identical context_snapshot_id AND identical decision_ref
  | "context_diff" // same sequence, different snapshot
  | "decision_diff" // same sequence + snapshot, different decision
  | "action_diff" // same sequence, different action kind/tool
  | "outcome_diff" // same sequence + action, different outcome
  | "only_a" // exists in A but not in B at this sequence
  | "only_b" // exists in B but not in A at this sequence
  | "diverged"; // beyond the prefix divergence point

export interface DiffRow {
  sequence: number;
  kind: DiffRowKind;
  a?: StepDigest;
  b?: StepDigest;
}

export interface StepDigest {
  step_id: string;
  model: string;
  context_snapshot_id: string;
  decision_ref: string;
  action_kind: string;
  tool_name?: string;
  outcome_status: string;
  outcome_summary?: string;
  cost_cents: number;
  tokens_total: number;
  status: string;
}

export interface DiffResult {
  run_a_id: string;
  run_b_id: string;
  total_steps_a: number;
  total_steps_b: number;
  shared_prefix_length: number;
  first_divergence_sequence?: number;
  rows: DiffRow[];
}

function digest(s: Step): StepDigest {
  return {
    step_id: s.step_id,
    model: s.model,
    context_snapshot_id: s.context_snapshot_id,
    decision_ref: s.decision_ref,
    action_kind: s.action.kind,
    tool_name: s.action.tool_name,
    outcome_status: s.outcome.status,
    outcome_summary: s.outcome.summary,
    cost_cents: s.cost_cents,
    tokens_total: s.tokens.input + s.tokens.output,
    status: s.status,
  };
}

export function diffRuns(
  store: Store,
  runA: string,
  runB: string,
): DiffResult {
  const stepsA = listSteps(store, runA);
  const stepsB = listSteps(store, runB);
  const rows: DiffRow[] = [];
  const max = Math.max(stepsA.length, stepsB.length);
  let sharedPrefixLength = 0;
  let firstDivergence: number | undefined;
  let diverged = false;

  for (let i = 0; i < max; i++) {
    const a = stepsA[i];
    const b = stepsB[i];
    if (!a && b) {
      rows.push({ sequence: i, kind: "only_b", b: digest(b) });
      if (firstDivergence === undefined) firstDivergence = i;
      diverged = true;
      continue;
    }
    if (a && !b) {
      rows.push({ sequence: i, kind: "only_a", a: digest(a) });
      if (firstDivergence === undefined) firstDivergence = i;
      diverged = true;
      continue;
    }
    if (!a || !b) continue;
    if (diverged) {
      rows.push({ sequence: i, kind: "diverged", a: digest(a), b: digest(b) });
      continue;
    }
    const kind = classify(a, b);
    rows.push({ sequence: i, kind, a: digest(a), b: digest(b) });
    if (kind === "shared") {
      sharedPrefixLength = i + 1;
    } else {
      if (firstDivergence === undefined) firstDivergence = i;
      diverged = true;
    }
  }

  return {
    run_a_id: runA,
    run_b_id: runB,
    total_steps_a: stepsA.length,
    total_steps_b: stepsB.length,
    shared_prefix_length: sharedPrefixLength,
    first_divergence_sequence: firstDivergence,
    rows,
  };
}

function classify(a: Step, b: Step): DiffRowKind {
  if (a.context_snapshot_id !== b.context_snapshot_id) {
    return "context_diff";
  }
  if (a.decision_ref !== b.decision_ref) {
    return "decision_diff";
  }
  if (
    a.action.kind !== b.action.kind ||
    a.action.tool_name !== b.action.tool_name
  ) {
    return "action_diff";
  }
  if (
    a.outcome.status !== b.outcome.status ||
    a.outcome.is_error !== b.outcome.is_error
  ) {
    return "outcome_diff";
  }
  return "shared";
}
