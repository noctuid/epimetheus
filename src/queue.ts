/**
 * Queue file management for turn-by-turn retention.
 *
 * Lock-free queue protocol using atomic per-entry files + atomic rename claims.
 * No file locking needed — atomic rename is the synchronization primitive.
 *
 * Layout:
 *   queue/<session-id>/pending/<marker-id>.json      — pending markers
 *   queue/<session-id>/pending/.inflight/<claim-id>/  — claimed pending markers
 *   queue/<session-id>/tool/<entry-id>.json            — tool queue entries
 *   queue/<session-id>/tool/.inflight/<claim-id>/      — claimed tool entries
 *
 * Error handling: no UI notifications or logging in this data layer.
 * - Enqueue operations (enqueueToolMessage) return QueueResult when callers
 *   need explicit failure handling.
 * - touchPendingFlag returns QueueResult so callers can warn on failure.
 * - Cleanup best-effort helpers (removePendingFlag, clearSessionQueueState)
 *   are void and swallow non-critical errors.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ObservationScopes } from "./config";
import {
  ensureQueueDir,
  getClaimDir,
  getClaimMetaPath,
  getCurrentHostname,
  getPendingDir,
  getPendingInflightDir,
  getPendingTokenPath,
  getQueueDir,
  getSessionQueueDir,
  getToolDir,
  getToolEntryPath,
  getToolInflightDir,
  isClaimAbandoned,
  listJsonFiles,
} from "./queue-paths";

export { ensureQueueDir, getQueueDir, getSessionQueueDir };

/**
 * Queue entry for tool-initiated retains (hindsight_retain tool).
 */
export type ToolQueueEntry = {
  /** Raw content string */
  content: string;
  /** User-specified tags */
  tags?: string[];
  /** Optional metadata */
  metadata?: Record<string, string>;
  /** When the entry was queued (ISO 8601) */
  timestamp: string;
  store_method: "tool";
  /** Observation scopes for controlling how observations are consolidated. */
  observation_scopes?: Exclude<ObservationScopes, null>;
  /** Stable document ID for idempotent retain. Enables upsert/replace on retry. */
  document_id?: string;
  /** Session ID (snapshot at enqueue time) */
  sessionId: string;
  /** Parent session ID if relevant */
  parentSessionId?: string;
  /** Session cwd at enqueue time */
  sessionCwd?: string;
  /** Update mode for retain */
  update_mode?: "replace";
};

/** Result type for queue operations that can fail. */
export type QueueResult = { success: true } | { success: false; error: string };

/**
 * Write a file atomically (write temp + rename).
 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

// ============================================
// Tool queue: enqueue
// ============================================

/**
 * Enqueue a tool retain entry.
 * Creates a per-entry file in the tool queue directory.
 * Public API — no locking needed (atomic file creation).
 * Returns structured result — callers with ctx should notify on failure.
 */
