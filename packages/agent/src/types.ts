import type {
  Action,
  ContextComponent,
  Outcome,
  TokenUsage,
} from "@spool/shared";

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
  sourceRuntime?: "sdk-ts" | "claude-code" | "codex-cli" | "cursor" | "fork";
  /** Source session id (e.g. the host runtime's session uuid). */
  sourceSessionId?: string;
  /** Working directory associated with the run. */
  cwd?: string;
  /** Git branch associated with the run. */
  gitBranch?: string;
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
