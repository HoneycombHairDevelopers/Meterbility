/**
 * Spool trace format — entity types per SPEC §6.
 *
 * Stable across replay. Content-addressed blobs referenced by SHA256.
 */

export type StepStatus = "ok" | "error" | "abandoned" | "in_progress";

export type AnnotationVerdict =
  | "correct"
  | "incorrect"
  | "unclear"
  | "good_decision"
  | "bad_decision";

export type ForkEditType =
  | "replace_system_prompt"
  | "add_context"
  | "remove_tool"
  | "modify_tool_description"
  | "replace_user_message"
  | "inject_message"
  | "change_model";

export type ContentRef = string;

export interface TokenUsage {
  input: number;
  output: number;
  cached_read: number;
  /**
   * 5-minute ephemeral cache writes (the cheaper tier — ~1.25× input).
   * Anthropic field: `usage.cache_creation.ephemeral_5m_input_tokens`,
   * or fallback to `usage.cache_creation_input_tokens` when the breakdown
   * isn't present.
   */
  cache_creation: number;
  /**
   * 1-hour ephemeral cache writes (~2× input). Claude Code uses this for
   * the long-lived system prompt + tool definitions, so it's typically
   * the dominant cost on long sessions. Optional for back-compat — older
   * captures will leave this at 0 and continue to be priced as 5m only.
   */
  cache_creation_1h?: number;
  reasoning?: number;
}

export interface Project {
  project_id: string;
  name: string;
  cwd: string;
  created_at: string;
}

export interface Agent {
  agent_id: string;
  project_id: string;
  name: string;
  created_at: string;
}

export interface Run {
  run_id: string;
  agent_id: string;
  project_id: string;
  source_session_id?: string;
  source_runtime:
    | "claude-code"
    | "codex-cli"
    | "cursor"
    | "sdk-ts"
    | "sdk-py"
    | "fork";
  title?: string;
  status: StepStatus;
  started_at: string;
  ended_at?: string;
  git_branch?: string;
  cwd?: string;
  fork_origin_run_id?: string;
  fork_origin_step_id?: string;
  tokens_total_input: number;
  tokens_total_output: number;
  tokens_total_cached: number;
  cost_cents: number;
  step_count: number;
  tags: string[];
}

export type ActionKind =
  | "tool_call"
  | "message"
  | "sub_agent_dispatch"
  | "thinking_only"
  | "none";

export interface Action {
  kind: ActionKind;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  text?: string;
  sub_agent?: string;
}

export interface Outcome {
  status: "ok" | "error" | "pending";
  tool_result_ref?: ContentRef;
  is_error?: boolean;
  summary?: string;
  state_delta?: unknown;
}

export interface Step {
  step_id: string;
  run_id: string;
  parent_step_id?: string;
  fork_origin_id?: string;
  sequence: number;
  timestamp: string;
  model: string;
  context_snapshot_id: ContentRef;
  decision_ref: ContentRef;
  action: Action;
  outcome: Outcome;
  tokens: TokenUsage;
  latency_ms: number;
  cost_cents: number;
  tags: string[];
  status: StepStatus;
}

export type ContextComponentType =
  | "system_prompt"
  | "tool_definitions"
  | "conversation_history"
  | "retrieved_documents"
  | "compaction_summary";

export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  content_ref: ContentRef;
  step_ref?: string;
}

export interface RetrievedDocument {
  source: string;
  content_ref: ContentRef;
  retrieval_step_ref?: string;
}

export type ContextComponent =
  | { type: "system_prompt"; content_ref: ContentRef }
  | { type: "tool_definitions"; content_ref: ContentRef }
  | { type: "conversation_history"; messages: ConversationMessage[] }
  | { type: "retrieved_documents"; docs: RetrievedDocument[] }
  | {
      type: "compaction_summary";
      replaces_steps: string[];
      content_ref: ContentRef;
    };

export interface ContextSnapshot {
  id: ContentRef;
  components: ContextComponent[];
}

export interface ForkEdit {
  type: ForkEditType;
  payload: unknown;
}

export interface Fork {
  fork_id: string;
  origin_run_id: string;
  origin_step_id: string;
  edit: ForkEdit;
  fork_run_id: string;
  created_at: string;
}

export interface Annotation {
  annotation_id: string;
  target_kind: "step" | "run";
  target_id: string;
  author: string;
  verdict?: AnnotationVerdict;
  note?: string;
  created_at: string;
}

export interface ModelPricing {
  model: string;
  input_per_million_cents: number;
  output_per_million_cents: number;
  cached_read_per_million_cents: number;
  /** 5-minute ephemeral cache writes (~1.25× input). */
  cache_creation_per_million_cents: number;
  /** 1-hour ephemeral cache writes (~2× input). Optional — defaults to
   *  2× input when not specified. */
  cache_creation_1h_per_million_cents?: number;
}
