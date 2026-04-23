/**
 * Retention handling for pi message events.
 */

import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import type { HindsightClientWrapper } from "./client";
import type { HindsightConfig } from "./config";
import { expandSessionObservationScopes } from "./config";
import { getHindsightMeta } from "./meta";
import type { ToolQueueEntry } from "./queue";
import {
  deleteAutoQueue,
  deleteToolQueue,
  enqueueToolMessage,
  readAutoQueue,
  readToolQueue,
} from "./queue";
import { truncate } from "./utils";

/**
 * Queue a tool retain entry with complete tags.
 * Tags are built at queue time to capture the session context when retained.
 * Observation scopes are captured from config at queue time
 * (not settable by the LLM - re-evaluate if want it to be manually settable).
 * Returns true on success, false on failure.
 */
export function queueToolRetain(
  sessionId: string,
  content: string,
  userTags: string[] | undefined,
  metadata: Record<string, string> | undefined,
  sessionCwd: string,
  parentSessionId: string | undefined,
  config: Pick<HindsightConfig, "constantTags" | "observationScopes">,
  sessionTags?: string[]
): boolean {
  // Build complete tags at queue time
  const tags = [
    ...config.constantTags,
    `session:${sessionId}`,
    `cwd:${sessionCwd}`,
    `store_method:tool`,
    `parent:${parentSessionId ?? sessionId}`,
    ...(userTags ?? []),
    ...(sessionTags ?? []),
  ];

  // Expand placeholders in observation scopes at queue time
  const expandedScopes = expandSessionObservationScopes(config, sessionId, parentSessionId);

  const entry: ToolQueueEntry = {
    content,
    tags,
    metadata,
    timestamp: new Date().toISOString(),
    store_method: "tool",
    ...(expandedScopes ? { observation_scopes: expandedScopes } : {}),
  };
  return enqueueToolMessage(sessionId, entry);
}

/**
 * Flush auto-queue entries to Hindsight.
 * All auto entries are combined into a single document with session ID.
 */
export async function flushAutoQueue(
  sessionId: string,
  sessionName: string,
  sessionStartTime: string,
  sessionCwd: string,
  parentSessionId: string | undefined,
  config: HindsightConfig,
  client: HindsightClientWrapper,
  signal?: AbortSignal,
  entries?: Array<{ type: string; customType?: string; data?: unknown }>
): Promise<{ success: boolean; error?: string; count: number }> {
  const autoEntries = readAutoQueue(sessionId);
  if (autoEntries.length === 0) {
    return { success: true, count: 0 };
  }

  // Build tags: base session tags + session metadata tags
  const meta = entries ? getHindsightMeta(entries) : null;
  const sessionTags = meta?.tags ?? [];
  const tags = [
    ...config.constantTags,
    `session:${sessionId}`,
    `cwd:${sessionCwd}`,
    `store_method:auto`,
    `parent:${parentSessionId ?? sessionId}`,
    ...sessionTags,
  ];

  // Build context
  const context = truncate(
    config.hindsightContextPrefix + sessionName,
    config.hindsightContextMaxLength
  );

  // Concatenate all entries into single content array
  const contentItems = autoEntries.map((entry) => entry.entry);

  // Expand placeholders in observation scopes
  const expandedScopes = expandSessionObservationScopes(config, sessionId, parentSessionId);

  const result = await client.retain(
    {
      content: JSON.stringify(contentItems),
      documentId: sessionId,
      updateMode: "append",
      context,
      timestamp: sessionStartTime,
      tags,
      entities: config.entities.length > 0 ? config.entities : undefined,
      observationScopes: expandedScopes,
    },
    signal
  );

  if (result.success) {
    deleteAutoQueue(sessionId);
  }
  return {
    success: result.success,
    error: result.error,
    count: result.success ? autoEntries.length : 0,
  };
}

/**
 * Flush tool-queue entries to Hindsight.
 * Uses batch retain for efficiency.
 * On success, clears the queue. On failure, leaves queue intact for retry.
 */
export async function flushToolQueue(
  sessionId: string,
  client: HindsightClientWrapper,
  signal?: AbortSignal
): Promise<{ success: boolean; error?: string; count: number }> {
  const entries = readToolQueue(sessionId);
  if (entries.length === 0) {
    return { success: true, count: 0 };
  }

  const items: MemoryItemInput[] = entries.map((entry) => ({
    content: entry.content,
    tags: entry.tags,
    metadata: entry.metadata,
    observation_scopes: entry.observation_scopes,
    timestamp: entry.timestamp,
  }));

  const result = await client.retainBatch(items, signal);

  if (result.success) {
    deleteToolQueue(sessionId);
    return { success: true, count: entries.length };
  } else {
    // Leave queue intact for retry
    console.warn(`Failed to flush tool queue: ${result.error}`);
    return { success: false, error: result.error, count: 0 };
  }
}

/**
 * Flush both auto and tool queues for a session.
 */
export async function flushQueues(
  sessionId: string,
  sessionName: string,
  sessionStartTime: string,
  sessionCwd: string,
  parentSessionId: string | undefined,
  config: HindsightConfig,
  client: HindsightClientWrapper,
  signal?: AbortSignal,
  entries?: Array<{ type: string; customType?: string; data?: unknown }>
): Promise<{ success: boolean; error?: string; autoCount: number; toolCount: number }> {
  const autoResult = await flushAutoQueue(
    sessionId,
    sessionName,
    sessionStartTime,
    sessionCwd,
    parentSessionId,
    config,
    client,
    signal,
    entries
  );

  const toolResult = await flushToolQueue(sessionId, client, signal);

  return {
    success: autoResult.success && toolResult.success,
    error: autoResult.error ?? toolResult.error,
    autoCount: autoResult.count,
    toolCount: toolResult.count,
  };
}

/**
 * Get total count of queued messages for a session (auto + tool).
 */
export function getQueueCount(sessionId: string): number {
  return readAutoQueue(sessionId).length + readToolQueue(sessionId).length;
}
