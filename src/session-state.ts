/**
 * Live session state for fast guard checks.
 *
 * A small operational state file used for fast pre-checks during normal flush.
 * This is separate from parsed-session artifacts (.meta.json), which are
 * review/export snapshots used by /hindsight upsert-all-parsed.
 *
 * File layout:
 *   session-state/<session-id>.json
 *
 * Semantics:
 * - `extraContext === null`: user has not made an extra-context choice.
 * - `extraContext === ""`: user explicitly said no extra context needed.
 * - non-empty string: user-provided extraction caveats.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Live session state file format. */
export interface SessionStateFile {
  retained: boolean;
  extraContext: string | null;
  updatedAt: string;
}

// ============================================
// Path helpers
// ============================================

function getSessionStateDir(): string {
  return join(getAgentDir(), "extensions", "pi-hindsight", "session-state");
}

export function getSessionStatePath(sessionId: string): string {
  return join(getSessionStateDir(), `${sessionId}.json`);
}

function ensureSessionStateDir(): void {
  const dir = getSessionStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================
// Read / Write / Validate
// ============================================

/**
 * Read and validate a session state file.
 * Returns null if not found, unreadable, or structurally invalid.
 */
export function readSessionState(sessionId: string): SessionStateFile | null {
  const filePath = getSessionStatePath(sessionId);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!isValidSessionState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write a session state file atomically (temp + rename).
 * Returns true on success, false on failure.
 */
export function writeSessionState(sessionId: string, state: SessionStateFile): boolean {
  try {
    ensureSessionStateDir();
    const filePath = getSessionStatePath(sessionId);
    const tmpPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
    writeFileSync(tmpPath, `${JSON.stringify(state)}\n`, "utf-8");
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a session state file.
 * Returns true on success (or file didn't exist), false on failure.
 */
export function removeSessionState(sessionId: string): boolean {
  const filePath = getSessionStatePath(sessionId);
  if (!existsSync(filePath)) return true;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lightweight runtime validation for session state structure.
 */
function isValidSessionState(value: unknown): value is SessionStateFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.retained !== "boolean") return false;
  // extraContext must be null or string
  if (obj.extraContext !== null && typeof obj.extraContext !== "string") return false;
  if (typeof obj.updatedAt !== "string") return false;
  return true;
}
