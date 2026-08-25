/**
 * GitHub Copilot CLI `events.jsonl` record shapes.
 *
 * IMPORTANT: this format is GitHub's undocumented private exhaust, not
 * a stable product surface (design doc: docs/designs/copilot-squad-adapter.md,
 * "Unsupported-source positioning"). Every field access in the adapter
 * is defensive (`?.` + alias fallbacks), and the shape probe warns —
 * never throws — when records drift from what these types claim.
 *
 * Observed vocabulary (community corpus + copilot-session-explorer):
 *   session.start / session.resume / session.info / session.error /
 *   session.model_change / session.compaction_start / session.compaction_end
 *   user.message
 *   assistant.message / assistant.turn_start / assistant.turn_end
 *   tool.execution_start / tool.execution_complete / tool.user_requested
 *   subagent.started / subagent.completed
 *
 * Phase 0 of the design gates the parser spec on firsthand fixtures;
 * until those land, the alias fallbacks below (`toolCallId` vs `callId`,
 * `input_tokens` vs `inputTokens`, …) cover the shape variants the
 * community corpus shows. The probe surfaces anything neither covers.
 */

/** One line of events.jsonl. */
export interface CopilotEvent {
  type?: string;
  /** Unique event id — the correlation substrate for sub-agent carving. */
  id?: string;
  timestamp?: string;
  /** Link to the causally-prior event; null/absent at stream roots. */
  parentId?: string | null;
  data?: CopilotEventData;
}

/** Union of the data payloads we read, all-optional by design. */
export interface CopilotEventData {
  // session.*
  sessionId?: string;
  session_id?: string;
  version?: string;
  model?: string;
  modelId?: string;
  cwd?: string;
  workspace?: string;
  error?: unknown;
  message?: unknown;

  // user.message / assistant.message
  content?: unknown;
  text?: unknown;
  reasoning?: unknown;

  // assistant.turn_*
  turnId?: string;
  turn_id?: string;
  usage?: CopilotUsage;

  // tool.execution_*
  name?: string;
  tool?: string;
  toolName?: string;
  toolCallId?: string;
  callId?: string;
  call_id?: string;
  arguments?: unknown;
  input?: unknown;
  args?: unknown;
  result?: unknown;
  output?: unknown;
  success?: boolean;
  isError?: boolean;

  // subagent.*
  agentName?: string;
  agentType?: string;
  agent?: string;
  subagentId?: string;
  subagent_id?: string;
  description?: string;
  prompt?: unknown;

  [key: string]: unknown;
}

/** Server-reported usage, shape variants covered by aliases. */
export interface CopilotUsage {
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cache_read_tokens?: number;
  cached_tokens?: number;
  cachedTokens?: number;
  cache_read_input_tokens?: number;
  premium_requests?: number;
  premiumRequests?: number;
  cost?: number;
  [key: string]: unknown;
}

/** Normalized view the carver works with. */
export interface NormalizedUsage {
  input: number;
  output: number;
  cached_read: number;
  premium_requests: number;
}

export function normalizeUsage(u: CopilotUsage | undefined): NormalizedUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const input = firstNumber(u.input_tokens, u.inputTokens);
  const output = firstNumber(u.output_tokens, u.outputTokens);
  const cached = firstNumber(
    u.cache_read_tokens,
    u.cache_read_input_tokens,
    u.cached_tokens,
    u.cachedTokens,
  );
  const premium = firstNumber(u.premium_requests, u.premiumRequests);
  if (
    input === undefined &&
    output === undefined &&
    cached === undefined &&
    premium === undefined
  ) {
    return undefined;
  }
  return {
    input: input ?? 0,
    output: output ?? 0,
    cached_read: cached ?? 0,
    premium_requests: premium ?? 0,
  };
}

function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** data.sessionId with alias fallback. */
export function sessionIdOf(e: CopilotEvent): string | undefined {
  return strOf(e.data?.sessionId) ?? strOf(e.data?.session_id);
}

/** Tool name with alias fallback. */
export function toolNameOf(e: CopilotEvent): string | undefined {
  return strOf(e.data?.name) ?? strOf(e.data?.tool) ?? strOf(e.data?.toolName);
}

/** Tool call correlation id with alias fallback. */
export function toolCallIdOf(e: CopilotEvent): string | undefined {
  return (
    strOf(e.data?.toolCallId) ?? strOf(e.data?.callId) ?? strOf(e.data?.call_id)
  );
}

/** Tool input payload with alias fallback. */
export function toolInputOf(e: CopilotEvent): unknown {
  return e.data?.arguments ?? e.data?.input ?? e.data?.args;
}

/** Prompt-ish text of a spawn event, with alias fallback. */
function promptTextOf(e: CopilotEvent): string | undefined {
  return (
    strOf(e.data?.prompt) ?? strOf(e.data?.description) ?? strOf(e.data?.content)
  );
}

/** Squad spawn prompts open with "You are {Name}, the {Role} on this
 *  project" — ONE regex parses both halves so name and role can never
 *  desync (adapter-core responsibility per the design doc; the squad
 *  enrichment layer only adds detection + tags). */
const SQUAD_IDENTITY_RE =
  /You are ([^,\n]{1,60}), the ([^,\n]{1,80}?)(?: on| for|[.,\n])/;

function parseSquadPromptIdentity(promptText: string): {
  name?: string;
  role?: string;
} {
  const m = SQUAD_IDENTITY_RE.exec(promptText);
  if (m?.[1]) return { name: m[1].trim(), role: m[2]?.trim() };
  // "🔧 EECOM: Refactoring auth" style descriptions.
  const d = /^[^\w]*([A-Z][\w-]{1,30}):\s/.exec(promptText);
  if (d?.[1]) return { name: d[1] };
  return {};
}

/** Sub-agent display name with alias fallback + spawn-prompt parsing. */
export function subagentNameOf(e: CopilotEvent): string | undefined {
  const explicit =
    strOf(e.data?.agentName) ??
    strOf(e.data?.agent) ??
    strOf(e.data?.name) ??
    strOf(e.data?.agentType);
  if (explicit) return explicit;
  const promptText = promptTextOf(e);
  return promptText ? parseSquadPromptIdentity(promptText).name : undefined;
}

/** Sub-agent role parsed from a squad-style spawn prompt, if present. */
export function subagentRoleOf(e: CopilotEvent): string | undefined {
  const promptText = promptTextOf(e);
  return promptText ? parseSquadPromptIdentity(promptText).role : undefined;
}

/** Sub-agent correlation id (distinct from the event's own id). */
export function subagentIdOf(e: CopilotEvent): string | undefined {
  return strOf(e.data?.subagentId) ?? strOf(e.data?.subagent_id);
}

/** Message text content with alias fallback; objects are stringified. */
export function contentTextOf(e: CopilotEvent): string | undefined {
  const c = e.data?.content ?? e.data?.text ?? e.data?.message;
  if (typeof c === "string") return c;
  if (c === undefined || c === null) return undefined;
  try {
    return JSON.stringify(c);
  } catch {
    return undefined;
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
