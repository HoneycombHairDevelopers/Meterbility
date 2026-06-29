import {
  confirmPaused,
  consumeInject,
  readState,
  type ProbeRecord,
} from "@meterbility/shared";

/**
 * SDK-side Probe hook — Track B / Turn 8 chunk 2.
 *
 * Runs before every model call when `tracer.probeEnabled` is true.
 * Implements the graceful-pause + inject contract from SPEC §7.1:
 *
 *   1. If an operator has requested a pause, the SDK acknowledges
 *      (confirmPaused) and blocks until the operator resumes. The
 *      CURRENT model call (if any) is never interrupted — the check
 *      happens at the TOP of the call wrapper, so any in-flight stream
 *      completes naturally before we yield.
 *
 *   2. After the pause check (or if no pause was active), the SDK
 *      consumes any pending inject message and appends it to the
 *      request's `messages` array as a new user turn. This is how the
 *      operator's "hey, the failing test is a stale fixture" nudge
 *      reaches the model.
 *
 * When `probeEnabled` is false on the tracer, none of this runs and
 * the cost is one boolean check per call.
 *
 * ## Testability seams
 *
 * - `sleep(ms)`: how long to wait between probe-state polls. Tests
 *   inject a synchronous-ish stub that flips state on first call.
 *   Production uses a real `setTimeout` wrapper.
 * - `now()`: clock for timestamping pause acknowledgements. Tests pass
 *   a counter; production uses `Date.now`.
 *
 * The hook is intentionally pure-functional on its arguments — it
 * never reaches into the tracer instance for state, only for config.
 */

export interface ProbeRuntime {
  /** How long to wait between probe-state polls while paused. */
  pollIntervalMs: number;
  /** Sleep implementation (injectable for tests). */
  sleep: (ms: number) => Promise<void>;
  /** Clock (injectable for tests). */
  now: () => number;
}

export const DEFAULT_PROBE_RUNTIME: ProbeRuntime = {
  pollIntervalMs: 250,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * The shape `applyProbeToRequest` needs from any "request with a
 * messages array." Kept structural so it works for the Anthropic
 * request shape AND any future provider request shape — we never
 * import a specific SDK's types into this hook.
 */
export interface ProbeMutableRequest {
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<unknown>;
  }>;
}

/**
 * Run the probe protocol against this call.
 *
 * 1. Read current probe state.
 * 2. If `pause_requested`, confirm and poll until `running`.
 * 3. After unblocking, consume any pending inject and append it to
 *    `req.messages` as a user turn.
 *
 * Returns the (possibly modified) request. Caller passes the result on
 * to the underlying SDK call.
 */
export async function applyProbeToRequest<R extends ProbeMutableRequest>(
  runId: string,
  req: R,
  runtime: ProbeRuntime = DEFAULT_PROBE_RUNTIME,
): Promise<R> {
  let state: ProbeRecord = readState(runId, runtime.now);

  // 1. Graceful pause — acknowledge and block until operator resumes.
  if (state.state === "pause_requested") {
    state = confirmPaused(runId, runtime.now);
    while (state.state !== "running") {
      await runtime.sleep(runtime.pollIntervalMs);
      state = readState(runId, runtime.now);
    }
  }

  // 2. Inject — append any queued message as a new user turn. We
  // append (not prepend) so the inject is the LAST thing the model
  // sees, which is how a human nudge naturally lands in a conversation.
  const injected = consumeInject(runId, runtime.now);
  if (injected !== null) {
    return {
      ...req,
      messages: [...req.messages, { role: "user" as const, content: injected }],
    };
  }

  return req;
}
