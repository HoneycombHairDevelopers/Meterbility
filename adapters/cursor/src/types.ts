/**
 * Cursor's cursorDiskKV schema (reverse-engineered from the global
 * `state.vscdb` shipped with Cursor 2.x). Three key prefixes carry the
 * conversation surface:
 *
 *   composerData:<composerId>            — conversation envelope + index
 *   bubbleId:<composerId>:<bubbleId>     — one message (user or assistant)
 *   messageRequestContext:<composerId>:<requestId>  — provider-side request bytes
 *
 * Cursor changes these schemas without notice. The adapter probes for the
 * keys it knows and degrades gracefully when fields are missing.
 */

/** type=1 = user, type=2 = assistant. */
export type CursorBubbleType = 1 | 2;

export interface CursorConversationHeader {
  bubbleId: string;
  type: CursorBubbleType;
  serverBubbleId?: string;
}

export interface CursorComposerData {
  _v?: number;
  composerId: string;
  name?: string;
  subtitle?: string;
  unifiedMode?: number | string;
  forceMode?: string;
  status?: string;
  text?: string;
  richText?: string;
  fullConversationHeadersOnly?: CursorConversationHeader[];
  conversationMap?: Record<string, unknown>;
  context?: Record<string, unknown>;
  capabilities?: unknown[];
  modelConfig?: Record<string, unknown>;
  usageData?: Record<string, unknown>;
  contextUsagePercent?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  createdAt?: number; // epoch ms
  lastUpdatedAt?: number;
  isArchived?: boolean;
  hasUnreadMessages?: boolean;
}

export interface CursorTokenCount {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CursorToolFormerData {
  /** Cursor encodes the tool kind both as a numeric `tool` index and a
   *  human-readable `name`. We rely on `name`. */
  tool?: number;
  name?: string;
  toolCallId?: string;
  modelCallId?: string;
  status?: "completed" | "errored" | "pending" | string;
  /** JSON-encoded args as the model emitted them. */
  rawArgs?: string;
  /** Parsed/effective args after Cursor's normalization. */
  params?: string;
  /** Tool result body (often a stringified blob). */
  result?: unknown;
  additionalData?: unknown;
}

export interface CursorThinkingBlock {
  text?: string;
  signature?: string;
  redacted?: boolean;
}

export interface CursorBubble {
  _v?: number;
  bubbleId: string;
  type: CursorBubbleType;
  text?: string;
  richText?: string;
  createdAt?: string;
  requestId?: string;
  tokenCount?: CursorTokenCount;
  toolFormerData?: CursorToolFormerData;
  allThinkingBlocks?: CursorThinkingBlock[];
  toolResults?: unknown[];
  codeBlocks?: unknown[];
  attachedCodeChunks?: unknown[];
  context?: Record<string, unknown>;
  capabilityType?: number;
}

export function isUserBubble(b: CursorBubble): boolean {
  return b.type === 1;
}

export function isAssistantBubble(b: CursorBubble): boolean {
  return b.type === 2;
}

export function bubbleText(b: CursorBubble): string {
  if (b.text && b.text.length > 0) return b.text;
  // Fall back to extracting plain text from Lexical-format richText.
  if (b.richText) {
    try {
      return extractLexicalText(JSON.parse(b.richText));
    } catch {
      return "";
    }
  }
  return "";
}

interface LexicalNode {
  text?: string;
  children?: LexicalNode[];
}

function extractLexicalText(root: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as LexicalNode & { root?: LexicalNode };
    if (node.root) walk(node.root);
    if (typeof node.text === "string") out.push(node.text);
    if (node.children) for (const c of node.children) walk(c);
  };
  walk(root);
  return out.join("");
}
