/**
 * Session metadata management.
 *
 * Layers of metadata:
 * 1. Live session state (`session-state/<session-id>.json`): operational state
 *    for fast guard checks (retained, extraContext). Updated eagerly on metadata
 *    changes so fast-path checks work without re-parsing the session file.
 * 2. Parsed-session artifact (`parsed-sessions/<session-id>.meta.json`): manifest
 *    for /hindsight parse-session and human review. Written on successful
 *    parse/upsert. Not used for normal-flush live state.
 * 3. In-session `hindsight-meta` entries: written to the session JSONL on every
 *    metadata change. Portable source of truth — if the user moves session files
 *    without copying the epimetheus working directory, the session file still
 *    contains the metadata. Normal flush always reparses the session file.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "./config";
import { ensureParsedSessionDir, getMetaPath } from "./parsed-store";
import { touchPendingFlag } from "./queue";
import {
  readSessionState,
  removeSessionState,
  type SessionStateFile,
  writeSessionState,
} from "./session-state";

/** Message shown when a flush is blocked because extra context is not set. */
export const FLUSH_BLOCKED_NO_EXTRA_CONTEXT =
  "Hindsight flush blocked: extra context not set. Use /hindsight set-extra-context or the hindsight_set_extra_context tool to set extraction caveats before flushing.";

// ============================================
// Parsed artifact MetaFile types and operations
// ============================================

/** Parsed-session artifact metadata — used by /hindsight parse-session and review. */
export interface MetaFile {
  sessionId: string;
  /** Parsed session name (from session_info or first user message). */
  sessionName: string;
  /** Extra context string, null if user has not set extra context. */
  extraContext: string | null;
  /** User-provided session tags (rebuilt into full document tags during upsert). */
  sessionUserTags: string[];
  parentSessionId?: string;
  sessionCwd: string;
  /** Session creation timestamp (header.timestamp). */
  sessionTimestamp: string;
  messageCount: number;
  retained: boolean;
}

/**
 * Read and validate a `.meta.json` file by path.
 * Returns null if not found, unreadable, or structurally invalid.
 */
export function readMetaFileByPath(filePath: string): MetaFile | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!isValidMetaFile(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read the `.meta.json` file for a session. Returns null if not found or malformed. */
export function readMetaFile(sessionId: string): MetaFile | null {
  return readMetaFileByPath(getMetaPath(sessionId));
}

/**
 * Lightweight runtime validation for `.meta.json` structure.
 */
function isValidMetaFile(value: unknown): value is MetaFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;

  // Required string fields
  if (typeof obj.sessionId !== "string") return false;
  if (typeof obj.sessionName !== "string") return false;
  if (typeof obj.sessionCwd !== "string") return false;
  if (typeof obj.sessionTimestamp !== "string" || obj.sessionTimestamp.length === 0) {
    return false;
  }

  // Required number/boolean fields
  if (typeof obj.messageCount !== "number" || !Number.isFinite(obj.messageCount)) return false;
  if (typeof obj.retained !== "boolean") return false;

  // extraContext: must be null or string
  if (obj.extraContext !== null && typeof obj.extraContext !== "string") return false;

  // sessionUserTags: must be an array of strings
  if (
    !Array.isArray(obj.sessionUserTags) ||
    !obj.sessionUserTags.every((t: unknown) => typeof t === "string")
  ) {
    return false;
  }
  if (obj.parentSessionId !== undefined && typeof obj.parentSessionId !== "string") {
    return false;
  }

  return true;
}

/** Write the `.meta.json` file for a session atomically (temp + rename). */
export function writeMetaFile(sessionId: string, meta: MetaFile): void {
  ensureParsedSessionDir();
  const filePath = getMetaPath(sessionId);
  const tmpPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, `${JSON.stringify(meta)}\n`, "utf-8");
  renameSync(tmpPath, filePath);
}

// ============================================
// In-session metadata types and operations
// ============================================

/**
 * Session metadata stored in CustomEntry with customType "hindsight-meta".
 * All fields are optional - only the fields that have been set are present.
 */
export interface HindsightMeta {
  retained?: boolean;
  tags?: string[];
  /** Extra context appended to the Hindsight context field (after session name). */
  extraContext?: string;
  /**
   * When true, flushes for this session require a valid cwd-local flush config
   * (`<cwd>/.pi/epimetheus/flush-config.jsonc|.json`) and use its `projectName`.
   * Append-only: each new hindsight-meta entry carries forward the prior value
   * unless explicitly overridden. Latest metadata value wins. The flush config
   * path and the resolved project name are deliberately NOT stored here — see
   * `src/flush-config.ts` for resolution details.
   */
  usesProjectFlushConfig?: boolean;
}

/**
 * Get the latest hindsight metadata from session entries.
 * Scans from newest to oldest for the most recent "hindsight-meta" CustomEntry.
 * Returns null if no metadata entry exists.
 */
export function getHindsightMeta(
  entries: Array<{ type: string; customType?: string; data?: unknown }>
): HindsightMeta | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry &&
      entry.type === "custom" &&
      entry.customType === "hindsight-meta" &&
      entry.data !== undefined
    ) {
      return entry.data as HindsightMeta;
    }
  }
  return null;
}

/**
 * Build a new HindsightMeta by merging partial updates with existing metadata.
 */
