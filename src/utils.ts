/**
 * Shared utility functions.
 */

import { readFileSync, existsSync } from "node:fs";

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
  if (maxChars < 1) return chars.slice(0, maxChars).join("");
  return chars.slice(0, maxChars - 1).join("") + "…";
}

/**
 * Extract session ID from a parent session file path.
 * The parent session header contains the actual session ID.
 * Returns undefined if the file can't be read or parsed.
 */
export function extractParentSessionId(parentSessionPath: string | undefined): string | undefined {
  if (!parentSessionPath || !existsSync(parentSessionPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(parentSessionPath, "utf-8");
    const firstLine = content.split("\n")[0];
    if (!firstLine) return undefined;

    const header = JSON.parse(firstLine) as { type?: string; id?: string };
    if (header.type === "session" && header.id) {
      return header.id;
    }
    return undefined;
  } catch {
    return undefined;
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
  getEntries: () => Array<{ type: string; message?: { role?: string; content?: unknown } }>,
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
