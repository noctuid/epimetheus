/**
 * Session parsing and upsert subcommands.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import { buildContextFromSessionName, buildDocumentTags, parseSessionFile } from "../document";
import { buildMetaFile, readMetaFileByPath, writeMetaFile } from "../meta";
import {
  buildContentFromJsonl,
  cacheExists,
  ensureParsedSessionDir,
  getMessagesPath,
  getMetaPath,
  getParsedSessionDir,
  parseCurrentSession,
  writeMessagesJsonl,
} from "../parsed-store";
import {
  getPendingSessionIds,
  hasPendingFlag,
  recoverAllStaleInflightClaims,
  toolQueueExists,
} from "../queue";
import {
  flushCurrentSession,
  flushToolQueue,
  parseAndUpsertSession,
  upsertToHindsight,
} from "../retention";
import { getContextNameMaxLength, getSessionNameFromEntries } from "../utils";
import type { Subcommand } from "./types";

// ============================================
// Private helpers for flush-pending
// ============================================

/**
 * Build a one-line per-session notification prefix for `/hindsight flush-pending`.
 *
 * Format: `[<sessionId> - <sessionName>]`. The name is derived the same way as
 * everywhere else (explicit `session_info` name, otherwise first user message,
 * only `Untitled` if neither exists) — see `resolveSessionDisplayName`.
 * Per-session outcomes from `parseAndUpsertSession` / `flushToolQueue` are
 * emitted on the following line(s) after this prefix.
 */
function formatSessionPrefix(sessionId: string, sessionName: string): string {
  return `[${sessionId} - ${sessionName}]`;
}

/**
 * Return an {@link ExtensionContext} whose `ui.notify` calls are prefixed with
 * a per-session header line, used to scope `/hindsight flush-pending`
 * per-session notifications. All other `ui` members (and all other `ctx`
 * members) pass through unchanged, so out-of-scope notifications
 * (aggregate messages from the flush-pending handler) are unaffected.
 *
 * Uses a Proxy rather than cloning so prototype-backed members/methods on the
 * real ExtensionContext are preserved.
 */
