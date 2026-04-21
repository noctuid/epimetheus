/**
 * Queue file management for turn-by-turn retention.
 *
 * Queue files are stored in:
 *   <getAgentDir()>/extensions/pi-hindsight/queues/{id}.queue.jsonl
 *
 * Each line is a single JSON AutoQueueEntry object.
 * Tool queue files use {id}.tool-queue.jsonl with ToolQueueEntry objects.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import type { ObservationScopes } from "./config";

/**
 * Queue entry for auto-queued messages from message_end events.
 */
export type AutoQueueEntry = {
  /** Prepared message entry */
  entry: Record<string, unknown>;
  store_method: "auto";
};

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
  /** Omitted when config observationScopes is null (meaning use Hindsight default) */
  observation_scopes?: Exclude<ObservationScopes, null>;
};

/**
 * Get the queue directory path.
 */
export function getQueueDir(): string {
  const agentDir = getAgentDir();
  return join(agentDir, "extensions", "pi-hindsight", "queues");
}

/**
 * Get the queue file path for a session (auto-queued messages).
 */
export function getQueuePath(sessionId: string): string {
  return join(getQueueDir(), `${sessionId}.queue.jsonl`);
}

/**
 * Get the tool queue file path for a session (manual/tool retains).
 */
export function getToolQueuePath(sessionId: string): string {
  return join(getQueueDir(), `${sessionId}.tool-queue.jsonl`);
}

/**
 * Ensure the queue directory exists.
 */
export function ensureQueueDir(): void {
  const queueDir = getQueueDir();
  if (!existsSync(queueDir)) {
    mkdirSync(queueDir, { recursive: true });
  }
}

/**
 * Append an entry to the auto-queue file.
 * Returns true on success, false on failure.
 */
export function enqueueAutoMessage(sessionId: string, entry: AutoQueueEntry): boolean {
  try {
    ensureQueueDir();
    const queuePath = getQueuePath(sessionId);
    appendFileSync(queuePath, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch (e) {
    console.error(`Failed to enqueue auto message for session ${sessionId}:`, e);
    return false;
  }
}

/**
 * Append an entry to the tool queue file.
 * Returns true on success, false on failure.
 */
export function enqueueToolMessage(sessionId: string, entry: ToolQueueEntry): boolean {
  try {
    ensureQueueDir();
    const queuePath = getToolQueuePath(sessionId);
    appendFileSync(queuePath, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch (e) {
    console.error(`Failed to enqueue tool message for session ${sessionId}:`, e);
    return false;
  }
}

/**
 * Read all entries from the auto-queue file.
 * Skips malformed or invalid lines.
 * Throws on file read errors (caller should handle).
 */
export function readAutoQueue(sessionId: string): AutoQueueEntry[] {
  const queuePath = getQueuePath(sessionId);

  if (!existsSync(queuePath)) {
    return [];
  }

  const content = readFileSync(queuePath, "utf-8").trim();
  if (!content) {
    return [];
  }

  const entries: AutoQueueEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        parsed.store_method === "auto" &&
        typeof parsed.entry === "object"
      ) {
        entries.push(parsed as AutoQueueEntry);
      } else {
        console.warn(`Skipping invalid auto-queue entry in session ${sessionId}`);
      }
    } catch {
      console.warn(`Skipping malformed auto-queue line in session ${sessionId}`);
    }
  }

  return entries;
}

/**
 * Read all entries from the tool queue file.
 * Skips malformed or invalid lines.
 * Throws on file read errors (caller should handle).
 */
export function readToolQueue(sessionId: string): ToolQueueEntry[] {
  const queuePath = getToolQueuePath(sessionId);

  if (!existsSync(queuePath)) {
    return [];
  }

  const content = readFileSync(queuePath, "utf-8").trim();
  if (!content) {
    return [];
  }

  const entries: ToolQueueEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        parsed.store_method === "tool" &&
        typeof parsed.content === "string"
      ) {
        entries.push(parsed as ToolQueueEntry);
      } else {
        console.warn(`Skipping invalid tool-queue entry in session ${sessionId}`);
      }
    } catch {
      console.warn(`Skipping malformed tool-queue line in session ${sessionId}`);
    }
  }

  return entries;
}

/**
 * Delete the auto-queue file for a session.
 * Does not throw if file doesn't exist or deletion fails.
 */
export function deleteAutoQueue(sessionId: string): void {
  try {
    const queuePath = getQueuePath(sessionId);
    if (existsSync(queuePath)) {
      unlinkSync(queuePath);
    }
  } catch (e) {
    console.error(`Failed to delete auto-queue for session ${sessionId}:`, e);
  }
}

/**
 * Delete the tool queue file for a session.
 * Does not throw if file doesn't exist or deletion fails.
 */
export function deleteToolQueue(sessionId: string): void {
  try {
    const queuePath = getToolQueuePath(sessionId);
    if (existsSync(queuePath)) {
      unlinkSync(queuePath);
    }
  } catch (e) {
    console.error(`Failed to delete tool-queue for session ${sessionId}:`, e);
  }
}

/**
 * Check if an auto-queue exists for a session.
 */
export function autoQueueExists(sessionId: string): boolean {
  return existsSync(getQueuePath(sessionId));
}

/**
 * Check if a tool queue exists for a session.
 */
export function toolQueueExists(sessionId: string): boolean {
  return existsSync(getToolQueuePath(sessionId));
}
