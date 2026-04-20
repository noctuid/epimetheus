/**
 * Slash commands for pi-hindsight.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import type { RecallMessageDetails } from "../index";
import { buildDocumentTags, buildMessageArrayFromSession, getHindsightContext, parseSessionFile } from "../document";
import { getHindsightMeta, shouldSessionBeRetained, type HindsightMeta } from "../meta";
import { RecallOverlayComponent } from "../overlay";
import { flushQueues, getQueueCount } from "../retention";
import { deleteAutoQueue, deleteToolQueue } from "../queue";
import { getSessionDisplayName } from "../utils";

interface Subcommand {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  getArgumentCompletions?: (
    argumentPrefix: string
  ) => Promise<Array<{ label: string; value: string }> | null>;
}

/**
 * Call client.retain with standard options (updateMode=replace, entities from config).
 * Throws on failure.
 */
async function upsertToHindsight(
  client: HindsightClientWrapper,
  params: {
    content: string;
    documentId: string;
    context: string;
    timestamp: string;
    tags: string[];
  },
  config: HindsightConfig,
  signal: unknown
): Promise<void> {
  const result = await client.retain(
    {
      content: params.content,
      documentId: params.documentId,
      context: params.context,
      timestamp: params.timestamp,
      tags: params.tags,
      updateMode: "replace",
      entities: config.entities.length > 0 ? config.entities : undefined,
    },
    signal
  );

  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
}

/**
 * Parse the current session file and upsert to Hindsight in one step.
 * Also writes the parsed session to the parsed-sessions directory on disk
 * so the user can review it afterward.
 * Returns a description of the result, or throws on error.
 */
async function parseAndUpsertSession(
  ctx: ExtensionContext,
  config: HindsightConfig,
  client: HindsightClientWrapper
): Promise<string> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile || !existsSync(sessionFile)) {
    return "No session file found";
  }

  const { header, entries: originalEntries } = parseSessionFile(sessionFile);
  const { messages, documentId, warning } = buildMessageArrayFromSession(sessionFile, config);

  if (messages.length === 0) {
    return "No messages to parse";
  }

  if (warning) {
    return warning;
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

  const tags = buildDocumentTags(header, config, { sessionTags });
  const context = getHindsightContext(sessionFile, config, sessionName);

  // Write parsed session to disk for later review
  const parsedSession = {
    documentId,
    context,
    tags,
    timestamp: header.timestamp,
    messages,
    parsedAt: new Date().toISOString(),
  };
  const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
  if (!existsSync(parsedDir)) {
    mkdirSync(parsedDir, { recursive: true });
  }
  writeFileSync(join(parsedDir, `${header.id}.jsonl`), `${JSON.stringify(parsedSession)}\n`, "utf8");

  // Clear queued messages to prevent duplication — the full session was just upserted
  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionId) {
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);
  }

  await upsertToHindsight(
    client,
    {
      content: JSON.stringify(messages),
      documentId,
      context,
      timestamp: header.timestamp,
      tags,
    },
    config,
    ctx.signal
  );

  return `Parsed and upserted ${messages.length} messages`;
}

/**
 * Register the /hindsight command with subcommands.
 */
