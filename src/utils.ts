/**
 * Shared utility functions.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

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
 * Get the base directory name from a cwd path.
 * E.g. "/home/user/projects/myapp" → "myapp"
 */
export function getBasedir(cwd: string): string {
  return basename(cwd);
}

/**
 * Get the project name, falling back to basedir if not set via env var.
 * Uses PI_HINDSIGHT_PROJECT_NAME environment variable if set,
 * otherwise derives from the cwd basename.
 */
export function getProjectName(cwd: string): string {
  return process.env.PI_HINDSIGHT_PROJECT_NAME || basename(cwd);
}

/**
 * Derive the session display name from an explicit name or first user message.
 *
 * Returns the explicit name if set, otherwise extracts the first user message
 * and truncates it to `maxLength`. Returns "Untitled" if neither is available.
 *
 * This is the single source of truth for session name derivation + truncation.
 * Both the runtime flush path and the parsing path should use this function
 * to ensure consistent context strings.
 */
export function deriveSessionName(
  explicitName: string | undefined,
  entries: Array<{ type: string; message?: { role?: string; content?: unknown } }>,
  maxLength: number = 100
): string {
  // Try manual title first
  if (explicitName) return explicitName;

  // Fall back to first user message
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "user") {
      const text = extractTextFromContent(entry.message.content);
      if (text) return truncate(text, maxLength);
    }
  }

  return "Untitled";
}

/**
 * Max length available for the session-name portion of the context string.
 *
 * This is `hindsightContextMaxLength - hindsightContextPrefix.length`, so that the
 * total `prefix + name` fits within `hindsightContextMaxLength`.
 * Guards against prefix longer than the configured max (returns 0 in that case).
 */
export function getContextNameMaxLength(config: {
  hindsightContextMaxLength: number;
  hindsightContextPrefix: string;
}): number {
  return Math.max(0, config.hindsightContextMaxLength - config.hindsightContextPrefix.length);
}

/**
 * Get the session name from parsed entries, without a SessionManager.
 *
 * Mirrors SessionManager.getSessionName(): scans entries in reverse for
 * the latest `session_info` entry with a name field. Falls back to
 * {@link deriveSessionName}'s first-user-message logic.
 *
 * Use this when you already have parsed entries (e.g. from `parseSessionFile`)
 * to avoid a redundant session file read through SessionManager.
 */
export function getSessionNameFromEntries(
  entries: Array<{ type: string; name?: string; message?: { role?: string; content?: unknown } }>,
  maxLength: number = 100
): string {
  // Walk in reverse to find the latest session_info entry (same as SessionManager)
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "session_info") {
      const name = entry.name?.trim();
      if (name) return name;
      // Empty name explicitly clears the title — stop looking for session_info
      break;
    }
  }
  // Fall back to first user message
  return deriveSessionName(undefined, entries, maxLength);
}