export function enqueueToolMessage(sessionId: string, entry: ToolQueueEntry): QueueResult {
  try {
    ensureQueueDir(sessionId);
    const entryId = randomUUID();
    const entryPath = getToolEntryPath(sessionId, entryId);
    atomicWrite(entryPath, JSON.stringify(entry));
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================
// Tool queue: inspect
// ============================================

/**
 * Check if a tool queue has entries for a session.
 */
export function toolQueueExists(sessionId: string): boolean {
  const toolDir = getToolDir(sessionId);
  return existsSync(toolDir) && listJsonFiles(toolDir).length > 0;
}

// ============================================
// Dirty flag (pending) management
// ============================================

/**
 * Create a pending marker for a session.
 * Each marker is a unique file — multiple markers can coexist.
 * Public API — no locking needed (atomic file creation).
 */
export function touchPendingFlag(sessionId: string, reason: string = "message_end"): QueueResult {
  try {
    ensureQueueDir(sessionId);
    const tokenId = randomUUID();
    const tokenPath = getPendingTokenPath(sessionId, tokenId);
    const token = {
      id: tokenId,
      sessionId,
      createdAt: new Date().toISOString(),
      reason,
    };
    atomicWrite(tokenPath, JSON.stringify(token));
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Check if any pending markers exist for a session.
 */
export function hasPendingFlag(sessionId: string): boolean {
  const pendingDir = getPendingDir(sessionId);
  return existsSync(pendingDir) && listJsonFiles(pendingDir).length > 0;
}

/**
 * Remove all pending markers for a session.
 * Returns void — cleanup is best-effort.
 */
export function removePendingFlag(sessionId: string): void {
  const pendingDir = getPendingDir(sessionId);
  if (!existsSync(pendingDir)) return;

  try {
    const tokenIds = listJsonFiles(pendingDir);
    for (const tokenId of tokenIds) {
      rmSync(getPendingTokenPath(sessionId, tokenId), { force: true });
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Get all session IDs that have pending markers or tool queue entries.
 * Scans the queue directory for session subdirectories with pending markers or tool entries.
 *
 * This discovery is intentionally best-effort and lock-free. It may race with other
 * terminals or concurrent flush operations; later claim/flush steps handle empty or
 * no-work cases safely, so a session discovered here is not guaranteed to still have
 * pending work by the time it is processed.
 */
export function getPendingSessionIds(): string[] {
  const queueDir = getQueueDir();
  if (!existsSync(queueDir)) return [];

  try {
    const sessionDirs = readdirSync(queueDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    return sessionDirs.filter(
      (sessionId) => hasPendingFlag(sessionId) || toolQueueExists(sessionId)
    );
  } catch {
    return [];
  }
}

// ============================================
// Claiming pattern (atomic rename)
// ============================================

/** Claim handle for inflight work. */
export interface QueueClaim {
  sessionId: string;
  queueType: "pending" | "tool";
  claimId: string;
  claimDir: string;
  /** Paths of claimed files (inside claim dir) */
  claimedFiles: string[];
}

/**
 * Claim pending markers by atomically renaming them into an inflight claim dir.
 * If no markers exist, returns null.
 *
 * New markers created during the claim are untouched (they're in pending/ not in the claim dir).
 */
export function claimPendingFlag(sessionId: string): QueueClaim | null {
  const pendingDir = getPendingDir(sessionId);
  const tokenIds = listJsonFiles(pendingDir);
  if (tokenIds.length === 0) return null;

  return finalizeClaim(claimFiles("pending", sessionId, tokenIds));
}

/**
 * Claim tool queue entries by atomically renaming them into an inflight claim dir.
 * If no entries exist, returns null.
 *
 * New entries created during the claim are untouched.
 */
export function claimToolQueue(sessionId: string): QueueClaim | null {
  const toolDir = getToolDir(sessionId);
  const entryIds = listJsonFiles(toolDir);
  if (entryIds.length === 0) return null;

  return finalizeClaim(claimFiles("tool", sessionId, entryIds));
}

/**
 * Claim a set of files by renaming them into a new inflight claim directory.
 */
function claimFiles(
  queueType: "pending" | "tool",
  sessionId: string,
  fileIds: string[]
): QueueClaim {
  const claimId = randomUUID();
  const claimDir = getClaimDir(queueType, sessionId, claimId);
  mkdirSync(claimDir, { recursive: true });

  // Write claim metadata
  const claimMeta = {
    claimId,
    sessionId,
    queue: queueType,
    pid: process.pid,
    hostname: getCurrentHostname(),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(getClaimMetaPath(queueType, sessionId, claimId), JSON.stringify(claimMeta), "utf8");

  const claimedFiles: string[] = [];
  for (const fileId of fileIds) {
    const srcPath =
      queueType === "pending"
        ? getPendingTokenPath(sessionId, fileId)
        : getToolEntryPath(sessionId, fileId);
    const destPath = join(claimDir, `${fileId}.json`);

    try {
      renameSync(srcPath, destPath);
      claimedFiles.push(destPath);
    } catch (e) {
      // ENOENT = another process claimed it first, skip
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
  }

  return { sessionId, queueType, claimId, claimDir, claimedFiles };
}

/**
 * If a claim claimed no files, clean it up and return null.
 * Otherwise return the claim as-is.
 */
function finalizeClaim(claim: QueueClaim): QueueClaim | null {
  if (claim.claimedFiles.length === 0) {
    rmSync(claim.claimDir, { recursive: true, force: true });
    return null;
  }
  return claim;
}

/**
 * Complete a claim by deleting the claim directory and all claimed files.
 */
export function completeClaim(claim: QueueClaim): void {
  rmSync(claim.claimDir, { recursive: true, force: true });
}

/**
 * Restore a claim by moving claimed files back to their original queue directory.
 * Used when flush fails and work needs to be retried.
 * Only removes the claim dir after all files are successfully restored.
 */
export function restoreClaim(claim: QueueClaim): void {
  ensureQueueDir(claim.sessionId);
  const targetDir =
    claim.queueType === "pending" ? getPendingDir(claim.sessionId) : getToolDir(claim.sessionId);

  let anyFailed = false;
  for (const claimedPath of claim.claimedFiles) {
    if (!existsSync(claimedPath)) continue;
    const filename = basename(claimedPath);
    const destPath = join(targetDir, filename);
    try {
      renameSync(claimedPath, destPath);
    } catch {
      anyFailed = true;
    }
  }

  // Only remove claim dir if all files were restored successfully.
  // If any rename failed, leave the claim dir so recovery can retry later.
  if (!anyFailed) {
    rmSync(claim.claimDir, { recursive: true, force: true });
  } else {
    // Remove .claim.json so future recovery uses age-based abandonment.
    try {
      rmSync(join(claim.claimDir, ".claim.json"), { force: true });
    } catch {
      // best-effort
    }
  }
}

/** Error from reading a claimed tool-entry file. */
export type ClaimReadError =
  | { type: "missing"; filePath: string }
  | { type: "malformed_json"; filePath: string; error: string }
  | { type: "invalid_schema"; filePath: string; reason: string };

/** Result of reading tool entries from a claim. */
export type ClaimReadResult = {
  entries: ToolQueueEntry[];
  errors: ClaimReadError[];
};

/**
 * Read tool entries from a claim's claimed files.
 *
 * Reports parse/validation errors instead of silently skipping them.
 * Callers should check `errors` and decide whether to proceed or restore
 * the claim.
 */
export function readClaimedToolEntries(claim: QueueClaim): ClaimReadResult {
  const entries: ToolQueueEntry[] = [];
  const errors: ClaimReadError[] = [];
  for (const filePath of claim.claimedFiles) {
    if (!existsSync(filePath)) {
      errors.push({ type: "missing", filePath });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (e) {
      errors.push({
        type: "malformed_json",
        filePath,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).store_method === "tool" &&
      typeof (parsed as Record<string, unknown>).content === "string" &&
      typeof (parsed as Record<string, unknown>).timestamp === "string"
    ) {
      entries.push(parsed as ToolQueueEntry);
    } else {
      // Build a helpful reason string
      const reasons: string[] = [];
      if (typeof parsed !== "object" || parsed === null) {
        reasons.push("not an object");
      } else {
        const obj = parsed as Record<string, unknown>;
        if (obj.store_method !== "tool") reasons.push(`store_method=${String(obj.store_method)}`);
        if (typeof obj.content !== "string") reasons.push("content is not a string");
        if (typeof obj.timestamp !== "string") reasons.push("timestamp is not a string");
      }
      errors.push({ type: "invalid_schema", filePath, reason: reasons.join(", ") });
    }
  }
  return { entries, errors };
}

// ============================================
// Inflight recovery
// ============================================

/**
 * Recover abandoned inflight claims for a session.
 * Scans .inflight directories for claims whose owner PID is dead or that are stale.
 * Restores claimed files back to the live queue directories.
 */
export function recoverStaleInflightClaims(sessionId: string): void {
  recoverInflightClaimsForDir("pending", sessionId);
  recoverInflightClaimsForDir("tool", sessionId);
}

/**
 * Recover abandoned inflight claims for all sessions.
 */
export function recoverAllStaleInflightClaims(): void {
  const queueDir = getQueueDir();
  if (!existsSync(queueDir)) return;

  try {
    const sessionDirs = readdirSync(queueDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const sessionId of sessionDirs) {
      recoverStaleInflightClaims(sessionId);
    }
  } catch {
    // best-effort
  }
}

function recoverInflightClaimsForDir(queueType: "pending" | "tool", sessionId: string): void {
  const inflightDir =
    queueType === "pending" ? getPendingInflightDir(sessionId) : getToolInflightDir(sessionId);

  if (!existsSync(inflightDir)) return;

  try {
    const claimDirs = readdirSync(inflightDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const claimId of claimDirs) {
      const claimDir = join(inflightDir, claimId);
      if (!isClaimAbandoned(claimDir)) continue;

      // Restore claimed files to live queue
      const targetDir = queueType === "pending" ? getPendingDir(sessionId) : getToolDir(sessionId);

      try {
        ensureQueueDir(sessionId);
        const files = readdirSync(claimDir).filter(
          (f) => f.endsWith(".json") && f !== ".claim.json"
        );
        let anyFailed = false;
        for (const file of files) {
          const srcPath = join(claimDir, file);
          const destPath = join(targetDir, file);
          try {
            renameSync(srcPath, destPath);
          } catch {
            anyFailed = true;
          }
        }
        // Only remove claim dir if all files were restored successfully
        if (!anyFailed) {
          rmSync(claimDir, { recursive: true, force: true });
        } else {
          // Remove .claim.json so future recovery uses age-based abandonment.
          try {
            rmSync(join(claimDir, ".claim.json"), { force: true });
          } catch {
            // best-effort
          }
        }
      } catch {
        // best-effort recovery
      }
    }
  } catch {
    // best-effort
  }
}

// ============================================
// Clear session queue state
// ============================================

/**
 * Clear all queued state for a session.
 * Deletes pending markers, tool entries, and any inflight claims.
 */
export function clearSessionQueueState(sessionId: string): void {
  const sessionDir = getSessionQueueDir(sessionId);
  if (!existsSync(sessionDir)) return;
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ============================================
// Queue count
// ============================================

/**
 * Count tool queue entry files for a session without reading their contents.
 *
 * Uses unlocked reads — a stale count is acceptable since this is only used
 * for display (status command) and a best-effort "no pending changes" check.
 */
export function getToolQueueEntryCount(sessionId: string): number {
  const toolDir = getToolDir(sessionId);
  return existsSync(toolDir) ? listJsonFiles(toolDir).length : 0;
}