function withSessionNotifyPrefix(ctx: ExtensionContext, prefix: string): ExtensionContext {
  const prefixedUi = new Proxy(ctx.ui as object, {
    get(target, prop, receiver) {
      if (prop === "notify") {
        // Bind to the real ui.notify; receiver (the proxy) would re-enter the trap.
        const notify = Reflect.get(target, "notify", target) as (
          message: string,
          level?: "info" | "warning" | "error"
        ) => void;
        return (message: string, level?: "info" | "warning" | "error") =>
          notify(`${prefix}\n${message}`, level);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(ctx as object, {
    get(target, prop, receiver) {
      if (prop === "ui") {
        return prefixedUi;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as ExtensionContext;
}

/**
 * Build a map of session IDs to SessionInfo by listing all sessions.
 * Throws on failure — callers should handle and notify.
 */
async function buildSessionMap(): Promise<Map<string, SessionInfo>> {
  const allSessions = await SessionManager.listAll();
  return new Map(allSessions.map((s) => [s.id, s]));
}

/**
 * Derive the per-session display name for `/hindsight flush-pending` prefixes
 * using the same name derivation as every other flush path (so the prefix
 * matches the name Hindsight itself records).
 *
 * Resolution order:
 * 1. If the session file is resolvable, parse it and derive the name via
 *    `getSessionNameFromEntries` (explicit `session_info` name → first user
 *    message → `Untitled`). This is the canonical derivation, consistent with
 *    `resolveParsedSessionMetadata`.
 * 2. If parsing fails (or there is no file), fall back to the cheap
 *    `SessionInfo.name` recorded by `SessionManager.listAll()` (which is only
 *    the explicit `session_info` name, not the first-user-message fallback).
 * 3. If neither yields a name, `getSessionNameFromEntries`/`SessionInfo.name`
 *    already returns `Untitled`/undefined respectively; `Untitled` is used.
 */
function resolveSessionDisplayName(
  sessionInfo: SessionInfo | undefined,
  config: HindsightConfig
): string {
  if (sessionInfo?.path) {
    try {
      const { entries } = parseSessionFile(sessionInfo.path);
      return getSessionNameFromEntries(entries, getContextNameMaxLength(config));
    } catch {
      // Fall through to SessionInfo.name below if the file is unreadable/invalid.
    }
  }
  const name = typeof sessionInfo?.name === "string" ? sessionInfo.name.trim() : "";
  return name ? name : "Untitled";
}

/**
 * Flush a single pending session: re-parse and upsert if it has a pending marker,
 * then flush any tool queue entries.
 *
 * Per-session notifications (from `parseAndUpsertSession`, `flushToolQueue`, and
 * the missing-session error below) are prefixed with a `[<id> - <name>]` header
 * so the user can tell which session each outcome belongs to. Aggregate
 * flush-pending messages are emitted on the un-wrapped ctx elsewhere.
 */
async function flushPendingSession(
  sessionId: string,
  sessionMap: Map<string, SessionInfo>,
  config: HindsightConfig,
  client: HindsightClientWrapper,
  ctx: ExtensionContext,
  options?: { autoFlush?: boolean }
): Promise<void> {
  // Derive the display name the same way as the normal flush path (explicit
  // name → first user message → Untitled), so the per-session prefix matches
  // the session name Hindsight records. Falls back to SessionInfo.name (and
  // finally Untitled) only when the session file can't be parsed.
  const sessionInfo = sessionMap.get(sessionId);
  const sessionName = resolveSessionDisplayName(sessionInfo, config);
  const prefixedCtx = withSessionNotifyPrefix(ctx, formatSessionPrefix(sessionId, sessionName));

  // Auto-flush-style notification suppression (e.g. startup pending flush):
  // block/not-retained warnings and success/no-work are suppressed unless debug.
  // Manual flushes (command) and `quit` (autoFlush=false) surface them.
  const autoFlush = options?.autoFlush ?? false;
  const notifySuccess = !autoFlush || config.debug;

  // Re-parse and upsert if this session has a pending marker
  if (hasPendingFlag(sessionId)) {
    if (!sessionInfo) {
      prefixedCtx.ui.notify("session file not found", "error");
    } else {
      await parseAndUpsertSession(
        sessionInfo.path,
        sessionId,
        config,
        client,
        prefixedCtx,
        ctx.signal,
        { requirePending: true, autoFlush, notifySuccess }
      );
    }
  }

  // Tool queue flushing is independent of session ingestion.
  if (toolQueueExists(sessionId)) {
    await flushToolQueue(sessionId, client, prefixedCtx, ctx.signal, { notifySuccess });
  }
}

// ============================================
// Private helpers for upsert-all-parsed
// ============================================

/** Outcome of upserting a single parsed session. */
type UpsertOutcome = "success" | "skipped" | "failed";

/**
 * List all .meta.json files in the parsed sessions directory.
 * Returns full paths.
 */
function listParsedMetaFiles(parsedDir: string): string[] {
  return readdirSync(parsedDir)
    .filter((f) => f.endsWith(".meta.json"))
    .map((f) => join(parsedDir, f));
}

/**
 * Upsert a single parsed session from its .meta.json file.
 *
 * Returns a structured outcome:
 * - "success": upserted successfully
 * - "skipped": skipped because retention is explicitly disabled (no error)
 * - "failed": failed with an error message (appended to errors array)
 */
async function upsertParsedSession(
  metaPath: string,
  config: HindsightConfig,
  client: HindsightClientWrapper,
  ctx: ExtensionContext,
  errors: string[]
): Promise<UpsertOutcome> {
  const sessionId = basename(metaPath, ".meta.json");

  try {
    const meta = readMetaFileByPath(metaPath);
    if (!meta) {
      throw new Error("Invalid or malformed .meta.json");
    }
    if (meta.sessionId !== sessionId) {
      throw new Error(
        `Meta session id mismatch: file name ${sessionId} does not match stored ${meta.sessionId}`
      );
    }
    // Skip sessions whose metadata explicitly indicates retention is disabled.
    if (meta.retained === false) {
      return "skipped";
    }
    // Flush guard: check before any other validation so blocked sessions
    // report the right reason (not a misleading cache error)
    if (config.requireExtraContextBeforeFlush && meta.extraContext === null) {
      errors.push(`${sessionId}: flush blocked (extra context not set)`);
      return "failed";
    }
    if (!cacheExists(sessionId)) {
      throw new Error("Messages cache file not found");
    }
    // Build content from messages JSONL (no JSON.parse of message objects)
    const content = buildContentFromJsonl(sessionId);
    // Rebuild full document tags from cached user tags + current config
    // so structural tags (constantTags, session, cwd, etc.) reflect latest config.
    // Use sessionId (from filename) for the synthetic header so structural tag
    // `session:<id>` matches the session ID and observation-scope expansion.
    // The Hindsight document id is derived from the stored session id at upsert time.
    const tags = buildDocumentTags(
      {
        type: "session",
        id: sessionId,
        timestamp: meta.sessionTimestamp,
        cwd: meta.sessionCwd,
      },
      config,
      {
        sessionUserTags: meta.sessionUserTags,
        parentSessionId: meta.parentSessionId,
      }
    );
    await upsertToHindsight(
      client,
      {
        content,
        documentId: meta.sessionId,
        context: buildContextFromSessionName(
          config.hindsightContextPrefix,
          meta.sessionName,
          meta.extraContext ?? undefined
        ),
        timestamp: meta.sessionTimestamp,
        tags,
        sessionId,
        parentSessionId: meta.parentSessionId,
        sessionCwd: meta.sessionCwd ?? "",
      },
      config,
      ctx.signal
    );
    return "success";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push(`${sessionId}: ${message}`);
    return "failed";
  }
}

// ============================================
// Subcommand factories
// ============================================

/**
 * Create the flush subcommand — drain pending messages and tool entries for the current
 * session to Hindsight.
 *
 * Parses the session file and upserts with updateMode=replace if the session
 * has pending changes (via pending marker); does nothing if nothing has changed since the
 * last flush. Also flushes any pending tool queue entries.
 */
export function createFlushSubcommand(
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Drain pending messages and tool entries for the current session to Hindsight",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionId || !sessionPath) {
        ctx.ui.notify("No active session", "error");
        return;
      }

      await flushCurrentSession(sessionId, sessionPath, config, client, ctx, ctx.signal, {
        notifyNoWork: true,
      });
    },
  };
}

/**
 * Run the core flush-pending flow for all sessions with pending markers or tool
 * queues. Reused by the `/hindsight flush-pending` command and by the
 * `autoFlushPendingOn` lifecycle flushes (`quit`, `startup`).
 *
 * Options:
 * - `confirm`: when true, prompt the user before flushing (command use). When
 *   false (lifecycle use), proceed without prompting.
 * - `notifyNoWork`: when true (and not `autoFlush`), emit a "No pending changes" info
 *   when there is nothing to flush (command use). Under `autoFlush`, no-work is only
 *   shown when `debug: true` (diagnostic consistency with auto-flushes).
 * - `ctxWrapper`: optional wrapper applied to `ctx` before flushing, used to
 *   mirror warning/error notifications to the console for `/quit` (the TUI is
 *   already gone by shutdown).
 * - `autoFlush`: when true, run in auto-flush mode (used by `startup`). Suppresses
 *   the aggregate "Flushing N session(s)..." info, per-session block/not-retained
 *   warnings, and per-session success/no-work notifications unless `debug: true`.
 *   Errors still surface. Manual (`/hindsight flush-pending`) and `quit` use the
 *   default (`autoFlush: false`) and surface warnings/success.
 */
export async function flushAllPending(
  config: HindsightConfig,
  client: HindsightClientWrapper,
  ctx: ExtensionContext,
  options?: {
    confirm?: boolean;
    notifyNoWork?: boolean;
    ctxWrapper?: (ctx: ExtensionContext) => ExtensionContext;
    autoFlush?: boolean;
  }
): Promise<void> {
  const flushCtx = options?.ctxWrapper ? options.ctxWrapper(ctx) : ctx;
  const confirm = options?.confirm ?? false;
  const notifyNoWork = options?.notifyNoWork ?? false;
  const autoFlush = options?.autoFlush ?? false;
  const debug = config.debug;

  try {
    recoverAllStaleInflightClaims();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    flushCtx.ui.notify(`In-flight recovery failed: ${msg}`, "error");
  }

  // getPendingSessionIds is lock-free / best-effort: a session may disappear or be
  // flushed concurrently. Per-session flush steps safely handle empty/no-work cases.
  const allSessionIds = getPendingSessionIds();
  if (allSessionIds.length === 0) {
    // Manual: show when notifyNoWork. Auto-flush (startup): show only in debug.
    if ((!autoFlush && notifyNoWork) || (autoFlush && debug)) {
      flushCtx.ui.notify("No pending changes", "info");
    }
    return;
  }

  // Count sessions with pending markers and tool queues for accurate messaging.
  const sessionsWithPending = allSessionIds.filter((id) => hasPendingFlag(id));
  const sessionsWithToolQueue = allSessionIds.filter((id) => toolQueueExists(id));

  const parts: string[] = [];
  if (sessionsWithPending.length > 0) {
    parts.push(`${sessionsWithPending.length} session(s) to re-parse and upsert`);
  }
  if (sessionsWithToolQueue.length > 0) {
    parts.push(`${sessionsWithToolQueue.length} tool queue(s) to flush`);
  }
  const description = parts.join(" + ");

  if (confirm) {
    const answer = await ctx.ui.confirm(
      "Flush pending sessions?",
      `This will flush ${description}. Continue?`
    );
    if (!answer) {
      ctx.ui.notify("Flush cancelled", "info");
      return;
    }
  }

  // Build session map via SessionManager.listAll(). This is expected to be reliable
  // in normal pi operation, and pending session upserts require it to resolve IDs
  // to session files; abort the flush if session discovery itself fails.
  let sessionMap: Map<string, SessionInfo>;
  try {
    sessionMap = await buildSessionMap();
  } catch (e) {
    flushCtx.ui.notify(
      `Failed to list sessions: ${e instanceof Error ? e.message : String(e)}`,
      "error"
    );
    return;
  }

  // Aggregate "Flushing N..." info: shown for manual/quit, suppressed for auto-flush
  // (startup) unless debug.
  if (!autoFlush || debug) {
    flushCtx.ui.notify(`Flushing ${allSessionIds.length} session(s)...`, "info");
  }

  for (const sessionId of allSessionIds) {
    await flushPendingSession(sessionId, sessionMap, config, client, flushCtx, { autoFlush });
  }
}

/**
 * Create the flush-pending subcommand — flush all sessions with pending changes.
 *
 * Iterates sessions that have pending markers or tool queues, re-parses their
 * session files, upserts with replace mode, and flushes any tool queue entries.
 * Sessions with both pending markers and tool queues get both operations.
 * Tool-only sessions (no pending markers) are included.
 */
export function createFlushPendingSubcommand(
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Drain pending messages and tool entries for all sessions to Hindsight",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }

      await flushAllPending(config, client, ctx, { confirm: true, notifyNoWork: true });
    },
  };
}

/**
 * Create the parse-session subcommand — parses the current session to file for review.
 *
 * Uses {@link parseCurrentSession} to build the parsed output and write it to disk,
 * without sending anything to Hindsight.
 */
export function createParseSessionSubcommand(config: HindsightConfig): Subcommand {
  return {
    description: "Parse current session to file for manual review",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionPath) {
        ctx.ui.notify("No session file found", "error");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) {
        ctx.ui.notify("No session ID available", "error");
        return;
      }

      const result = parseCurrentSession(sessionPath, sessionId, config, ctx);

      if (!result) {
        return;
      }

      // Write cache files to disk for review
      ensureParsedSessionDir();
      writeMessagesJsonl(result.sessionId, result.formattedMessageStrs);
      writeMetaFile(result.sessionId, buildMetaFile(result));
      ctx.ui.notify(
        `Parsed session saved to:\n  Messages: ${getMessagesPath(result.sessionId)}\n  Meta: ${getMetaPath(result.sessionId)}`,
        "info"
      );
    },
  };
}

/**
 * Create the parse-and-upsert-session subcommand — parse and upsert the full session.
 *
 * Delegates to {@link parseAndUpsertSession} which handles parsing, pending marker clearing,
 * and retention in one step.
 */
export function createParseAndUpsertSessionSubcommand(
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description:
      "Parse and upsert the full current session to Hindsight (forced, bypasses pending markers)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionId || !sessionPath) {
        ctx.ui.notify("No session file found", "error");
        return;
      }

      await parseAndUpsertSession(sessionPath, sessionId, config, client, ctx, ctx.signal, {
        requirePending: false,
      });
    },
  };
}

