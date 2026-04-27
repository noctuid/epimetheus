/**
 * Document building from pi session files.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HindsightConfig, RetainContent, ToolFilter } from "./config";
import { prepareEntry, shouldRetainMessage } from "./prepare";
import {
  extractParentSessionId,
  extractTextFromContent,
  getBasedir,
  getProjectName,
  truncate,
} from "./utils";

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
  message?: {
    role: string;
    content: unknown;
    responseId?: string;
    timestamp?: number;
  };
}

export interface DocumentContent {
  content: string;
  documentId: string;
  warning?: string;
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
  const lines = content.trim().split("\n");

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
 * Excludes hindsight-recall messages (injected recall context, not user/assistant content).
 */
function isConversationMessage(
  entry: SessionEntry,
  retainContent: RetainContent,
  toolFilter?: ToolFilter
): boolean {
  if (entry.type !== "message" || entry.message === undefined) {
    return false;
  }
  // Filter out hindsight-recall messages (injected context, not real conversation)
  const message = entry.message as Record<string, unknown>;
  if (message.customType === "hindsight-recall") {
    return false;
  }
  return shouldRetainMessage(message, retainContent, toolFilter);
}

/**
 * Format an entry for the document, filtering content and stripping fields.
 */
function formatEntry(
  entry: SessionEntry,
  config: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter">
): object {
  // Use prepareEntry for consistent handling with auto-queue
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
 * Truncate session title for Hindsight context field.
 */
function truncateSessionTitle(entries: SessionEntry[], config: HindsightConfig): string {
  // Find first user message or use session name
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "user") {
      const text = extractTextFromContent(entry.message.content);
      if (text) {
        return truncate(config.hindsightContextPrefix + text, config.hindsightContextMaxLength);
      }
    }
  }

  return `${config.hindsightContextPrefix}pi session`;
}

/**
 * Build document content from a session file.
 *
 * Delegates to {@link buildMessageArrayFromParsedSession} and serializes to JSON.
 */
export function buildDocumentContent(
  sessionPath: string,
  config: HindsightConfig
): DocumentContent {
  const { header, entries } = parseSessionFile(sessionPath);
  const { messages, documentId, warning } = buildMessageArrayFromParsedSession(
    header,
    entries,
    config
  );
  return {
    content: JSON.stringify(messages),
    documentId,
    warning,
  };
}

/**
 * Build an array of formatted messages from session entries.
 * Uses fork detection if the session has a parent.
 */
export function buildMessageArrayFromSession(
  sessionPath: string,
  config: HindsightConfig
): { messages: object[]; documentId: string; warning?: string } {
  const { header, entries } = parseSessionFile(sessionPath);
  return buildMessageArrayFromParsedSession(header, entries, config);
}

/**
 * Build an array of formatted messages from pre-parsed session data.
 * Uses fork detection if the session has a parent.
 */
export function buildMessageArrayFromParsedSession(
  header: SessionHeader,
  entries: SessionEntry[],
  config: HindsightConfig
): { messages: object[]; documentId: string; warning?: string } {
  // Check parentSession BEFORE filtering
  if (header.parentSession) {
    try {
      const parentAssistantIds = loadParentAssistantIds(header.parentSession);
      return buildForkedMessages(entries, header, parentAssistantIds, config);
    } catch (_e) {
      return {
        messages: [],
        documentId: header.id,
        warning: `Parent session not found: ${header.parentSession}`,
      };
    }
  }

  // Not a fork - include all conversation messages
  const messages = buildMessageArray(entries, config);
  return {
    messages,
    documentId: header.id,
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
): { messages: object[]; documentId: string; warning?: string } {
  const conversationEntries = entries.filter((e) =>
    isConversationMessage(e, config.retainContent, config.toolFilter)
  );

  // Find first assistant with id NOT in parent
  const forkPoint = findForkPoint(conversationEntries, parentAssistantIds);

  if (forkPoint === -1) {
    return { messages: [], documentId: header.id, warning: "No new content in fork" };
  }

  // Walk backward in conversationEntries to find the previous user message
  const startIndex = findForkStartIndex(conversationEntries, forkPoint);
  const messages = conversationEntries.slice(startIndex).map((e) => formatEntry(e, config));

  return {
    messages,
    documentId: header.id,
  };
}

/**
 * Build tags for a document.
 */
export function buildDocumentTags(
  header: SessionHeader,
  config: HindsightConfig,
  options?: { storeMethod?: "auto" | "tool"; sessionTags?: string[]; parentSessionId?: string }
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
  } else {
    tags.push(`parent:${header.id}`);
  }

  // Add session metadata tags
  if (options?.sessionTags) {
    tags.push(...options.sessionTags);
  }

  return tags;
}

/**
 * Get context string for Hindsight.
 * Prefers session name if provided, otherwise falls back to first user message.
 */
export function getHindsightContext(
  sessionPath: string,
  config: HindsightConfig,
  sessionName?: string
): string {
  // Prefer session name if provided
  if (sessionName) {
    return truncate(config.hindsightContextPrefix + sessionName, config.hindsightContextMaxLength);
  }

  // Fall back to first user message
  const { entries } = parseSessionFile(sessionPath);
  return truncateSessionTitle(entries, config);
}

/**
 * Get context string from pre-parsed session entries.
 * Prefers session name if provided, otherwise falls back to first user message.
 */
export function getHindsightContextFromEntries(
  entries: SessionEntry[],
  config: HindsightConfig,
  sessionName?: string
): string {
  // Prefer session name if provided
  if (sessionName) {
    return truncate(config.hindsightContextPrefix + sessionName, config.hindsightContextMaxLength);
  }

  return truncateSessionTitle(entries, config);
}
