/**
 * Status and config subcommands.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import type { RecallMessageDetails } from "../index";
import { getHindsightMeta, shouldSessionBeRetained } from "../meta";
import { getPendingWorkCount } from "../retention";
import type { Subcommand } from "./types";

/**
 * Create the status subcommand — shows operational status.
 *
 * Displays connection health, session info (ID, retention, tags, queue count),
 * last recall details, and feature flags.
 */
export function createStatusSubcommand(
  client: HindsightClientWrapper | null,
  config: HindsightConfig,
  getRecallDetails: () => RecallMessageDetails | null
): Subcommand {
  return {
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

      // Session and queue info
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
      if (sessionId) {
        const queueCount = getPendingWorkCount(sessionId);
        lines.push(`  Queued documents: ${queueCount}`);
      }

      // Extra context
      lines.push("\n== Extra Context ==");
      const extraContext = meta?.extraContext;
      lines.push(
        extraContext !== undefined
          ? extraContext || "(empty — no extra context needed, flush guard satisfied)"
          : "(not set)"
      );

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
      lines.push(`  Auto-flush session on: ${config.autoFlushSessionOn.join(", ") || "(none)"}`);
      lines.push(`  Auto-flush pending on: ${config.autoFlushPendingOn.join(", ") || "(none)"}`);
      lines.push(
        `  Require extra context: ${config.requireExtraContextBeforeFlush ? "enabled" : "disabled"}`
      );

      // Active recall settings
      lines.push("\n== Auto Recall Settings ==");
      lines.push(`  Persist: ${config.autoRecallPersist}`);
      lines.push(`  Display: ${config.autoRecallDisplay}`);
      lines.push(`  Types: ${config.autoRecallTypes ? config.autoRecallTypes.join(", ") : "all"}`);
      lines.push(`  Budget: ${config.autoRecallBudget}`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  };
}

/**
 * Create the config subcommand — shows configuration source and values.
 *
 * Displays the config file path, environment variables, masked config values,
 * and any load/validation warnings.
 */
export function createConfigSubcommand(
  config: HindsightConfig,
  configMeta: {
    configPath?: string;
    envVars: string[];
    warning?: string;
    validationWarnings: string[];
  }
): Subcommand {
  return {
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
  };
}
