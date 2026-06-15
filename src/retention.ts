/**
 * Retention handling for pi message events.
 *
 * Handles flushing both tool-queue entries and full session upserts to Hindsight.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import type { HindsightClientWrapper } from "./client";
import type { HindsightConfig } from "./config";
import { expandSessionObservationScopes } from "./config";
import {
  buildDocumentTags,
  buildMessageArrayFromParsedSession,
  parseSessionFile,
  type SessionEntry,
  type SessionHeader,
} from "./document";
import {
  buildMetaFile,
  FLUSH_BLOCKED_NO_EXTRA_CONTEXT,
  getHindsightMeta,
  type HindsightMeta,
  isExtraContextSet,
  type MetaFile,
  shouldSessionBeRetained,
  writeMetaFile,
} from "./meta";
import { resolveParsedSessionMetadata, writeMessagesJsonl } from "./parsed-store";
import type { ClaimReadError, QueueClaim, QueueResult, ToolQueueEntry } from "./queue";
import {
  claimPendingFlag,
  claimToolQueue,
  completeClaim,
  enqueueToolMessage,
  getToolQueueEntryCount,
  hasPendingFlag,
  readClaimedToolEntries,
  recoverStaleInflightClaims,
  restoreClaim,
} from "./queue";
import { readSessionState, type SessionStateFile, writeSessionState } from "./session-state";
import { getBasedir, getProjectName } from "./utils";

/**
 * Queue a tool retain entry with complete tags.
 * Tags are built at queue time to capture the session context when retained.
 * Observation scopes are captured from config at queue time
 * (not settable by the LLM - re-evaluate if want it to be manually settable).
 * Returns structured result — callers should notify on failure.
 */
export async function queueToolRetain(
  sessionId: string,
  content: string,
  toolTags: string[] | undefined,
  metadata: Record<string, string> | undefined,
  sessionCwd: string,
  parentSessionId: string | undefined,
  config: Pick<HindsightConfig, "constantTags" | "observationScopes">,
  sessionUserTags: string[]
): Promise<QueueResult> {
  const projectName = getProjectName(sessionCwd);
  // Build complete tags at queue time
  const tags = [
    ...config.constantTags,
    `session:${sessionId}`,
    `cwd:${sessionCwd}`,
    `basedir:${getBasedir(sessionCwd)}`,
    `project:${projectName}`,
    `store_method:tool`,
    `parent:${parentSessionId ?? sessionId}`,
    ...(toolTags ?? []),
    ...sessionUserTags,
  ];

  // Expand placeholders in observation scopes at queue time
  const expandedScopes = expandSessionObservationScopes(
    config,
    sessionId,
    parentSessionId,
    sessionCwd,
    projectName
  );

  const entry: ToolQueueEntry = {
    content,
    tags,
    metadata,
    timestamp: new Date().toISOString(),
    store_method: "tool",
    sessionId,
    parentSessionId,
    sessionCwd,
    document_id: `tool:${sessionId}:${randomUUID()}`,
    ...(expandedScopes ? { observation_scopes: expandedScopes } : {}),
  };

  return enqueueToolMessage(sessionId, entry);
}

/**
 * Convert a tool queue entry (disk/recovery format) to a Hindsight memory input
 * for the retainBatch API.
 */
function toolQueueEntryToMemoryItem(entry: ToolQueueEntry): MemoryItemInput {
  return {
    content: entry.content,
    tags: entry.tags,
    metadata: entry.metadata,
    observation_scopes: entry.observation_scopes,
    timestamp: entry.timestamp,
    update_mode: "replace",
    ...(entry.document_id ? { document_id: entry.document_id } : {}),
  };
}

/**
 * Flush tool-queue entries to Hindsight.
 *
 * The flush guard (requireExtraContextBeforeFlush) does not apply here —
 * tool retains are explicit manual observations from the `hindsight_retain` tool.
 *
 * Uses batch retain for efficiency.
 * On success, clears the queue. On failure, leaves queue intact for retry.
 */
