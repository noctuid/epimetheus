/**
 * Document building from pi session files.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HindsightConfig, RetainContent, ToolFilter } from "./config";
import { prepareEntry, shouldRetainMessage } from "./prepare";
import { extractTextFromContent, truncate } from "./utils";

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
 * Build document content for a forked session.
 */
function buildForkedContent(
  entries: SessionEntry[],
  header: SessionHeader,
  parentAssistantIds: Set<string>,
  config: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter">
): { content: string; documentId: string } {
  const conversationEntries = entries.filter((e) =>
    isConversationMessage(e, config.retainContent, config.toolFilter)
  );

  // Find first assistant with id NOT in parent
  const forkPoint = findForkPoint(conversationEntries, parentAssistantIds);

  if (forkPoint === -1) {
    // No new responses - nothing to retain
    return { content: "[]", documentId: `session:${header.id}` };
  }

  // Walk backward in conversationEntries to find the previous user message
  const startIndex = findForkStartIndex(conversationEntries, forkPoint);
  const content = JSON.stringify(
    conversationEntries.slice(startIndex).map((e) => formatEntry(e, config))
  );

  return {
    content,
    documentId: `session:${header.id}`,
  };
}

/**
 * Find the index of the first assistant message with an id not in parent.
 * Returns -1 if no fork point found (all assistant messages exist in parent).
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
 */
export function buildDocumentContent(
  sessionPath: string,
  config: HindsightConfig
): DocumentContent {
  const { header, entries } = parseSessionFile(sessionPath);

  // Check parentSession BEFORE filtering
  if (header.parentSession) {
    try {
      const parentAssistantIds = loadParentAssistantIds(header.parentSession);
      const result = buildForkedContent(entries, header, parentAssistantIds, config);
      return result;
    } catch (_e) {
      return {
        content: "[]",
        documentId: `session:${header.id}`,
        warning: `Parent session not found: ${header.parentSession}`,
      };
    }
  }

  // Not a fork - include all conversation messages
  const messages = buildMessageArray(entries, config);
  return {
    content: JSON.stringify(messages),
    documentId: `session:${header.id}`,
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

  // Check parentSession BEFORE filtering
  if (header.parentSession) {
    try {
      const parentAssistantIds = loadParentAssistantIds(header.parentSession);
      return buildForkedMessages(entries, header, parentAssistantIds, config);
    } catch (_e) {
      return {
        messages: [],
        documentId: `session:${header.id}`,
        warning: `Parent session not found: ${header.parentSession}`,
      };
    }
  }

  // Not a fork - include all conversation messages
  const messages = buildMessageArray(entries, config);
  return {
    messages,
    documentId: `session:${header.id}`,
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
    return { messages: [], documentId: `session:${header.id}`, warning: "No new content in fork" };
  }

  // Walk backward in conversationEntries to find the previous user message
  const startIndex = findForkStartIndex(conversationEntries, forkPoint);
  const messages = conversationEntries.slice(startIndex).map((e) => formatEntry(e, config));

  return {
    messages,
    documentId: `session:${header.id}`,
  };
}

/**
 * Build tags for a document.
 */
export function buildDocumentTags(
  header: SessionHeader,
  config: HindsightConfig,
  options?: { storeMethod?: "auto" | "tool"; sessionTags?: string[] }
): string[] {
  const tags = [
    ...config.constantTags,
    `session:${header.id}`,
    `cwd:${header.cwd}`,
    `store_method:${options?.storeMethod ?? "auto"}`,
  ];

  // Add parent tag - parent session ID if forked, otherwise self
  if (header.parentSession) {
    // Read parent session file to get the actual ID
    let parentId: string | undefined;
    try {
      if (existsSync(header.parentSession)) {
        const { header: parentHeader } = parseSessionFile(header.parentSession);
        parentId = parentHeader.id;
      }
    } catch {
      // Ignore errors
    }
    // Fallback: extract from path
    if (!parentId) {
      const match = header.parentSession.match(/([a-f0-9-]{36})\.jsonl$/);
      parentId = match ? match[1] : header.parentSession;
    }
    tags.push(`parent:${parentId}`);
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
