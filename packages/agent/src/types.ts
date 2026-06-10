import type {
  Action,
  ContextComponent,
  Outcome,
  TokenUsage,
} from "@spool-ai/shared";

/**
 * Public SDK types for custom TS agents. The shape is deliberately small
 * and host-agnostic — anywhere you call a model and run tools, you can
 * emit Steps. The collector handles the rest.
 */

export interface TracerOptions {
  /** Project — usually a path or stable identifier for the codebase. */
  project: string;
  /** Logical agent identity within the project. */
  agent: string;
  /** Free-form title for the run. Often the user's first message. */
  runTitle?: string;
  /** Free-form tags. */
  tags?: string[];
  /** Override SPOOL_HOME for this tracer. */
  spoolHome?: string;
  /** Override the source_runtime label. Defaults to "sdk-ts". */
  sourceRuntime?:
    | "sdk-ts"
    | "sdk-py"
    | "claude-code"
    | "codex-cli"
    | "cursor"
    | "fork";
  /** Source session id (e.g. the host runtime's session uuid). */
  sourceSessionId?: string;
  /** Working directory associated with the run. */
  cwd?: string;
  /** Git branch associated with the run. */
  gitBranch?: string;
  /**
   * Enable the Live Probe hook. When true, the SDK checks
   * `$SPOOL_HOME/probe/<run_id>.json` before each model call and:
   *   - blocks until an operator-initiated pause is released
   *   - prepends any queued inject message to the next user turn
   *
   * Defaults to false — zero overhead when the operator isn't using
   * the probe. Turn this on when you want `spool probe` / the web
   * probe panel to be able to graceful-pause this run.
   */
  probeEnabled?: boolean;
  /**
   * How often (ms) to poll the probe file while paused. Defaults to
   * 250ms — fast enough to feel responsive in the operator UI, slow
   * enough that idle pauses don't churn the filesystem.
   */
  probePollIntervalMs?: number;
}

export interface StartStepOptions {
  /** Model identity, e.g. "claude-opus-4-7". */
  model: string;
  /** Optional system prompt bytes — added to the context snapshot. */
  systemPrompt?: string;
  /** Optional tool definitions — added to the context snapshot. */
  toolDefinitions?: unknown;
  /** Optional retrieved docs — added to the context snapshot. */
  retrievedDocs?: Array<{ source: string; content: string }>;
  /** Conversation history components (user/assistant/tool messages). */
  history?: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  /** Additional context components (advanced). */
  extraComponents?: ContextComponent[];
  /** Optional tags to apply to this step. */
  tags?: string[];
}

export interface RecordDecisionOptions {
  /** Raw model output (typed unknown — caller passes whatever the SDK returned). */
  decision: unknown;
  /** Action representation. Use {@link helpers} or build manually. */
  action: Action;
}

export interface RecordOutcomeOptions {
  outcome: Outcome;
}

export interface RecordTokensOptions {
  tokens: TokenUsage;
  /** Wall-clock ms from start_step to end. Optional — tracer computes if omitted. */
  latency_ms?: number;
}

/**
 * Quick helpers for common Action shapes — keeps caller code tidy.
 */
export const helpers = {
  toolCall(name: string, input: unknown, id?: string): Action {
    return { kind: "tool_call", tool_name: name, tool_use_id: id, tool_input: input };
  },
  message(text: string): Action {
    return { kind: "message", text };
  },
  thinkingOnly(): Action {
    return { kind: "thinking_only" };
  },
  subAgent(name: string): Action {
    return { kind: "sub_agent_dispatch", sub_agent: name };
  },
};
