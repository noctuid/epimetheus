/**
 * Structured parse results and parsed-session cache I/O.
 *
 * Two concerns:
 * 1. Cache layer — reads/writes `.messages.jsonl` and `.meta.json` files in the
 *    parsed-sessions directory. Used by flush operations and upsert-all-parsed.
 * 2. Structured parsing — `parseCurrentSession()` wraps the low-level parser
 *    from document.ts into a `ParsedSessionResult` ready for downstream
 *    flush/upsert. It is a non-upsert operation: it performs no retention or
 *    extra-context guard checks and does not write parsed-session artifacts to
 *    disk or modify live session state (that is the caller's responsibility).
 *
 * File layout:
 *   parsed-sessions/{sessionId}.messages.jsonl  ← formatted messages
 *   parsed-sessions/{sessionId}.meta.json        ← parsed artifact manifest for upsert-all-parsed
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "./config";
import {
  buildContextFromSessionName,
  buildMessageArrayFromParsedSession,
  parseSessionFile,
  type SessionEntry,
  type SessionHeader,
} from "./document";
import { getHindsightMeta, type HindsightMeta, shouldSessionBeRetained } from "./meta";
import {
  extractParentSessionId,
  getContextNameMaxLength,
  getSessionNameFromEntries,
} from "./utils";

// ============================================
// Path helpers
// ============================================

export function getParsedSessionDir(): string {
  return join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
}

/** Write a file atomically (temp file + rename) to avoid partial writes on crash. */
function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

export function getMessagesPath(sessionId: string): string {
  return join(getParsedSessionDir(), `${sessionId}.messages.jsonl`);
}

export function getMetaPath(sessionId: string): string {
  return join(getParsedSessionDir(), `${sessionId}.meta.json`);
}

