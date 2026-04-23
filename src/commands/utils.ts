/**
 * Shared utilities for slash commands.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import { expandSessionObservationScopes, type HindsightConfig } from "../config";
import {
  buildDocumentTags,
  buildMessageArrayFromParsedSession,
  getHindsightContextFromEntries,
  parseSessionFile,
} from "../document";
import { getHindsightMeta, shouldSessionBeRetained } from "../meta";
import { deleteAutoQueue } from "../queue";
import { extractParentSessionId, getSessionDisplayName } from "../utils";

/** Result of parsing a session file for subcommand handlers. */
export interface ParsedSessionResult {
  /** The parsed session data ready for retention or disk output. */
  parsedSession: {
    documentId: string;
    context: string;
    tags: string[];
    timestamp: string;
    messages: object[];
    parsedAt: string;
    sessionId: string;
    parentSessionId?: string;
  };
  /** Path where the parsed session file was written on disk. */
  outputPath: string;
}

/**
 * Parse the current session file into a structured object for retention/export.
 *
 * Validates the session file exists, checks retention state, builds document tags
 * and context, and writes the parsed session to disk for later review.
 * Returns a {@link ParsedSessionResult} on success, or a string message on early exit
 * (e.g. "No session file found", "No messages to parse").
 */
export function parseCurrentSession(
  ctx: ExtensionContext,
  config: HindsightConfig
): ParsedSessionResult | string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile || !existsSync(sessionFile)) {
    return "No session file found";
  }

  const { header, entries: originalEntries } = parseSessionFile(sessionFile);
  const { messages, documentId, warning } = buildMessageArrayFromParsedSession(
    header,
    originalEntries,
    config
  );

  if (warning) {
    return warning;
  }

  if (messages.length === 0) {
    return "No messages to parse";
  }

  // Check retention state
  if (!shouldSessionBeRetained(originalEntries, config)) {
    return "Session does not allow retention. Use /hindsight toggle-retain to enable retention.";
  }

  // Build tags from metadata
  const parsedMeta = getHindsightMeta(originalEntries);
  const sessionTags = parsedMeta?.tags ?? [];
  const sessionName = getSessionDisplayName(
    ctx.sessionManager.getSessionName.bind(ctx.sessionManager),
    ctx.sessionManager.getEntries.bind(ctx.sessionManager)
  );

  const parentSessionId = extractParentSessionId(header.parentSession);
  const tags = buildDocumentTags(header, config, { sessionTags, parentSessionId });
  const context = getHindsightContextFromEntries(originalEntries, config, sessionName);
  const parsedSession = {
    documentId,
    context,
    tags,
    timestamp: header.timestamp,
    messages,
    parsedAt: new Date().toISOString(),
    sessionId: header.id,
    parentSessionId,
  };

  // Write parsed session to disk for later review
  const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
  if (!existsSync(parsedDir)) {
    mkdirSync(parsedDir, { recursive: true });
  }
  const outputPath = join(parsedDir, `${header.id}.jsonl`);
  writeFileSync(outputPath, `${JSON.stringify(parsedSession)}\n`, "utf8");

  return { parsedSession, outputPath };
}

/**
 * Call client.retain with standard options (updateMode=replace, entities from config).
 * Throws on failure.
 */
export async function upsertToHindsight(
  client: HindsightClientWrapper,
  params: {
    content: string;
    documentId: string;
    context: string;
    timestamp: string;
    tags: string[];
    sessionId: string;
    parentSessionId?: string;
  },
  config: HindsightConfig,
  signal?: AbortSignal
): Promise<void> {
  // Expand placeholders in observation scopes
  const expandedScopes = expandSessionObservationScopes(
    config,
    params.sessionId,
    params.parentSessionId
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

/**
 * Parse the current session file and upsert to Hindsight in one step.
 *
 * Delegates to {@link parseCurrentSession} for parsing, then calls
 * {@link upsertToHindsight} and clears queued messages.
 * Returns a description of the result, or throws on error.
 */
export async function parseAndUpsertSession(
  ctx: ExtensionContext,
  config: HindsightConfig,
  client: HindsightClientWrapper
): Promise<string> {
  const result = parseCurrentSession(ctx, config);

  if (typeof result === "string") {
    return result;
  }

  const { parsedSession } = result;

  await upsertToHindsight(
    client,
    {
      content: JSON.stringify(parsedSession.messages),
      documentId: parsedSession.documentId,
      context: parsedSession.context,
      timestamp: parsedSession.timestamp,
      tags: parsedSession.tags,
      sessionId: parsedSession.sessionId,
      parentSessionId: parsedSession.parentSessionId,
    },
    config,
    ctx.signal
  );

  // Clear auto-queued messages to prevent duplication — the full session was just upserted
  // Note: Tool queue is NOT deleted because tool retains are separate documents
  // (raw content with their own tags/metadata), not included in the session upsert.
  deleteAutoQueue(parsedSession.sessionId);

  return `Parsed and upserted ${parsedSession.messages.length} messages`;
}