/**
 * Create the upsert-all-parsed subcommand — upsert all previously parsed sessions.
 *
 * Reads all `.meta.json` files from the parsed-sessions directory and upserts them
 * to Hindsight, including configured entities.
 */
export function createUpsertAllParsedSubcommand(
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Upsert all parsed sessions to Hindsight",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }

      const parsedDir = getParsedSessionDir();
      if (!existsSync(parsedDir)) {
        ctx.ui.notify("No parsed sessions found", "error");
        return;
      }

      const metaFilePaths = listParsedMetaFiles(parsedDir);
      if (metaFilePaths.length === 0) {
        ctx.ui.notify("No parsed sessions found", "error");
        return;
      }

      const answer = await ctx.ui.confirm(
        "Upsert all parsed sessions?",
        `This will upsert ${metaFilePaths.length} session(s) to Hindsight, which can take a long time and make many API requests. Continue?`
      );
      if (!answer) {
        ctx.ui.notify("Upsert cancelled", "info");
        return;
      }

      ctx.ui.notify(`Upserting ${metaFilePaths.length} parsed sessions...`, "info");

      let successCount = 0;
      let failCount = 0;
      const errors: string[] = [];

      for (const metaPath of metaFilePaths) {
        if (ctx.signal?.aborted) {
          ctx.ui.notify(`Upsert cancelled after ${successCount} session(s)`, "warning");
          return;
        }
        const outcome = await upsertParsedSession(metaPath, config, client, ctx, errors);
        if (outcome === "success") {
          successCount++;
        } else if (outcome === "failed") {
          failCount++;
        }
        // "skipped" is not counted as success or failure
      }

      if (failCount === 0) {
        ctx.ui.notify(`Successfully upserted ${successCount} sessions`, "info");
      } else {
        const sampleErrors = errors.slice(0, 3).join("; ");
        const suffix = errors.length > 3 ? `; and ${errors.length - 3} more` : "";
        ctx.ui.notify(
          `Upserted ${successCount} sessions, ${failCount} failed (${sampleErrors}${suffix})`,
          "error"
        );
      }
    },
  };
}