export function registerCommands(
  pi: ExtensionAPI,
  config: HindsightConfig,
  client: HindsightClientWrapper | null,
  getRecallDetails: () => RecallMessageDetails | null,
  getRecallDisplayOverride: () => boolean | null,
  setRecallDisplayOverride: (value: boolean | null) => void,
  configMeta: {
    configPath?: string;
    envVars: string[];
    warning?: string;
    validationWarnings: string[];
  }
): void {
  const subcommands: Record<string, Subcommand> = {
    flush: {
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
        const parentSessionId = header?.parentSession;
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
    },

    "parse-session": {
      description: "Parse current session to file for manual review",
      handler: async (_args: string, ctx: ExtensionContext) => {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile || !existsSync(sessionFile)) {
          ctx.ui.notify("No session file found", "error");
          return;
        }

        const { header, entries: originalEntries } = parseSessionFile(sessionFile);

        // Build messages with fork detection
        const { messages, documentId, warning } = buildMessageArrayFromSession(sessionFile, config);

        if (messages.length === 0) {
          ctx.ui.notify(`No messages to parse${warning ? ` (${warning})` : ""}`, "warning");
          return;
        }

        // Get session tags from metadata
        const parsedMeta = getHindsightMeta(originalEntries);
        const sessionTags = parsedMeta?.tags ?? [];

        const sessionName = getSessionDisplayName(
          ctx.sessionManager.getSessionName.bind(ctx.sessionManager),
          ctx.sessionManager.getEntries.bind(ctx.sessionManager)
        );

        // Check retention state — skip if session is not retained
        if (!shouldSessionBeRetained(originalEntries, config)) {
          ctx.ui.notify(
            "Session does not allow retention. Use /hindsight toggle-retain to enable retention.",
            "warning"
          );
          return;
        }

        // Build output - matches Hindsight retain API structure (minus updateMode)
        const parsedSession: {
          documentId: string;
          context: string;
          tags: string[];
          timestamp: string;
          messages: object[];
          parsedAt: string;
        } = {
          documentId,
          context: getHindsightContext(sessionFile, config, sessionName),
          tags: buildDocumentTags(header, config, { sessionTags }),
          timestamp: header.timestamp,
          messages,
          parsedAt: new Date().toISOString(),
        };

        // Write to parsed-sessions directory
        const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
        if (!existsSync(parsedDir)) {
          mkdirSync(parsedDir, { recursive: true });
        }

        const outputPath = join(parsedDir, `${header.id}.jsonl`);
        writeFileSync(outputPath, `${JSON.stringify(parsedSession)}\n`, "utf8");

        ctx.ui.notify(`Parsed session saved to: ${outputPath}`, "info");
      },
    },

    "parse-and-upsert-session": {
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
    },

    "upsert-all-parsed": {
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
              ctx.signal
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
    },

    "queue-status": {
      description: "Show queued message count",
      handler: async (_args: string, ctx: ExtensionContext) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (!sessionId) {
          ctx.ui.notify("No active session", "error");
          return;
        }

        const count = getQueueCount(sessionId);
        ctx.ui.notify(`${count} messages queued`, "info");
      },
    },

    "toggle-retain": {
      description: "Toggle whether the current session should be retained",
      handler: async (_args: string, ctx: ExtensionContext) => {
        if (!client) {
          ctx.ui.notify("Hindsight not configured", "error");
          return;
        }

        const entries = ctx.sessionManager.getEntries();
        const currentRetained = shouldSessionBeRetained(entries, config);
        const newShouldRetain = !currentRetained;

        const sessionId = ctx.sessionManager.getSessionId();

        if (newShouldRetain) {
          // Toggling ON: ask if user wants to parse-and-upsert first so the
          // full session content is retained (newly queued messages append correctly)
          const answer = await ctx.ui.confirm(
            "Enable retention?",
            "Parse and upsert the full session before enabling retention? This ensures the full conversation is retained."
          );

          if (!answer) {
            ctx.ui.notify(
              "Retention not enabled. Use /hindsight toggle-retain again to enable.",
              "info"
            );
            return;
          }

          // Build new meta, preserving existing tags
          const existingMeta = getHindsightMeta(entries);
          const meta: HindsightMeta = {
            retained: true,
            ...(existingMeta?.tags ? { tags: existingMeta.tags } : {}),
          };
          pi.appendEntry("hindsight-meta", meta);

          // Delete any existing queue files
          if (sessionId) {
            deleteAutoQueue(sessionId);
            deleteToolQueue(sessionId);
          }

          // Parse and upsert the full session
          try {
            const result = await parseAndUpsertSession(ctx, config, client);
            ctx.ui.notify(`Session retention: enabled. ${result}.`, "info");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(
              `Session retention: enabled, but parse-and-upsert failed: ${msg}`,
              "warning"
            );
          }
        } else {
          // Toggling OFF: build new meta, preserving existing tags
          const existingMeta = getHindsightMeta(entries);
          const meta: HindsightMeta = {
            retained: false,
            ...(existingMeta?.tags ? { tags: existingMeta.tags } : {}),
          };
          pi.appendEntry("hindsight-meta", meta);

          // Delete queue files so queued messages will NOT be flushed
          if (sessionId) {
            deleteAutoQueue(sessionId);
            deleteToolQueue(sessionId);
          }

          ctx.ui.notify("Session retention: disabled (will be ignored)", "info");
        }
      },
    },

    tag: {
      description: "Add a tag to session metadata",
      handler: async (args: string, ctx: ExtensionContext) => {
        const tag = args.trim();
        if (!tag) {
          ctx.ui.notify("Usage: /hindsight tag <tag>", "warning");
          return;
        }

        const entries = ctx.sessionManager.getEntries();
        const existingMeta = getHindsightMeta(entries);
        const tags = [...(existingMeta?.tags ?? [])];

        if (tags.includes(tag)) {
          ctx.ui.notify(`Tag "${tag}" already exists`, "warning");
          return;
        }

        tags.push(tag);

        const meta: HindsightMeta = {
          ...(existingMeta?.retained !== undefined ? { retained: existingMeta.retained } : {}),
          tags,
        };

        pi.appendEntry("hindsight-meta", meta);
        ctx.ui.notify(`Tag "${tag}" added`, "info");
      },
    },

    "remove-tag": {
      description: "Remove a tag from session metadata",
      handler: async (args: string, ctx: ExtensionContext) => {
        const tag = args.trim();
        if (!tag) {
          ctx.ui.notify("Usage: /hindsight remove-tag <tag>", "warning");
          return;
        }

        const entries = ctx.sessionManager.getEntries();
        const existingMeta = getHindsightMeta(entries);
        const tags = [...(existingMeta?.tags ?? [])];

        const index = tags.indexOf(tag);
        if (index === -1) {
          ctx.ui.notify(`Tag "${tag}" not found`, "warning");
          return;
        }

        tags.splice(index, 1);

        const meta: HindsightMeta = {
          ...(existingMeta?.retained !== undefined ? { retained: existingMeta.retained } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        };

        pi.appendEntry("hindsight-meta", meta);
        ctx.ui.notify(`Tag "${tag}" removed`, "info");
      },
    },

    "toggle-display": {
      description: "Toggle recall message display",
      handler: async (_args: string, ctx: ExtensionContext) => {
        // Cannot toggle when recallPersist is false (context event never shows in TUI)
        if (!config.recallPersist) {
          ctx.ui.notify(
            "Cannot toggle display: recallPersist is false (context event never shows in TUI)",
            "warning"
          );
          return;
        }
        // Toggle from current state (default from config)
        const currentState = getRecallDisplayOverride() ?? config.recallDisplay;
        setRecallDisplayOverride(!currentState);
        ctx.ui.notify(`Recall display: ${!currentState ? "visible" : "hidden"}`, "info");
      },
    },

    popup: {
      description: "Pop up last recalled messages in overlay",
      handler: async (_args: string, ctx: ExtensionContext) => {
        const recallDetails = getRecallDetails();
        if (recallDetails === null) {
          ctx.ui.notify("No recall this session", "info");
          return;
        }

        // Show recall in overlay popup
        await ctx.ui.custom<void>(
          (_tui, theme, _keybindings, done) =>
            new RecallOverlayComponent(theme, recallDetails, done, { maxHeight: 30 }),
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: 80, maxHeight: 30 },
          }
        );
      },
    },

    status: {
      description: "Show operational status (connection, session, recall)",
      handler: async (_args: string, ctx: ExtensionContext) => {
        const lines: string[] = [];

        // Connection status
        lines.push("== Connection ==");
        if (client) {
          const healthResult = await client.healthCheck(ctx.signal);
          if (healthResult.success) {
            lines.push("  Server: reachable");
          } else {
            lines.push(`  Server: unreachable (${healthResult.error})`);
          }
        } else {
          lines.push("  Server: not configured");
        }

        // Bank and session info
        lines.push("\n== Session ==");
        lines.push(`  Bank ID: ${config.bankId}`);
        const sessionId = ctx.sessionManager.getSessionId();
        lines.push(`  Session ID: ${sessionId ?? "none"}`);

        // Retention state and tags
        const sessionEntries = ctx.sessionManager.getEntries();
        const retained = shouldSessionBeRetained(sessionEntries, config);
        lines.push(`  Retained: ${retained ? "yes" : "no"}`);
        const meta = getHindsightMeta(sessionEntries);
        const tags = meta?.tags ?? [];
        lines.push(`  Tags: ${tags.length > 0 ? tags.join(", ") : "none"}`);

        // Last recall status
        lines.push("\n== Last Recall ==");
        const recallDetails = getRecallDetails();
        if (recallDetails) {
          lines.push(`  Memories: ${recallDetails.count}`);
          lines.push(
            `  Snippet: ${recallDetails.snippet.slice(0, 60)}${recallDetails.snippet.length > 60 ? "..." : ""}`
          );
        } else {
          lines.push("  No recall this session");
        }

        // Feature flags
        lines.push("\n== Features ==");
        lines.push(`  Auto-recall: ${config.autoRecallEnabled ? "enabled" : "disabled"}`);
        lines.push(`  Auto-retain: ${config.autoRetainEnabled ? "enabled" : "disabled"}`);

        // Active recall settings
        lines.push("\n== Auto Recall Settings ==");
        lines.push(`  Persist: ${config.recallPersist}`);
        lines.push(`  Display: ${config.recallDisplay}`);
        lines.push(`  Types: ${config.recallTypes ? config.recallTypes.join(", ") : "all"}`);
        lines.push(`  Budget: ${config.autoRecallBudget}`);

        ctx.ui.notify(lines.join("\n"), "info");
      },
    },

    config: {
      description: "Show configuration (file path, env vars, masked config)",
      handler: async (_args: string, ctx: ExtensionContext) => {
        const lines: string[] = [];

        // Config file path
        lines.push("== Config Source ==");
        lines.push(`  File: ${configMeta.configPath ?? "none (using defaults)"}`);

        // Environment variables
        lines.push("\n== Environment Variables ==");
        if (configMeta.envVars.length > 0) {
          lines.push(`  Set: ${configMeta.envVars.join(", ")}`);
        } else {
          lines.push("  None set");
        }

        // Full config (mask apiKey)
        lines.push("\n== Configuration ==");
        const maskedConfig = {
          ...config,
          apiKey: config.apiKey
            ? config.apiKey.length > 4
              ? `****${config.apiKey.slice(-4)}`
              : "****"
            : "(not set)",
        };
        lines.push(
          JSON.stringify(maskedConfig, null, 2)
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n")
        );

        // Warnings at the end
        lines.push("\n== Warnings ==");
        const allWarnings: string[] = [];
        if (configMeta.warning) allWarnings.push(configMeta.warning);
        allWarnings.push(...configMeta.validationWarnings);
        if (allWarnings.length > 0) {
          for (const w of allWarnings) {
            lines.push(`  - ${w}`);
          }
        } else {
          lines.push("  None");
        }

        ctx.ui.notify(lines.join("\n"), "info");
      },
    },
  };

  // Build subcommand list
  const subcommandNames = Object.keys(subcommands);
  const subcommandList = subcommandNames
    .map((name) => `  ${name} - ${subcommands[name]?.description}`)
    .join("\n");

  pi.registerCommand("hindsight", {
    description: `Hindsight memory commands. Subcommands:\n${subcommandList}`,
    getArgumentCompletions: async (argumentPrefix: string) => {
      // If a subcommand is already selected, delegate to its completions
      const parts = argumentPrefix.split(/\s+/);
      const subcommandName = parts[0] ?? "";

      if (subcommandName && subcommands[subcommandName]) {
        const subcommand = subcommands[subcommandName];
        if (subcommand.getArgumentCompletions) {
          const subArgPrefix = argumentPrefix.slice(subcommandName.length).trimStart();
          return subcommand.getArgumentCompletions(subArgPrefix);
        }
        return null;
      }

      // Complete subcommand name
      const matching = subcommandNames
        .filter((name) => name.startsWith(subcommandName))
        .map((name) => ({
          label: name,
          value: name,
          description: subcommands[name]?.description,
        }));

      return matching.length > 0 ? matching : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = args.trim().split(/\s+/);
      const subcommandName = parts[0] ?? "";
      const subArgs = parts.slice(1).join(" ");

      if (!subcommandName) {
        // No subcommand — show status
        await subcommands.status?.handler("", ctx);
        return;
      }

      const subcommand = subcommands[subcommandName];
      if (!subcommand) {
        ctx.ui.notify(
          `Unknown subcommand: ${subcommandName}. Available: ${subcommandNames.join(", ")}`,
          "error"
        );
        return;
      }

      await subcommand.handler(subArgs, ctx);
    },
  });
}