export async function flushToolQueue(
  sessionId: string,
  client: HindsightClientWrapper,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options?: { notifySuccess?: boolean }
): Promise<{ success: boolean; error?: string; count: number }> {
  const fail = (error: unknown): { success: false; error: string; count: 0 } => {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to flush tool queue: ${msg}`, "error");
    return { success: false, error: msg, count: 0 };
  };

  let activeClaim: QueueClaim | undefined;
  let claimCompleted = false;

  try {
    recoverStaleInflightClaims(sessionId);

    const claim = claimToolQueue(sessionId);
    if (!claim) {
      return { success: true, count: 0 };
    }
    activeClaim = claim;

    const { entries, errors: readErrors } = readClaimedToolEntries(claim);
    if (readErrors.length > 0) {
      restoreClaim(claim);
      claimCompleted = true;
      const detail = readErrors
        .map((e: ClaimReadError) => {
          const name = basename(e.filePath);
          if (e.type === "missing") return `${name}: file missing from claim`;
          if (e.type === "malformed_json") return `${name}: malformed JSON (${e.error})`;
          return `${name}: invalid tool entry (${e.reason})`;
        })
        .join("; ");
      const msg = `Corrupt tool queue entries — claim restored: ${detail}`;
      ctx.ui.notify(msg, "error");
      return { success: false, error: msg, count: 0 };
    }
    if (entries.length === 0) {
      completeClaim(claim);
      claimCompleted = true;
      return { success: true, count: 0 };
    }

    const items = entries.map(toolQueueEntryToMemoryItem);
    const result = await client.retainBatch(items, signal);

    if (result.success) {
      completeClaim(claim);
      claimCompleted = true;
      if (options?.notifySuccess !== false) {
        ctx.ui.notify(`Flushed ${entries.length} tool entries`, "info");
      }
      return { success: true, count: entries.length };
    }

    restoreClaim(claim);
    return fail(result.error ?? "Unknown error");
  } catch (e) {
    if (activeClaim && !claimCompleted) {
      try {
        restoreClaim(activeClaim);
      } catch (restoreError) {
        const restoreMsg =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
        const origMsg = e instanceof Error ? e.message : String(e);
        const msg = `${origMsg} (restore also failed: ${restoreMsg})`;
        ctx.ui.notify(`Failed to flush tool queue: ${msg}`, "error");
        return { success: false, error: msg, count: 0 };
      }
    }
    return fail(e);
  }
}

/**
 * Count user-facing pending work units for a session: pending session reparse
 * counts as 1 if any pending marker exists, plus all tool entries.
 */
export function getPendingWorkCount(sessionId: string): number {
  const pendingCount = hasPendingFlag(sessionId) ? 1 : 0;
  const toolCount = getToolQueueEntryCount(sessionId);
  return pendingCount + toolCount;
}

/**
 * Flush the current session — check for pending work, parse+upsert if needed,
 * and flush tool queue.
 */
export async function flushCurrentSession(
  sessionId: string,
  sessionPath: string,
  config: HindsightConfig,
  client: HindsightClientWrapper,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options?: { notifyNoWork?: boolean; autoFlush?: boolean }
): Promise<void> {
  try {
    recoverStaleInflightClaims(sessionId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.notify(`In-flight recovery failed: ${msg}`, "error");
  }

  let sessionHadPendingWork = false;

  if (hasPendingFlag(sessionId)) {
    if (sessionPath && existsSync(sessionPath)) {
      await parseAndUpsertSession(sessionPath, sessionId, config, client, ctx, signal, {
        requirePending: true,
        autoFlush: options?.autoFlush,
      });
      sessionHadPendingWork = true;
    } else {
      ctx.ui.notify(
        "Session file not found — pending session work left queued. Restore or fix the session file, then retry flush.",
        "warning"
      );
      sessionHadPendingWork = true;
    }
  }

  const toolResult = await flushToolQueue(sessionId, client, ctx, signal, {
    notifySuccess: !options?.autoFlush || config.debug,
  });
  const toolDidWork = toolResult.count > 0 || !toolResult.success;

  const shouldNotifyNoWork = options?.notifyNoWork || (!!options?.autoFlush && config.debug);
  if (!sessionHadPendingWork && !toolDidWork && shouldNotifyNoWork) {
    ctx.ui.notify("No pending changes", "info");
  }
}

// ============================================
// Upsert to Hindsight
// ============================================

/** Params shared by upsertToHindsight and parseAndUpsertSession. */
export interface UpsertParams {
  content: string;
  documentId: string;
  context: string;
  timestamp: string;
  tags: string[];
  sessionId: string;
  parentSessionId?: string;
  sessionCwd: string;
}

/**
 * Call client.retain with standard options (updateMode=replace, entities from config).
 * Throws on failure.
 */
export async function upsertToHindsight(
  client: HindsightClientWrapper,
  params: UpsertParams,
  config: HindsightConfig,
  signal?: AbortSignal
): Promise<void> {
  const expandedScopes = expandSessionObservationScopes(
    config,
    params.sessionId,
    params.parentSessionId,
    params.sessionCwd,
    getProjectName(params.sessionCwd)
  );

  const result = await client.retain(
    {
      content: params.content,
      documentId: params.documentId,
      context: params.context,
      timestamp: params.timestamp,
      tags: params.tags,
      updateMode: "replace",
      entities: config.entities.length > 0 ? config.entities : undefined,
      observationScopes: expandedScopes,
    },
    signal
  );

  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
}

// ============================================
// Flush guard check using live state
// ============================================

/**
 * Fast-path check using live session state to avoid parsing large session files.
 *
 * Returns `{ blocked: true }` with a result message if the session should be
 * skipped, or `{ blocked: false }` with the parsed live state (or null if missing).
 *
 * When live state is missing or malformed, returns `{ blocked: false }` so the
 * caller falls back to parsing the session file.
 */
function preFlushCheck(
  sessionId: string,
  config: HindsightConfig
): {
  blocked: boolean;
  result?: { message: string; level: "info" | "warning" };
  liveState: SessionStateFile | null;
} {
  const liveState = readSessionState(sessionId);
  if (!liveState) {
    // Missing state — not blocking; fall back to parsing
    return { blocked: false, liveState: null };
  }

  if (!liveState.retained) {
    return {
      blocked: true,
      result: { message: "Session does not allow retention", level: "warning" },
      liveState,
    };
  }

  if (config.requireExtraContextBeforeFlush && !isExtraContextSet(liveState.extraContext)) {
    return {
      blocked: true,
      result: { message: FLUSH_BLOCKED_NO_EXTRA_CONTEXT, level: "warning" },
      liveState,
    };
  }

  return { blocked: false, liveState };
}

// ============================================
// parseAndUpsertSession helpers
// ============================================

/**
 * Handle the retention-disabled fast-block: clear pending markers and optionally notify.
 * Extra-context guard blocks leave pending markers — setting context later
 * should allow flushing the same work.
 *
 * Side effects (pending marker cleanup) always run. The UI notification is
 * gated by the `notify` parameter — auto-flushes suppress transient notifications.
 */
function handlePreFlushBlocked(
  sessionId: string,
  retained: boolean,
  result: { message: string; level: "info" | "warning" },
  ctx: ExtensionContext,
  notify: boolean
): void {
  if (!retained) {
    const claim = claimPendingFlag(sessionId);
    if (claim) completeClaim(claim);
  }
  if (notify) {
    ctx.ui.notify(result.message, result.level);
  }
}

/**
 * Write parsed-session cache files and complete the claim after a successful flush.
 */
function finalizeSuccessfulFlush(
  sessionId: string,
  formattedStrs: string[],
  meta: MetaFile,
  claim: QueueClaim | null
): boolean {
  if (claim && !existsSync(claim.claimDir)) {
    return false;
  }
  writeMessagesJsonl(sessionId, formattedStrs);
  writeMetaFile(sessionId, meta);
  if (claim) {
    completeClaim(claim);
  }
  return true;
}

/**
 * Best-effort claim restore after a flush failure.
 */
function restoreClaimAfterFailure(claim: QueueClaim, originalError: unknown): string | null {
  try {
    restoreClaim(claim);
    return null;
  } catch (restoreError) {
    const restoreMsg = restoreError instanceof Error ? restoreError.message : String(restoreError);
    const origMsg = originalError instanceof Error ? originalError.message : String(originalError);
    return `${origMsg} (claim restore also failed: ${restoreMsg})`;
  }
}

/**
 * Resolve session flush metadata from parsed session data.
 *
 * After parsing, the session file is the sole authority for all metadata.
 * Live state is NOT consulted here — it was only used for pre-parse fast guards.
 * Structural/upsert identity comes from the parsed session header.
 * User-controlled metadata (extra context, tags) comes from parsed entries.
 * Context is built from current config.
 */
function resolveSessionFlushMetadata(
  header: SessionHeader,
  entries: SessionEntry[],
  hindsightMeta: HindsightMeta | null,
  config: HindsightConfig
): {
  parentSessionId: string | undefined;
  sessionCwd: string;
  sessionTimestamp: string;
  sessionName: string;
  extraContext: string | null;
  sessionUserTags: string[];
  tags: string[];
  context: string;
} {
  const base = resolveParsedSessionMetadata(header, entries, hindsightMeta, config);
  const tags = buildDocumentTags(header, config, {
    sessionUserTags: base.sessionUserTags,
    parentSessionId: base.parentSessionId,
  });
  return {
    ...base,
    tags,
  };
}

/**
 * Build the MetaFile (parsed artifact) for writing after a successful flush.
 */
function buildSessionMetaFile(params: {
  sessionId: string;
  sessionName: string;
  extraContext: string | null;
  sessionUserTags: string[];
  parentSessionId: string | undefined;
  sessionCwd: string;
  sessionTimestamp: string;
  messageCount: number;
  isRetained: boolean;
}): MetaFile {
  return buildMetaFile({
    sessionId: params.sessionId,
    sessionName: params.sessionName,
    extraContext: params.extraContext,
    sessionUserTags: params.sessionUserTags,
    parentSessionId: params.parentSessionId,
    sessionCwd: params.sessionCwd,
    sessionTimestamp: params.sessionTimestamp,
    messageCount: params.messageCount,
    retained: params.isRetained,
  });
}

/**
 * Build the UpsertParams for the Hindsight retain API call.
 */
function buildSessionUpsertParams(
  content: string,
  resolved: {
    context: string;
    sessionTimestamp: string;
    tags: string[];
    parentSessionId: string | undefined;
    sessionCwd: string;
  },
  sessionId: string
): UpsertParams {
  return {
    content,
    documentId: sessionId,
    context: resolved.context,
    timestamp: resolved.sessionTimestamp,
    tags: resolved.tags,
    sessionId,
    parentSessionId: resolved.parentSessionId,
    sessionCwd: resolved.sessionCwd,
  };
}

// ============================================
// parseAndUpsertSession (unified flush path)
// ============================================

/**
 * Parse a session file and upsert to Hindsight.
 *
 * Uses live session state only for fast pre-checks. If state is missing or
 * malformed, falls back to parsing the session file. After parsing, derives
 * all metadata from the parsed entries + config (not from stale cached data).
 *
 * After a successful upsert:
 * - Writes `.messages.jsonl` (review/export artifact)
 * - Writes `.meta.json` (parsed artifact manifest for upsert-all-parsed)
 * - Updates live session state from parsed metadata
 */
export async function parseAndUpsertSession(
  sessionPath: string,
  sessionId: string,
  config: HindsightConfig,
  client: HindsightClientWrapper,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options?: { requirePending?: boolean; autoFlush?: boolean }
): Promise<void> {
  // Fast-path blocking checks using live state
  const preCheck = preFlushCheck(sessionId, config);
  if (preCheck.blocked) {
    // Side effects (pending marker cleanup) always run.
    // UI notification is suppressed for auto-flushes unless debug mode is on.
    const notify = !options?.autoFlush || config.debug;
    handlePreFlushBlocked(
      sessionId,
      preCheck.liveState?.retained ?? true,
      preCheck.result as { message: string; level: "info" | "warning" },
      ctx,
      notify
    );
    return;
  }

  let claim: QueueClaim | null = null;
  const debug = config.debug;
  try {
    claim = claimPendingFlag(sessionId);
    if (options?.requirePending && !claim) {
      // In auto-flush mode, this notification is transient and not useful.
      // Only show it for manual flushes or in debug mode. This can happen if
      // another flusher claimed/cleared the marker between hasPendingFlag and
      // claimPendingFlag — a benign race.
      if (!options?.autoFlush || config.debug) {
        ctx.ui.notify("No pending changes", "info");
      }
      return;
    }

    // Always reparse the session file for conversation messages.
    const t0 = debug ? performance.now() : 0;
    const { header, entries } = parseSessionFile(sessionPath);
    // Defensive invariant: the caller-supplied sessionId must match the parsed
    // session file header id. This should never happen in normal operation —
    // the caller derives sessionId from the same file path/source. But if a
    // wrong or corrupt session file is somehow passed, proceeding would write
    // parsed artifacts/live state/upserts under the wrong identity (tags,
    // document id, cache paths all key off the caller sessionId). Hard-fail
    // instead so the pending claim is restored (the catch below restores it)
    // and the user is notified of the mismatch for retry/fix.
    if (header.id !== sessionId) {
      throw new Error(
        `Session ID mismatch: expected ${sessionId} but session file header has ${header.id}`
      );
    }
    const hindsightMeta = getHindsightMeta(entries);
    const liveState = preCheck.liveState;

    // After parsing, session file is the sole authority for retention.
    const isRetained = shouldSessionBeRetained(entries, config);
    if (!isRetained) {
      // Write/update live state so future flushes can fast-block without reparsing
      const parsedExtraContext =
        hindsightMeta && "extraContext" in hindsightMeta
          ? (hindsightMeta.extraContext ?? "")
          : null;
      updateLiveStateFromParsed(sessionId, false, parsedExtraContext, liveState);
      if (claim) completeClaim(claim);
      // In auto-flush mode, block notifications are transient and not useful.
      // Only show them for manual flushes or in debug mode.
      if (!options?.autoFlush || debug) {
        ctx.ui.notify("Session does not allow retention", "warning");
      }
      return;
    }

    // Extra context check: derive from parsed entries, not live state.
    // Live state was only used for pre-parse fast guard above.
    const parsedExtraContext =
      hindsightMeta && "extraContext" in hindsightMeta ? (hindsightMeta.extraContext ?? "") : null;
    if (config.requireExtraContextBeforeFlush && !isExtraContextSet(parsedExtraContext)) {
      // Write/update live state so future flushes can fast-block without reparsing
      updateLiveStateFromParsed(sessionId, true, parsedExtraContext, liveState);
      if (claim) restoreClaim(claim);
      // In auto-flush mode, block notifications are transient and not useful.
      // Only show them for manual flushes or in debug mode.
      if (!options?.autoFlush || debug) {
        ctx.ui.notify(FLUSH_BLOCKED_NO_EXTRA_CONTEXT, "warning");
      }
      return;
    }

    const {
      messages,
      sessionId: parsedSessionId,
      warning,
    } = buildMessageArrayFromParsedSession(header, entries, config);

    if (debug) {
      const elapsed = performance.now() - t0;
      console.log(
        `pi-hindsight debug: parsePipeline(${sessionId}) took ${elapsed.toFixed(2)}ms, ${messages.length} messages`
      );
    }

    if (messages.length === 0) {
      if (warning) {
        if (claim) restoreClaim(claim);
        ctx.ui.notify(warning, "warning");
        return;
      }
      if (claim) completeClaim(claim);
      ctx.ui.notify("No messages to parse", "info");
      return;
    }

    // Resolve metadata from parsed session data (session file is authority, not live state)
    const resolved = resolveSessionFlushMetadata(header, entries, hindsightMeta, config);

    // Serialize messages
    const formattedStrs = messages.map((m) => JSON.stringify(m));
    const content = formattedStrs.join("\n");

    // Build parsed artifact meta and upsert params
    const meta = buildSessionMetaFile({
      sessionId: parsedSessionId,
      sessionName: resolved.sessionName,
      extraContext: resolved.extraContext,
      sessionUserTags: resolved.sessionUserTags,
      parentSessionId: resolved.parentSessionId,
      sessionCwd: resolved.sessionCwd,
      sessionTimestamp: resolved.sessionTimestamp,
      messageCount: formattedStrs.length,
      isRetained,
    });
    const upsertParams = buildSessionUpsertParams(
      content,
      {
        context: resolved.context,
        sessionTimestamp: resolved.sessionTimestamp,
        tags: resolved.tags,
        parentSessionId: resolved.parentSessionId,
        sessionCwd: resolved.sessionCwd,
      },
      parsedSessionId
    );

    // Network call
    await upsertToHindsight(client, upsertParams, config, signal);

    // Finalize: write parsed artifacts and complete the claim. If the claim dir
    // disappeared during the network call, queue state was concurrently cleared;
    // do not rewrite parsed artifacts, live state, or success notifications from
    // this stale flush.
    const finalized = finalizeSuccessfulFlush(sessionId, formattedStrs, meta, claim);
    if (!finalized) {
      claim = null;
      return;
    }

    // Update live session state from parsed metadata if it was missing or stale
    updateLiveStateFromParsed(sessionId, isRetained, resolved.extraContext, liveState);

    claim = null;

    if (!options?.autoFlush || debug) {
      ctx.ui.notify(`Parsed and upserted ${formattedStrs.length} messages`, "info");
    }
  } catch (e) {
    if (claim) {
      const combinedMsg = restoreClaimAfterFailure(claim, e);
      if (combinedMsg) {
        ctx.ui.notify(combinedMsg, "error");
        return;
      }
    }
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.notify(msg, "error");
  }
}

/**
 * Update live session state after a successful parse/upsert.
 * Only writes if the state was missing or would change.
 */
function updateLiveStateFromParsed(
  sessionId: string,
  retained: boolean,
  extraContext: string | null,
  currentState: SessionStateFile | null
): void {
  // Only update if state is missing or would actually change
  if (
    currentState &&
    currentState.retained === retained &&
    currentState.extraContext === extraContext
  ) {
    return;
  }

  const newState: SessionStateFile = {
    retained,
    extraContext,
    updatedAt: new Date().toISOString(),
  };

  const success = writeSessionState(sessionId, newState);
  if (!success) {
    console.warn(`Failed to update live session state for ${sessionId} after flush`);
  }
}
