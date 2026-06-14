/**
 * Queue directory and file path helpers.
 *
 * Layout:
 *   queue/<session-id>/pending/<marker-id>.json      — pending markers
 *   queue/<session-id>/pending/.inflight/<claim-id>/  — claimed pending markers
 *   queue/<session-id>/tool/<entry-id>.json            — tool queue entries
 *   queue/<session-id>/tool/.inflight/<claim-id>/      — claimed tool entries
 *
 * Separate module to avoid circular imports between queue.ts and retention.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Get the base queue directory path.
 */
export function getQueueDir(): string {
  return join(getAgentDir(), "extensions", "pi-hindsight", "queue");
}

/**
 * Get the session-specific queue directory.
 */
export function getSessionQueueDir(sessionId: string): string {
  return join(getQueueDir(), sessionId);
}

/**
 * Get the pending markers directory for a session.
 */
export function getPendingDir(sessionId: string): string {
  return join(getSessionQueueDir(sessionId), "pending");
}

/**
 * Get the tool queue directory for a session.
 */
export function getToolDir(sessionId: string): string {
  return join(getSessionQueueDir(sessionId), "tool");
}

/**
 * Get the inflight directory for pending claims.
 */
export function getPendingInflightDir(sessionId: string): string {
  return join(getPendingDir(sessionId), ".inflight");
}

/**
 * Get the inflight directory for tool claims.
 */
export function getToolInflightDir(sessionId: string): string {
  return join(getToolDir(sessionId), ".inflight");
}

/**
 * Get the path for a specific pending marker file.
 */
export function getPendingTokenPath(sessionId: string, tokenId: string): string {
  return join(getPendingDir(sessionId), `${tokenId}.json`);
}

/**
 * Get the path for a specific tool entry file.
 */
export function getToolEntryPath(sessionId: string, entryId: string): string {
  return join(getToolDir(sessionId), `${entryId}.json`);
}

/**
 * Get the path for a claim directory.
 */
export function getClaimDir(
  queueType: "pending" | "tool",
  sessionId: string,
  claimId: string
): string {
  const baseDir =
    queueType === "pending" ? getPendingInflightDir(sessionId) : getToolInflightDir(sessionId);
  return join(baseDir, claimId);
}

/**
 * Get the path for a claim metadata file.
 */
export function getClaimMetaPath(
  queueType: "pending" | "tool",
  sessionId: string,
  claimId: string
): string {
  return join(getClaimDir(queueType, sessionId, claimId), ".claim.json");
}

/**
 * Ensure the queue directory and session subdirectories exist.
 */
export function ensureQueueDir(sessionId?: string): void {
  const queueDir = getQueueDir();
  if (!existsSync(queueDir)) {
    mkdirSync(queueDir, { recursive: true });
  }
  if (sessionId) {
    const pendingDir = getPendingDir(sessionId);
    const toolDir = getToolDir(sessionId);
    if (!existsSync(pendingDir)) mkdirSync(pendingDir, { recursive: true });
    if (!existsSync(toolDir)) mkdirSync(toolDir, { recursive: true });
  }
}

/**
 * Read all .json filenames from a directory (non-recursive).
 * Returns empty array if directory doesn't exist.
 */
export function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** Default stale timeout for claims: 30 minutes. */
const DEFAULT_STALE_TIMEOUT_MS = 30 * 60 * 1000;

/** Current hostname for claim metadata. */
const CURRENT_HOSTNAME = hostname();

/**
 * Get the hostname used in claim metadata.
 */
export function getCurrentHostname(): string {
  return CURRENT_HOSTNAME;
}

/**
 * Check if a claim is abandoned.
 *
 * Recovery semantics:
 * - Same hostname + PID alive or EPERM → NOT abandoned
 * - Same hostname + PID dead (ESRCH) → abandoned immediately
 * - Different hostname → abandon only if older than stale timeout
 * - Missing/invalid metadata → abandon only if old enough (not immediately)
 * - Uses startedAt from metadata; falls back to claim dir mtime
 */
export function isClaimAbandoned(
  claimDir: string,
  staleTimeoutMs: number = DEFAULT_STALE_TIMEOUT_MS
): boolean {
  const metaPath = join(claimDir, ".claim.json");

  // No metadata — only abandon if old enough
  if (!existsSync(metaPath)) {
    return getClaimAgeMs(claimDir) > staleTimeoutMs;
  }

  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (!meta || typeof meta !== "object") {
      return getClaimAgeMs(claimDir) > staleTimeoutMs;
    }

    const sameHost = typeof meta.hostname === "string" && meta.hostname === CURRENT_HOSTNAME;

    // Same host: check PID directly
    if (sameHost && Number.isInteger(meta.pid) && meta.pid > 0) {
      try {
        process.kill(meta.pid, 0);
        return false; // PID alive — not abandoned
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "EPERM") return false; // Process exists — not abandoned
        // ESRCH = process dead
        return true; // Same host, dead PID — abandoned immediately
      }
    }

    // Different host or no PID — use age-based check only
    return getClaimAgeMs(claimDir, meta) > staleTimeoutMs;
  } catch {
    return getClaimAgeMs(claimDir) > staleTimeoutMs;
  }
}

/**
 * Get the age of a claim in milliseconds.
 * Uses startedAt from metadata if available, falls back to claim dir mtime.
 */
function getClaimAgeMs(claimDir: string, meta?: Record<string, unknown>): number {
  if (meta?.startedAt && typeof meta.startedAt === "string") {
    const startedAtMs = Date.parse(meta.startedAt);
    if (Number.isFinite(startedAtMs)) {
      return Date.now() - startedAtMs;
    }
  }
  // Fallback to claim dir mtime
  try {
    const mtime = statSync(claimDir).mtime;
    return Date.now() - mtime.getTime();
  } catch {
    return Infinity; // Can't determine age — treat as very old
  }
}
