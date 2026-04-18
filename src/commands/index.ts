/**
 * Slash commands for pi-hindsight.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HindsightConfig } from "../config";
import type { HindsightClientWrapper } from "../client";
import type { RecallMessageDetails } from "../index";
import { flushQueues, getQueueCount } from "../retention";
import { getSessionDisplayName } from "../utils";
import { RecallOverlayComponent } from "../overlay";

/**
 * Register all slash commands.
 */
export function registerCommands(
  pi: ExtensionAPI,
  config: HindsightConfig,
  client: HindsightClientWrapper | null,
  getRecallDetails: () => RecallMessageDetails | null,
  getRecallDisplayOverride: () => boolean | null,
  setRecallDisplayOverride: (value: boolean | null) => void,
): void {
  // /hindsight-flush - Flush current session's queue
  pi.registerCommand("hindsight-flush", {
    description: "Flush queued messages to Hindsight",
    handler: async (args: string, ctx: ExtensionContext) => {
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
        ctx.sessionManager.getEntries.bind(ctx.sessionManager),
      );
      const sessionStartTime = header?.timestamp || new Date().toISOString();
      const sessionCwd = header?.cwd || ctx.cwd;
      const parentSessionId = header?.parentSession;

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
      );

      if (result.success) {
        ctx.ui.notify(`Flushed ${result.autoCount} auto + ${result.toolCount} tool entries`, "info");
      } else {
        ctx.ui.notify(`Flush failed: ${result.error}`, "error");
      }
    },
  });

  // /hindsight-parse-session - Parse current session to file
  pi.registerCommand("hindsight-parse-session", {
    description: "Parse current session to file for manual review",
    handler: async (args: string, ctx: ExtensionContext) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || !existsSync(sessionFile)) {
        ctx.ui.notify("No session file found", "error");
        return;
      }

      const { parseSessionFile, buildDocumentTags, getHindsightContext, buildMessageArrayFromSession } = await import("../document");

      const { header } = parseSessionFile(sessionFile);

      // Build messages with fork detection
      const { messages, documentId, warning } = buildMessageArrayFromSession(sessionFile, config);

      if (messages.length === 0) {
        ctx.ui.notify("No messages to parse" + (warning ? ` (${warning})` : ""), "warning");
        return;
      }

      const sessionName = getSessionDisplayName(
        ctx.sessionManager.getSessionName.bind(ctx.sessionManager),
        ctx.sessionManager.getEntries.bind(ctx.sessionManager),
      );

      // Build output - matches Hindsight retain API structure (minus updateMode)
      const parsedSession: {
        documentId: string;
        context: string;
        tags: string[];
        timestamp: string;
        messages: object[];
        parsedAt: string;
        warning?: string;
      } = {
        documentId,
        context: getHindsightContext(sessionFile, config, sessionName),
        tags: buildDocumentTags(header, config),
        timestamp: header.timestamp,
        messages,
        parsedAt: new Date().toISOString(),
      };

      if (warning) {
        parsedSession.warning = warning;
      }

      // Write to parsed-sessions directory
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      if (!existsSync(parsedDir)) {
        mkdirSync(parsedDir, { recursive: true });
      }

      const outputPath = join(parsedDir, `${header.id}.jsonl`);
      writeFileSync(outputPath, JSON.stringify(parsedSession) + "\n", "utf8");

      ctx.ui.notify(`Parsed session saved to: ${outputPath}`, "info");
    },
  });

  // /hindsight-upsert-parsed-session - Upsert a parsed session
  pi.registerCommand("hindsight-upsert-parsed-session", {
    description: "Upsert a parsed session to Hindsight",
    getArgumentCompletions: (argumentPrefix: string) => {
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      if (!existsSync(parsedDir)) return null;

      const files = readdirSync(parsedDir)
        .filter((f) => f.endsWith(".jsonl") && f.includes(argumentPrefix))
        .map((f) => ({ label: f.replace(".jsonl", ""), value: f.replace(".jsonl", "") }));

      return files.length > 0 ? files : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }

      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      let sessionId = args.trim();

      // List available sessions if no ID provided
      if (!sessionId) {
        if (!existsSync(parsedDir)) {
          ctx.ui.notify("No parsed sessions found", "error");
          return;
        }

        const files = readdirSync(parsedDir).filter((f) => f.endsWith(".jsonl"));
        if (files.length === 0) {
          ctx.ui.notify("No parsed sessions found", "error");
          return;
        }

        // Use select to let user pick
        const options = files.map((f) => f.replace(".jsonl", ""));
        const answer = await ctx.ui.select("Select session to upsert:", options);

        if (!answer) {
          return;
        }
        sessionId = answer;
      }

      const parsedPath = join(parsedDir, sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`);
      if (!existsSync(parsedPath)) {
        ctx.ui.notify(`Parsed session not found: ${sessionId}`, "error");
        return;
      }

      const parsed = JSON.parse(readFileSync(parsedPath, "utf8"));

      ctx.ui.notify(`Upserting session ${sessionId}...`, "info");

      const content = JSON.stringify(parsed.messages);
      const result = await client.retain(
        {
          content,
          documentId: parsed.documentId,
          context: parsed.context,
          timestamp: parsed.timestamp,
          tags: parsed.tags,
          updateMode: "replace",
          entities: config.entities.length > 0 ? config.entities : undefined,
        },
        ctx.signal,
      );

      if (result.success) {
        ctx.ui.notify(`Session ${sessionId} upserted successfully`, "info");
      } else {
        ctx.ui.notify(`Upsert failed: ${result.error}`, "error");
      }
    },
  });

  // /hindsight-upsert-all-parsed - Upsert all parsed sessions
  pi.registerCommand("hindsight-upsert-all-parsed", {
    description: "Upsert all parsed sessions to Hindsight",
    handler: async (args: string, ctx: ExtensionContext) => {
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

      ctx.ui.notify(`Upserting ${files.length} parsed sessions...`, "info");

      let successCount = 0;
      let failCount = 0;
      const errors: string[] = [];

      for (const file of files) {
        const parsedPath = join(parsedDir, file);
        const sessionId = file.replace(".jsonl", "");

        try {
          const parsed = JSON.parse(readFileSync(parsedPath, "utf8"));
          const content = JSON.stringify(parsed.messages);
          const result = await client.retain(
            {
              content,
              documentId: parsed.documentId,
              context: parsed.context,
              timestamp: parsed.timestamp,
              tags: parsed.tags,
              updateMode: "replace",
            },
            ctx.signal,
          );

          if (result.success) {
            successCount++;
          } else {
            failCount++;
            errors.push(`${sessionId}: ${result.error}`);
          }
        } catch (e) {
          failCount++;
          const message = e instanceof Error ? e.message : String(e);
          errors.push(`${sessionId}: ${message}`);
        }
      }

      if (failCount === 0) {
        ctx.ui.notify(`Successfully upserted ${successCount} sessions`, "info");
      } else {
        console.error("pi-hindsight: Upsert errors:", errors.join("; "));
        ctx.ui.notify(`Upserted ${successCount} sessions, ${failCount} failed`, "error");
      }
    },
  });

  // /hindsight-queue-status - Show queue status
  pi.registerCommand("hindsight-queue-status", {
    description: "Show queued message count",
    handler: async (args: string, ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) {
        ctx.ui.notify("No active session", "error");
        return;
      }

      const count = getQueueCount(sessionId);
      ctx.ui.notify(`${count} messages queued`, "info");
    },
  });

  // /hindsight-toggle-display - Toggle recall message display
  pi.registerCommand("hindsight-toggle-display", {
    description: "Toggle recall message display",
    handler: async (_args: string, ctx: ExtensionContext) => {
      // Cannot toggle when recallPersist is false (context event never shows in TUI)
      if (!config.recallPersist) {
        ctx.ui.notify("Cannot toggle display: recallPersist is false (context event never shows in TUI)", "warning");
        return;
      }
      // Toggle from current state (default from config)
      const currentState = getRecallDisplayOverride() ?? config.recallDisplay;
      setRecallDisplayOverride(!currentState);
      ctx.ui.notify(`Recall display: ${!currentState ? "visible" : "hidden"}`, "info");
    },
  });

  // /hindsight-popup - Pop up last recalled messages in overlay
  pi.registerCommand("hindsight-popup", {
    description: "Pop up last recalled messages in overlay",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const recallDetails = getRecallDetails();
      if (recallDetails === null) {
        ctx.ui.notify("No recall this session", "info");
        return;
      }

      // Show recall in overlay popup
      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => new RecallOverlayComponent(theme, recallDetails, done, { maxHeight: 30 }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: 80, maxHeight: 30 },
        },
      );
    },
  });
}