export function ensureParsedSessionDir(): void {
  const dir = getParsedSessionDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================
// Messages file operations
// ============================================

/** Write messages JSONL from scratch (full atomic write on flush). */
export function writeMessagesJsonl(sessionId: string, formattedStrs: string[]): void {
  ensureParsedSessionDir();
  const content = formattedStrs.length > 0 ? `${formattedStrs.join("\n")}\n` : "";
  atomicWriteFile(getMessagesPath(sessionId), content);
}

/**
 * Read the stored messages JSONL file and return its content as a string,
 * trimmed of trailing whitespace. Used by upsert-all-parsed to re-send stored messages.
 */
export function buildContentFromJsonl(sessionId: string): string {
  return readFileSync(getMessagesPath(sessionId), "utf-8").trimEnd();
}

// ============================================
// Cache existence / cleanup
// ============================================

/** Check whether parsed session files exist for a session. */
export function cacheExists(sessionId: string): boolean {
  return existsSync(getMessagesPath(sessionId)) && existsSync(getMetaPath(sessionId));
}

// ============================================
// Parse types and helpers
// ============================================

/**
 * Resolve metadata for a parsed session:
 * - Structural identity from session header.
 * - Session name from parsed entries.
 * - Extra context from parsed entries (session file is authority after parsing).
 * - Session user tags from parsed entries (latest hindsight-meta.tags).
 * - Context built from config prefix + session name + extra context.
 *
 * Live state is NOT consulted here — after parsing, the session file is
 * the sole authority for metadata.
 */
export function resolveParsedSessionMetadata(
  header: SessionHeader,
  entries: SessionEntry[],
  hindsightMeta: HindsightMeta | null,
  config: HindsightConfig
): {
  sessionName: string;
  extraContext: string | null;
  context: string;
  sessionUserTags: string[];
  parentSessionId: string | undefined;
  sessionCwd: string;
  sessionTimestamp: string;
} {
  const sessionCwd = header.cwd;
  const sessionTimestamp = header.timestamp;
  const parentSessionId = header.parentSession
    ? extractParentSessionId(header.parentSession)
    : undefined;

  const sessionName = getSessionNameFromEntries(entries, getContextNameMaxLength(config));

  // Extra context from parsed entries — key absent => null, key present => string (possibly "")
  const extraContext =
    hindsightMeta && "extraContext" in hindsightMeta ? (hindsightMeta.extraContext ?? "") : null;

  const context = buildContextFromSessionName(
    config.hindsightContextPrefix,
    sessionName,
    extraContext ?? undefined
  );
  const sessionUserTags = hindsightMeta?.tags ?? [];

  return {
    sessionName,
    extraContext,
    context,
    sessionUserTags,
    parentSessionId,
    sessionCwd,
    sessionTimestamp,
  };
}

/** Result of parsing a session file for the parse-session subcommand. */
export interface ParsedSessionResult {
  formattedMessageStrs: string[];
  /** Parsed session name (from session_info or first user message). */
  sessionName: string;
  /** Extra context string, null if user has not set extra context. */
  extraContext: string | null;
  /** Derived Hindsight context from config prefix + session name + extra context. */
  context: string;
  /** User-provided session tags (rebuilt into full document tags during flush). */
  sessionUserTags: string[];
  sessionId: string;
  parentSessionId?: string;
  sessionCwd: string;
  /** Session creation timestamp (header.timestamp). */
  sessionTimestamp: string;
  /** Number of formatted messages. */
  messageCount: number;
  /** Current retention state. */
  retained: boolean;
}

/**
 * Parse the current session file into a structured object for retention/export.
 *
 * This is a non-upsert operation: it parses the session file for review/export
 * and does not perform retention or extra-context guard checks (those apply only
 * at upsert time). It does not modify live session state. The caller is
 * responsible for writing parsed-session artifacts to disk if desired.
 *
 * @param sessionPath - Path to the session JSONL file
 * @param sessionId - Caller/current session id, used for debug/log context and consistency. The returned {@link ParsedSessionResult.sessionId} comes from the parsed session header, not this parameter.
 * @param config - Hindsight configuration
 * @param ctx - Extension context for UI notifications
 */
export function parseCurrentSession(
  sessionPath: string,
  sessionId: string,
  config: HindsightConfig,
  ctx: ExtensionContext
): ParsedSessionResult | null {
  if (!existsSync(sessionPath)) {
    ctx.ui.notify("No session file found", "error");
    return null;
  }

  // No guard checks here — parse-session is a non-upsert operation.
  // Retention and extra-context guards only apply at upsert time.

  const debug = config.debug;
  const t0 = debug ? performance.now() : 0;

  try {
    // Parse the session file — session file is the authority after parsing.
    const { header, entries } = parseSessionFile(sessionPath);
    const hindsightMeta = getHindsightMeta(entries);

    // Compute retention state for the result, but don't block on it.
    const isRetained = shouldSessionBeRetained(entries, config);

    const {
      messages,
      sessionId: parsedSessionId,
      warning,
    } = buildMessageArrayFromParsedSession(header, entries, config);

    if (messages.length === 0) {
      if (warning) {
        ctx.ui.notify(warning, "warning");
      } else {
        ctx.ui.notify("No messages to parse", "info");
      }
      return null;
    }

    // Pre-serialize individual messages (avoids double-stringify)
    const formattedMessageStrs = messages.map((m) => JSON.stringify(m));

    // Resolve metadata from parsed session entries (session file is authority after parsing)
    const {
      sessionName,
      extraContext,
      context,
      sessionUserTags,
      parentSessionId,
      sessionCwd,
      sessionTimestamp,
    } = resolveParsedSessionMetadata(header, entries, hindsightMeta, config);

    const result: ParsedSessionResult = {
      formattedMessageStrs,
      sessionName,
      extraContext,
      context,
      sessionUserTags,
      sessionId: parsedSessionId,
      parentSessionId,
      sessionCwd,
      sessionTimestamp,
      messageCount: formattedMessageStrs.length,
      retained: isRetained,
    };

    if (debug) {
      const elapsed = performance.now() - t0;
      console.log(
        `pi-hindsight debug: parseCurrentSession(${sessionId}) took ${elapsed.toFixed(2)}ms, ${result.messageCount} messages`
      );
    }

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.notify(msg, "error");
    return null;
  }
}
