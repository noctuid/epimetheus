/**
 * Low-level session file parsing (Hindsight agnostic).
 *
 * Reads raw session files, extracts header/entries, builds the message array
 * for upsert, and computes document tags/context. Produces in-memory data only —
 * does not write to disk. Higher-level orchestration (structured results,
 * cache I/O) lives in parsed-store.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HindsightConfig, RetainContent, ToolFilter } from "./config";
import { prepareEntry, shouldRetainMessage } from "./prepare";
import { extractParentSessionId, getBasedir, getProjectName } from "./utils";

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** Present on session_info entries. */
  name?: string;
  /** Present on custom entries (e.g. hindsight-meta). */
  customType?: string;
  /** Payload of custom entries. */
  data?: unknown;
  message?: {
    role: string;
    content: unknown;
    responseId?: string;
    timestamp?: number;
  };
}

/**
 * Parse a session file and return header + entries.
 * Skips malformed JSON lines with a warning.
 */
export function parseSessionFile(sessionPath: string): {
  header: SessionHeader;
  entries: SessionEntry[];
} {
  const content = readFileSync(sessionPath, "utf-8");
  const lines = content.split("\n");

  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "session") {
        header = parsed as SessionHeader;
      } else {
        entries.push(parsed as SessionEntry);
      }
    } catch {
      console.warn(`Skipping malformed JSON at line ${i + 1} in ${sessionPath}`);
    }
  }

  if (!header) {
    throw new Error(`Invalid session file: missing header in ${sessionPath}`);
  }

  return { header, entries };
}

/**
 * Check if an entry is a conversation message.
 * Only entries with type "message" are conversation messages;
 * custom_message entries are excluded by the type check.
 */
function isConversationMessage(
  entry: SessionEntry,
  retainContent: RetainContent,
  toolFilter?: ToolFilter
): boolean {
  if (entry.type !== "message" || entry.message === undefined) {
    return false;
  }
  return shouldRetainMessage(entry.message, retainContent, toolFilter);
}

/**
 * Format an entry for the document, filtering content and stripping fields.
 */
function formatEntry(
  entry: SessionEntry,
  config: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter">
): object {
  // Use prepareEntry for consistent handling with runtime message preparation
  return prepareEntry(entry as unknown as Record<string, unknown>, config);
}

/**
 * Load parent session's assistant message IDs into a Set.
 */
function loadParentAssistantIds(parentPath: string): Set<string> {
  if (!existsSync(parentPath)) {
    throw new Error(`Parent session file not found: ${parentPath}`);
  }

  const { entries } = parseSessionFile(parentPath);
  const assistantIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.id) {
      assistantIds.add(entry.id);
    }
  }

  return assistantIds;
}

/**
 * Find the index of the first assistant message with an id not in parent.
 * Returns -1 if no fork point found (all assistant messages exist in parent).
 *
 * Note: Forks with only new user content (no assistant reply yet) will return -1
 * and be treated as "No new content in fork". This is intentional — a user message
 * almost always has an assistant reply after it, and persisting just a user message
 * without the response isn't very useful. If the assistant does reply, the fork
 * will be detected on the next parse.
 */
function findForkPoint(
  conversationEntries: SessionEntry[],
  parentAssistantIds: Set<string>
): number {
  return conversationEntries.findIndex(
    (e) => e.message?.role === "assistant" && e.id && !parentAssistantIds.has(e.id)
  );
}

/**
 * Find the start index for fork content (user message before fork point).
 */
function findForkStartIndex(conversationEntries: SessionEntry[], forkPoint: number): number {
  for (let i = forkPoint - 1; i >= 0; i--) {
    const entry = conversationEntries[i];
    if (entry && entry.message?.role === "user") {
      return i;
    }
  }
  return forkPoint;
}

/**
 * Build an array of formatted messages from pre-parsed session data.
 * Uses fork detection if the session has a parent.
 */
