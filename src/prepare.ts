/**
 * Shared preparation utilities for message content.
 * Used by both queue system (v2) and session parsing (v1 legacy).
 */

import type { HindsightConfig, RetainContent } from "./config";

/**
 * Check if a message should be retained based on config.
 */
export function shouldRetainMessage(
  message: Record<string, unknown>,
  retainContent: RetainContent,
): boolean {
  const role = message.role as string;
  if (role === "user" || role === "assistant") {
    return true;
  }
  if (role === "toolResult") {
    return retainContent.toolResult.length > 0;
  }
  return false;
}

/**
 * Filter content array based on allowed types for the role.
 * Unknown roles return empty array (should not be retained).
 */
export function filterContent(
  content: unknown,
  role: string,
  retainContent: RetainContent,
): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  const allowedTypes = retainContent[role as keyof RetainContent];
  if (!allowedTypes) {
    // Unknown role - return empty array (message should not be retained)
    return [];
  }

  // Cast to string array for comparison
  const allowed = allowedTypes as readonly string[];

  return content.filter((block) => {
    if (!block || typeof block !== "object") return false;
    const blockType = (block as { type?: string }).type;
    return blockType !== undefined && allowed.includes(blockType);
  });
}

/**
 * Strip specified fields from an object (mutates in place).
 * Only strips if the field exists.
 */
function stripFields<T extends Record<string, unknown>>(
  obj: T,
  fields: string[],
): void {
  for (const field of fields) {
    if (field in obj) {
      delete obj[field as keyof T];
    }
  }
}

/**
 * Prepare an entry for retention.
 *
 * Processing order:
 * 1. Clone entry with deep copy of message to avoid mutating original
 * 2. Filter content blocks by retainContent[role]
 * 3. Strip fields from message by strip.message
 * 4. Strip fields from top level by strip.topLevel
 */
export function prepareEntry(
  entry: Record<string, unknown>,
  config: Pick<HindsightConfig, "retainContent" | "strip">,
): Record<string, unknown> {
  // Clone entry with deep copy of message to avoid mutating original
  const message = entry.message;
  const stripped: Record<string, unknown> = {
    ...entry,
    message: message && typeof message === "object" && !Array.isArray(message)
      ? { ...message as Record<string, unknown> }
      : message,
  };

  // Get message object
  const strippedMessage = stripped.message;
  if (strippedMessage && typeof strippedMessage === "object" && !Array.isArray(strippedMessage)) {
    const msgObj = strippedMessage as Record<string, unknown>;
    const role = msgObj.role as string;

    // 2. Filter content blocks
    if (msgObj.content) {
      msgObj.content = filterContent(msgObj.content, role, config.retainContent);
    }

    // 3. Strip fields from message
    stripFields(msgObj, config.strip.message);
  }

  // 4. Strip fields from top level
  stripFields(stripped, config.strip.topLevel);

  return stripped;
}
