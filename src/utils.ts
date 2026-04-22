/**
 * Shared utility functions.
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Truncate a string to max character count (code points, not code units).
 * Safe for multi-byte Unicode characters like emojis.
 *
 * Note: Splits by code point, not grapheme cluster. This means characters
 * like flags (🇺🇸), family emojis (👨‍👩‍👧), or skin tone modifiers (👨🏻)
 * may be split apart. For typical session names and queries this is fine.
 */
export function truncate(str: string, maxChars: number): string {
  if (maxChars <= 0) return str;
  const chars = [...str]; // Splits by code point
  if (chars.length <= maxChars) return str;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

/**
 * Try to extract a session ID from a parent session file path.
 * Returns the UUID portion if the path matches the expected pattern,
 * or undefined if no ID can be extracted.
 */
function extractParentSessionIdFromPath(parentSessionPath: string | undefined): string | undefined {
  if (!parentSessionPath) return undefined;
  const match = parentSessionPath.match(/([a-f0-9-]{36})\.jsonl$/);
  return match ? match[1] : undefined;
}

/**
 * Extract session ID from a parent session file path.
 * The parent session header contains the actual session ID.
 * Falls back to extracting the UUID from the file path if the file
 * can't be read or doesn't contain a valid session header.
 * Returns undefined if no ID can be extracted.
 */
export function extractParentSessionId(parentSessionPath: string | undefined): string | undefined {
  if (!parentSessionPath || !existsSync(parentSessionPath)) {
    // File doesn't exist — try extracting ID from path as fallback
    return extractParentSessionIdFromPath(parentSessionPath);
  }

  try {
    const content = readFileSync(parentSessionPath, "utf-8");
    const firstLine = content.split("\n")[0];
    if (!firstLine) return extractParentSessionIdFromPath(parentSessionPath);

    const header = JSON.parse(firstLine) as { type?: string; id?: string };
    if (header.type === "session" && header.id) {
      return header.id;
    }
    return extractParentSessionIdFromPath(parentSessionPath);
  } catch {
    return extractParentSessionIdFromPath(parentSessionPath);
  }
}

/**
 * Extract text from message content.
 * - For string content: returns as-is
 * - For array content: joins all text blocks with newline
 * - Returns null for empty or image-only content
 */
export function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content || null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      textBlocks.push((block as { text: string }).text);
    }
  }

  return textBlocks.length > 0 ? textBlocks.join("\n") : null;
}

/**
 * Get the display name for a session.
 * Returns manual title if set, otherwise extracts text from first user message.
 * Truncates to 100 characters to avoid overly long names.
 */
export function getSessionDisplayName(
  getSessionName: () => string | undefined,
  getEntries: () => Array<{ type: string; message?: { role?: string; content?: unknown } }>
): string {
  // Try manual title first
  const name = getSessionName();
  if (name) return name;

  // Fall back to first user message
  const entries = getEntries();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "user") {
      const text = extractTextFromContent(entry.message.content);
      if (text) return truncate(text, 100);
    }
  }

  return "Untitled";
}