export function buildMetaUpdate(
  existing: HindsightMeta | null,
  updates: Partial<HindsightMeta>
): HindsightMeta {
  const meta: HindsightMeta = {};

  const retained = updates.retained ?? existing?.retained;
  if (retained !== undefined) {
    meta.retained = retained;
  }

  const tags = updates.tags !== undefined ? updates.tags : existing?.tags;
  if (tags && tags.length > 0) {
    meta.tags = tags;
  }

  const extraContext =
    updates.extraContext !== undefined ? updates.extraContext : existing?.extraContext;
  if (extraContext !== undefined) {
    meta.extraContext = extraContext;
  }

  const usesProjectFlushConfig =
    updates.usesProjectFlushConfig !== undefined
      ? updates.usesProjectFlushConfig
      : existing?.usesProjectFlushConfig;
  if (usesProjectFlushConfig !== undefined) {
    meta.usesProjectFlushConfig = usesProjectFlushConfig;
  }

  return meta;
}

/**
 * Resolve extra context from live state or session entries.
 *
 * Returns the extra context string, or null if the user has not made a choice.
 * When live state exists, it is authoritative. Otherwise falls back to
 * the latest in-session hindsight-meta entry.
 */
export function resolveExtraContext(
  liveState: SessionStateFile | null,
  hindsightMeta: HindsightMeta | null
): string | null {
  if (liveState) return liveState.extraContext;
  if (hindsightMeta && "extraContext" in hindsightMeta) {
    return hindsightMeta.extraContext ?? "";
  }
  return null;
}

/**
 * Check whether extra context has been explicitly set (even to empty string).
 * Returns false when extra context is null (user has not made a choice).
 */
export function isExtraContextSet(extraContext: string | null): boolean {
  return extraContext !== null;
}

/**
 * Resolve retention state from live state or session entries.
 * Live state is authoritative when present. Falls back to session entries,
 * then to config default.
 */
export function resolveRetained(
  liveState: SessionStateFile | null,
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  config: Pick<HindsightConfig, "retainSessionsByDefault">
): boolean {
  if (liveState) return liveState.retained;
  return shouldSessionBeRetained(entries, config);
}

/**
 * Update session metadata and live state.
 *
 * 1. Appends a `hindsight-meta` entry to the session file (portable source of truth).
 * 2. Updates live session state when retained or extraContext changes.
 * 3. Creates a pending marker when tags or extra context change (affects retained output).
 *
 * Live state is preserved: existing values not mentioned in the update are kept.
 * If no live state exists, missing values are derived from in-session hindsight-meta
 * and config defaults.
 */
export async function updateSessionMetadata(
  pi: ExtensionAPI,
  sessionId: string | undefined,
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  updates: Partial<HindsightMeta>,
  config: Pick<HindsightConfig, "retainSessionsByDefault">
): Promise<void> {
  const existingMeta = getHindsightMeta(entries);
  const meta = buildMetaUpdate(existingMeta, updates);
  pi.appendEntry("hindsight-meta", meta);

  // Update live session state when relevant
  if (sessionId) {
    const currentState = readSessionState(sessionId);

    // Determine if we need to update live state
    const needsRetainedUpdate = updates.retained !== undefined;
    const needsExtraContextUpdate = updates.extraContext !== undefined;

    if (needsRetainedUpdate || needsExtraContextUpdate) {
      // Build merged state: preserve existing values, apply updates
      const retained = needsRetainedUpdate
        ? (updates.retained as boolean)
        : (currentState?.retained ??
          shouldSessionBeRetained(entries, {
            retainSessionsByDefault: config.retainSessionsByDefault,
          }));

      const extraContext = needsExtraContextUpdate
        ? (updates.extraContext ?? null)
        : resolveExtraContext(currentState, existingMeta);

      const newState: SessionStateFile = {
        retained,
        extraContext,
        updatedAt: new Date().toISOString(),
      };

      const success = writeSessionState(sessionId, newState);
      if (!success) {
        // If state update fails, try to delete stale state so next flush
        // falls back to parsing the session file
        console.warn(`Failed to update live session state for ${sessionId}, removing stale state`);
        if (!removeSessionState(sessionId)) {
          console.warn(`Failed to remove stale session state for ${sessionId}`);
        }
      }
    }

    // Changes to tags or extra context affect the retained document output,
    // so mark the session as needing a re-flush.
    if (updates.tags !== undefined || updates.extraContext !== undefined) {
      const result = touchPendingFlag(sessionId);
      if (!result.success) {
        console.warn(`Failed to queue session for re-flush: ${result.error}`);
      }
    }
  }
}

/**
 * Build a MetaFile (parsed artifact) from parsed session data.
 */
export function buildMetaFile(params: {
  sessionId: string;
  sessionName: string;
  extraContext: string | null;
  sessionUserTags: string[];
  parentSessionId?: string;
  sessionCwd: string;
  sessionTimestamp: string;
  messageCount: number;
  retained: boolean;
}): MetaFile {
  return {
    sessionId: params.sessionId,
    sessionName: params.sessionName,
    extraContext: params.extraContext,
    sessionUserTags: params.sessionUserTags,
    parentSessionId: params.parentSessionId,
    sessionCwd: params.sessionCwd,
    sessionTimestamp: params.sessionTimestamp,
    messageCount: params.messageCount,
    retained: params.retained,
  };
}

/**
 * Checks the latest hindsight-meta entry for a retained field.
 * If no metadata entry exists or retained is undefined, falls back
 * to the retainSessionsByDefault config value.
 */
export function shouldSessionBeRetained(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  config: Pick<HindsightConfig, "retainSessionsByDefault">
): boolean {
  const meta = getHindsightMeta(entries);
  if (meta?.retained !== undefined) {
    return meta.retained;
  }
  return config.retainSessionsByDefault;
}
