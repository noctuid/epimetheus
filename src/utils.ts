/**
 * Shared utility functions.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Convert a parser/string offset into a 1-based line/character location. */
export function offsetToLineColumn(
  content: string,
  offset: number
): { line: number; character: number } {
  let line = 1;
  let character = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") {
      line++;
      character = 1;
    } else {
      character++;
    }
  }
  return { line, character };
}

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
 * Derive the main repo name from `<cwd>/.git`'s git common dir, so worktrees
 * share the main repo name instead of each getting their worktree dir name.
 *
 * Uses `git rev-parse --git-common-dir`, then takes
 * `basename(dirname(commonDir))`:
 *   - main repo `/repo`         → commondir `/repo/.git` → `repo`
 *   - worktree `/repo/wt/foo`   → commondir `/repo/.git` → `repo` (shared)
 *
 * Returns `null` when `git` is unavailable, the commondir cannot be resolved,
 * or the derived name is empty / degenerate. Callers fall back to basename.
 *
 * Callers should guard this with `existsSync(join(cwd, ".git"))` to avoid
 * spawning git for directories that are not git repos.
 */
export function deriveGitProjectName(cwd: string): string | null {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      // Keep this snappy — git is normally a few ms. A 5s ceiling guards
      // against pathological hangs (e.g. a slow disk or interactive prompt).
      timeout: 5000,
    });
  } catch {
    return null;
  }
  if (result.error) return null;
  if (typeof result.status !== "number" || result.status !== 0) return null;
  const raw = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!raw) return null;

  const abs = isAbsolute(raw) ? raw : join(cwd, raw);
  const resolved = realpathOrSelf(abs);
  const parent = dirname(resolved);
  const name = basename(parent);
  if (!name || name === "/" || name === ".") return null;
  return name;
}

/**
 * Resolve a symlink'd path to its real target. Falls back to the input path
 * when realpath fails (e.g., the path was already removed between the
 * `existsSync` check and the realpath call).
 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Derive the default project name for a cwd and report its source, WITHOUT
 * caching. If `<cwd>/.git` exists and {@link deriveGitProjectName} returns a
 * name, returns `{ name, source: "git" }` (so a main repo and its worktrees
 * share the main repo name); otherwise returns `{ name: basename(cwd),
 * source: "basename" }`.
 *
 * This is the uncached primitive underneath {@link getProjectName}. The flush
 * path calls this directly (via `flush-config.ts`'s `defaultProjectName`) rather
 * than {@link getProjectName}, because `flush-pending` resolves many session
 * cwds per run and must NOT go through the active-session-oriented single-slot
 * cache.
 */
export function deriveDefaultProjectName(cwd: string): {
  name: string;
  source: "git" | "basename";
} {
  if (existsSync(join(cwd, ".git"))) {
    const gitName = deriveGitProjectName(cwd);
    if (gitName !== null) return { name: gitName, source: "git" };
    // fall through to basename on any git failure
  }
  return { name: basename(cwd), source: "basename" };
}

/**
 * Single-slot cache for the default project name, keyed by cwd. The active
 * session's cwd is stable within a session, so the (potentially slow) git
 * derivation runs at most once per cwd instead of on every turn (auto-recall
 * builds `{project}` placeholder params on every `before_agent_start`).
 * Cleared by {@link clearProjectNameCache} (tests / module reset).
 *
 * Only the *active* session's name is cached here — batch flushers that resolve
 * many cwds (flush-pending) should call {@link deriveDefaultProjectName} directly.
 */
let projectNameCache: { cwd: string; name: string } | null = null;

/** Clear the project-name cache. Exported for tests/reset via `_resetState()`. */
export function clearProjectNameCache(): void {
  projectNameCache = null;
}

/**
 * Get the default project name for a cwd: git common dir (so worktrees share
 * the main repo name) → basename. Cached per cwd (single-slot, active-session
 * oriented).
 *
 * This is the default derivation shared by the flush path (via
 * {@link ./flush-config.ts resolveProjectNameForFlush}'s detached/unmarked case)
 * and the auto-recall `{project}` placeholder. Project-local flush config can
 * override the project name for flush/tool-retain tagging. Env-var overrides
 * (`EPIMETHEUS_PROJECT_NAME` / legacy `PI_HINDSIGHT_PROJECT_NAME`) were removed
 * because env vars do not track Pi session switching.
 *
 * Callers resolving many cwds per run (e.g. flush-pending) should call
 * {@link deriveDefaultProjectName} directly to bypass the active-session cache.
 */
export function getProjectName(cwd: string): string {
  if (projectNameCache?.cwd === cwd) return projectNameCache.name;
  const name = deriveDefaultProjectName(cwd).name;
  projectNameCache = { cwd, name };
  return name;
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
  // Walk in reverse to find the latest session_info entry (same as SessionManager).
  // Session files are unvalidated JSON, so `name` may be a non-string (number, object,
  // boolean); guard `typeof` before `.trim()` since optional chaining only guards
  // null/undefined. A non-string name is skipped (treated like an absent name);
  // an empty string name explicitly clears the title (break -> first-user fallback).
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "session_info" && typeof entry.name === "string") {
      const name = entry.name.trim();
      if (name) return name;
      // Empty name explicitly clears the title — stop looking for session_info
      break;
    }
  }
  // Fall back to first user message
  return deriveSessionName(undefined, entries, maxLength);
}
