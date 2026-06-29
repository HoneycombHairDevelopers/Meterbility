import type { Run, Step } from "@meterbility/shared";

export type LiveStatus =
  | "progressing"
  | "stalled"
  | "looping"
  | "awaiting_input"
  | "errored"
  | "completed";

/**
 * Heuristic context-window utilization derived from the last step's
 * token usage. Anthropic's Opus 4.x models use a 200k window in stable
 * mode and a 1M window in extended mode; we read both totals from the
 * step's tokens and assume the larger of (input + cached_read) vs.
 * (input alone) as the effective load. Returns 0–100.
 */
export function contextUtilization(step?: Step): number {
  if (!step) return 0;
  const window = inferWindowSize(step.model);
  const total =
    step.tokens.input + step.tokens.cached_read + step.tokens.cache_creation;
  if (window === 0) return 0;
  return Math.min(100, Math.round((total / window) * 100));
}

function inferWindowSize(model: string): number {
  // 1M-context flavors first.
  if (/\[1m\]|-1m\b|1m-context/i.test(model)) return 1_000_000;
  if (/opus|sonnet|haiku/i.test(model)) return 200_000;
  return 128_000;
}

/**
 * Classify a run's live status from its step stream. The order matters
 * — a stalled run with an outstanding tool call is "awaiting_input"
 * rather than "stalled," and "errored" beats everything else.
 */
export function classifyRunStatus(
  run: Run,
  steps: Step[],
  stallSeconds: number,
): LiveStatus {
  if (run.status === "ok") return "completed";
  if (run.status === "error") return "errored";
  if (steps.length === 0) return "progressing";
  const last = steps[steps.length - 1]!;
  const ageS = (Date.now() - new Date(last.timestamp).getTime()) / 1000;
  if (last.outcome.status === "pending") {
    return ageS > stallSeconds ? "stalled" : "awaiting_input";
  }
  if (ageS > stallSeconds) return "stalled";
  if (detectLoop(steps, 4)) return "looping";
  return "progressing";
}

/**
 * Loop detection: the last `window` steps share the same tool and the
 * same canonical input. Returns the loop signature or undefined if no
 * loop is detected. window=4 by default; rationale per SPEC §10.x —
 * three repeats can be coincidence, four is a pattern worth surfacing.
 */
export function detectLoop(
  steps: Step[],
  window = 4,
): { tool: string; signature: string; repeats: number } | undefined {
  if (steps.length < window) return undefined;
  const tail = steps.slice(-window);
  const first = tail[0]!;
  if (first.action.kind !== "tool_call" || !first.action.tool_name) {
    return undefined;
  }
  const sig = JSON.stringify(first.action.tool_input ?? null);
  for (let i = 1; i < tail.length; i++) {
    const s = tail[i]!;
    if (
      s.action.kind !== "tool_call" ||
      s.action.tool_name !== first.action.tool_name ||
      JSON.stringify(s.action.tool_input ?? null) !== sig
    ) {
      return undefined;
    }
  }
  return {
    tool: first.action.tool_name,
    signature: sig.slice(0, 64),
    repeats: window,
  };
}
