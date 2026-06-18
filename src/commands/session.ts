/**
 * Session parsing and upsert subcommands.
 */

import type { ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import { parseSessionFile } from "../document";
import { buildMetaFile, writeMetaFile } from "../meta";
import {
  ensureParsedSessionDir,
  getMessagesPath,
  getMetaPath,
  parseCurrentSession,
  writeMessagesJsonl,
} from "../parsed-store";
import {
  getPendingSessionIds,
  hasPendingFlag,
  recoverAllStaleInflightClaims,
  toolQueueExists,
} from "../queue";
import { flushCurrentSession, flushToolQueue, parseAndUpsertSession } from "../retention";
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
 * Cheap per-session prefix for tool-queue-only sessions (no pending marker).
 * Avoids parsing the session JSONL just to derive a name: uses the explicit
 * `SessionInfo.name` already collected by `SessionManager.listAll()` when it's
 * a non-empty string, otherwise falls back to just the session id.
 */
function formatSessionPrefixOptional(sessionId: string, name: string | undefined): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed ? `[${sessionId} - ${trimmed}]` : `[${sessionId}]`;
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
  const sessionInfo = sessionMap.get(sessionId);
  // Derive the per-session prefix. Only pending-marker sessions need the full
  // display-name derivation (`resolveSessionDisplayName` parses the session
  // JSONL to find the latest `session_info` name / first user message). Tool-
  // queue-only sessions have no pending marker, so avoid that parse and derive
  // a cheap prefix from `SessionInfo.name` (already collected by
  // `SessionManager.listAll()`) when it's a non-empty string, else use just the
  // session id. The prefix still scopes tool-queue notifications to the session.
  const hasPending = hasPendingFlag(sessionId);
  const prefix = hasPending
    ? formatSessionPrefix(sessionId, resolveSessionDisplayName(sessionInfo, config))
    : formatSessionPrefixOptional(sessionId, sessionInfo?.name);
  const prefixedCtx = withSessionNotifyPrefix(ctx, prefix);

  // Auto-flush-style notification suppression (e.g. startup pending flush):
  // block/not-retained warnings and success/no-work are suppressed unless debug.
  // Manual flushes (command) and `quit` (autoFlush=false) surface them.
  const autoFlush = options?.autoFlush ?? false;
  const notifySuccess = !autoFlush || config.debug;

  // Re-parse and upsert if this session has a pending marker
  if (hasPending) {
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

      // Write parsed artifact files to disk for review
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
