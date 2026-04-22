/**
 * Session parsing and upsert subcommands.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import { flushQueues, getQueueCount } from "../retention";
import { extractParentSessionId, getSessionDisplayName } from "../utils";
import { parseAndUpsertSession, parseCurrentSession, upsertToHindsight } from "./utils";
import type { Subcommand } from "./types";

/**
 * Create the flush subcommand — flushes queued messages to Hindsight.
 *
 * Reads auto and tool queues for the current session and sends them
 * to Hindsight via {@link flushQueues}.
 */
export function createFlushSubcommand(
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Flush queued messages to Hindsight",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) {
        ctx.ui.notify("No active session", "error");
        return;
      }

      const count = getQueueCount(sessionId);
      if (count === 0) {
        ctx.ui.notify("No messages queued", "info");
        return;
      }

      const header = ctx.sessionManager.getHeader();
      const sessionName = getSessionDisplayName(
        ctx.sessionManager.getSessionName.bind(ctx.sessionManager),
        ctx.sessionManager.getEntries.bind(ctx.sessionManager)
      );
      const sessionStartTime = header?.timestamp || new Date().toISOString();
      const sessionCwd = header?.cwd || ctx.cwd;
      const parentSessionId = extractParentSessionId(header?.parentSession);
      const entries = ctx.sessionManager.getEntries();

      ctx.ui.notify(`Flushing ${count} messages...`, "info");

      const result = await flushQueues(
        sessionId,
        sessionName,
        sessionStartTime,
        sessionCwd,
        parentSessionId,
        config,
        client,
        ctx.signal,
        entries
      );

      if (result.success) {
        ctx.ui.notify(
          `Flushed ${result.autoCount} auto + ${result.toolCount} tool entries`,
          "info"
        );
      } else {
        ctx.ui.notify(`Flush failed: ${result.error}`, "error");
      }
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
      const result = parseCurrentSession(ctx, config);

      if (typeof result === "string") {
        // Error or early exit message from parsing
        ctx.ui.notify(result, result.includes("not allow") ? "warning" : "error");
        return;
      }

      ctx.ui.notify(`Parsed session saved to: ${result.outputPath}`, "info");
    },
  };
}

/**
 * Create the parse-and-upsert-session subcommand — parse and upsert the full session.
 *
 * Delegates to {@link parseAndUpsertSession} which handles parsing, queue clearing,
 * and retention in one step.
 */
export function createParseAndUpsertSessionSubcommand(
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Parse and upsert the full current session to Hindsight",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }

      try {
        const result = await parseAndUpsertSession(ctx, config, client);
        ctx.ui.notify(result, "info");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Parse-and-upsert failed: ${msg}`, "error");
      }
    },
  };
}

/**
 * Create the upsert-all-parsed subcommand — upsert all previously parsed sessions.
 *
 * Reads all `.jsonl` files from the parsed-sessions directory and upserts them
 * to Hindsight, including configured entities. Checks for abort between iterations.
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

      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      if (!existsSync(parsedDir)) {
        ctx.ui.notify("No parsed sessions found", "error");
        return;
      }

      const files = readdirSync(parsedDir).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) {
        ctx.ui.notify("No parsed sessions found", "error");
        return;
      }

      const answer = await ctx.ui.confirm(
        "Upsert all parsed sessions?",
        `This will upsert ${files.length} session(s) to Hindsight, which can take a long time and make many API requests. Continue?`
      );
      if (!answer) {
        ctx.ui.notify("Upsert cancelled", "info");
        return;
      }

      ctx.ui.notify(`Upserting ${files.length} parsed sessions...`, "info");

      let successCount = 0;
      let failCount = 0;
      const errors: string[] = [];

      for (const file of files) {
        // Check for abort between iterations
        if (ctx.signal?.aborted) break;

        const parsedPath = join(parsedDir, file);
        const sessionId = file.replace(".jsonl", "");

        try {
          const parsed = JSON.parse(readFileSync(parsedPath, "utf8"));
          if (!parsed.messages || !parsed.documentId) {
            throw new Error("Invalid session format: missing required fields");
          }
          await upsertToHindsight(
            client,
            {
              content: JSON.stringify(parsed.messages),
              documentId: parsed.documentId,
              context: parsed.context,
              timestamp: parsed.timestamp,
              tags: parsed.tags,
              sessionId: parsed.sessionId ?? sessionId,
              parentSessionId: parsed.parentSessionId,
            },
            config,
            ctx.signal
          );
          successCount++;
        } catch (e) {
          failCount++;
          const message = e instanceof Error ? e.message : String(e);
          errors.push(`${sessionId}: ${message}`);
        }
      }

      const aborted = ctx.signal?.aborted;
      const abortNote = aborted ? " (operation cancelled — partial results)" : "";

      if (failCount === 0) {
        ctx.ui.notify(`Successfully upserted ${successCount} sessions${abortNote}`, "info");
      } else {
        console.error("pi-hindsight: Upsert errors:", errors.join("; "));
        const sampleErrors = errors.slice(0, 3).join("; ");
        const suffix = errors.length > 3 ? `; and ${errors.length - 3} more` : "";
        ctx.ui.notify(
          `Upserted ${successCount} sessions, ${failCount} failed (${sampleErrors}${suffix})${abortNote}`,
          "error"
        );
      }
    },
  };
}