export function buildMessageArrayFromParsedSession(
  header: SessionHeader,
  entries: SessionEntry[],
  config: HindsightConfig
): { messages: object[]; sessionId: string; warning?: string } {
  // Check parentSession BEFORE filtering
  if (header.parentSession) {
    // Try to load parent assistant IDs; if this fails, we cannot determine
    // the fork point and must return zero messages to avoid duplicating
    // parent content in Hindsight.
    let parentAssistantIds: Set<string>;
    try {
      parentAssistantIds = loadParentAssistantIds(header.parentSession);
    } catch (e) {
      // Preserve the actual error message for diagnostics
      const reason = e instanceof Error ? e.message : String(e);
      return {
        messages: [],
        sessionId: header.id,
        warning: `Cannot determine fork point for ${header.parentSession}: ${reason}`,
      };
    }
    return buildForkedMessages(entries, header, parentAssistantIds, config);
  }

  // Not a fork - include all conversation messages
  const messages = buildMessageArray(entries, config);
  return {
    messages,
    sessionId: header.id,
  };
}

/**
 * Build array of formatted messages from entries (non-fork case).
 */
function buildMessageArray(
  entries: SessionEntry[],
  config: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter">
): object[] {
  const conversationEntries = entries.filter((e) =>
    isConversationMessage(e, config.retainContent, config.toolFilter)
  );
  return conversationEntries.map((e) => formatEntry(e, config));
}

/**
 * Build message array for a forked session.
 */
function buildForkedMessages(
  entries: SessionEntry[],
  header: SessionHeader,
  parentAssistantIds: Set<string>,
  config: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter">
): { messages: object[]; sessionId: string; warning?: string } {
  const conversationEntries = entries.filter((e) =>
    isConversationMessage(e, config.retainContent, config.toolFilter)
  );

  // Find first assistant with id NOT in parent
  const forkPoint = findForkPoint(conversationEntries, parentAssistantIds);

  if (forkPoint === -1) {
    return { messages: [], sessionId: header.id, warning: "No new content in fork" };
  }

  // Walk backward in conversationEntries to find the previous user message
  const startIndex = findForkStartIndex(conversationEntries, forkPoint);
  const messages = conversationEntries.slice(startIndex).map((e) => formatEntry(e, config));

  return {
    messages,
    sessionId: header.id,
  };
}

/**
 * Build tags for a document.
 */
export function buildDocumentTags(
  header: SessionHeader,
  config: HindsightConfig,
  options?: { storeMethod?: "auto" | "tool"; sessionUserTags?: string[]; parentSessionId?: string }
): string[] {
  const tags = [
    ...config.constantTags,
    `session:${header.id}`,
    `cwd:${header.cwd}`,
    `basedir:${getBasedir(header.cwd)}`,
    `project:${getProjectName(header.cwd)}`,
    `store_method:${options?.storeMethod ?? "auto"}`,
  ];

  // Add parent tag - parent session ID if forked, otherwise self
  if (header.parentSession) {
    // Use provided parent ID if available, otherwise extract from parent session file
    const parentId = options?.parentSessionId ?? extractParentSessionId(header.parentSession);
    tags.push(`parent:${parentId ?? header.id}`);
  } else if (options?.parentSessionId) {
    tags.push(`parent:${options.parentSessionId}`);
  } else {
    tags.push(`parent:${header.id}`);
  }

  // Add session metadata tags
  if (options?.sessionUserTags) {
    tags.push(...options.sessionUserTags);
  }

  return tags;
}

/**
 * Build context string from a session name.
 *
 * Uses only the prefix + session name + extra context, with NO truncation.
 * The session name should already be derived and truncated by
 * {@link deriveSessionName} — this function just assembles the final string.
 * Shared by document.ts (for parse-and-upsert) and retention.ts (for auto-flush).
 */
export function buildContextFromSessionName(
  hindsightContextPrefix: string,
  sessionName: string,
  extraContext?: string
): string {
  const base = hindsightContextPrefix + sessionName;
  if (!extraContext) return base;
  return `${base}\n${extraContext}`;
}
