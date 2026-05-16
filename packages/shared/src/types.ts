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

/**
 * v0.3 Live Probe state. `paused` means the next `tracer.startStep()`
 * call on an SDK-instrumented run will block. `resumed` is a transient
 * state set when the resume endpoint fires, cleared once the next step
 * actually proceeds. `null` (the dominant case) means the run was never
 * probed.
 */
export type ProbeState = "paused" | "resumed";

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
    | "proxy"
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
  /**
   * v0.3 — Link to the baseline working tree captured at run start.
   * `undefined` is the dominant case: non-coding runs never trigger
   * baseline capture, and v0.3 Claude Code runs only populate this on
   * the first FileChange. See §3.3.3.
   */
  baseline_tree_id?: string;
  /** v0.3 — Live Probe state. `undefined` = never probed. See §4.5. */
  probe_state?: ProbeState;
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

/* ────────────────────────────────────────────────────────────────────
 * v0.3 — Step-by-step file change capture (Track A).
 *
 * Vendor-neutral. Claude Code hook adapter writes v0.3 rows; Codex /
 * SDK / proxy / file-watcher will fill in additional source paths in
 * v0.4 without schema changes (see schema.ts comment about full enum
 * coverage up front).
 * ──────────────────────────────────────────────────────────────────── */

export type FileOp = "create" | "modify" | "delete" | "rename" | "chmod";

export type FileChangeSource = "tool_call" | "filesystem_watch" | "git_diff";

export type PatchFormat = "unified" | "binary" | "notebook_cell";

export type FileEncoding = "utf-8" | "utf-16-le" | "utf-16-be" | "binary";

export type LineEndings = "lf" | "crlf" | "mixed";

/**
 * One FileChange row corresponds to one file mutation attributed to a
 * Step. One Step can produce many: MultiEdit fans out N rows, an
 * apply_patch envelope produces one per section, etc. Path-keyed access
 * is core (per v0.3 §3.1.2) — see the indexes on file_change.
 *
 * Content references:
 *   - `before_blob_ref` is null iff `op === "create"` OR `partial_diff`.
 *   - `after_blob_ref` is null iff `op === "delete"` OR `partial_diff`.
 *   - The `partial_diff` flag distinguishes "we didn't capture this"
 *     from "this side genuinely doesn't exist." The UI uses it to render
 *     the right affordance.
 */
export interface FileChange {
  file_change_id: string;
  run_id: string;
  step_id: string;
  /** Intra-step ordering for atomic batches (MultiEdit, apply_patch). */
  sequence: number;
  /** Soft FK into the parent step's action.tool_use_id. */
  tool_call_id?: string;
  derived_from: FileChangeSource;
  /** Repo-relative, POSIX separators. Never absolute. */
  path: string;
  /** Only set for `op: "rename"`. */
  old_path?: string;
  op: FileOp;
  before_blob_ref?: string;
  after_blob_ref?: string;
  /** Capture was incomplete — see the flag's docstring above. */
  partial_diff: boolean;
  /** True if path is in .gitignore. Captured but flagged. */
  gitignored: boolean;
  /** Cached unified diff. Derivable from before/after blob refs. */
  patch_text?: string;
  patch_format?: PatchFormat;
  encoding?: FileEncoding;
  bom: boolean;
  line_endings?: LineEndings;
  mime?: string;
  language?: string;
  size_before?: number;
  size_after?: number;
  line_count_before?: number;
  line_count_after?: number;
  lines_added: number;
  lines_removed: number;
  /** POSIX mode bits (e.g., 0o100644). */
  mode_before?: number;
  mode_after?: number;
  /** "Edit", "MultiEdit", "Write", "apply_patch", etc. */
  source_tool_name?: string;
  /** Verbatim, post-redaction. Stored as JSON in the row. */
  source_tool_input?: unknown;
  redacted: boolean;
  /** Audit trail: which normalizer rules fired (rename collapse, etc). */
  normalizer_notes?: unknown;
  created_at: string;
}

/**
 * Working-tree snapshot at Run start. Captured lazily on the first
 * FileChange — the manifest blob (sorted, NUL-separated, newline-
 * delimited) lives in the regular content-addressed blob store, so
 * identical trees dedup naturally.
 */
export interface BaselineTree {
  baseline_tree_id: string;
  project_id: string;
  /** SHA of the serialized manifest blob. */
  manifest_blob_ref: string;
  /** Advisory: commit SHA from `git rev-parse HEAD` if cwd is a git repo. */
  git_head?: string;
  /** Advisory: true if `git status --porcelain` returned any lines. */
  git_dirty: boolean;
  captured_at: string;
}

/** One entry in a parsed manifest. Mode is POSIX bits. */
export interface ManifestEntry {
  path: string;
  mode: number;
  blob_ref: string;
}

/**
 * Materialized working tree at a point in time — the output of
 * `workingTreeAt(run, step)`. Keys are repo-relative paths; values
 * carry both content (blob_ref) and mode bits so chmod-only changes
 * have a place to live.
 */
export type WorkingTree = Map<string, { blob_ref: string; mode: number }>;

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
