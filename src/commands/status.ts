/**
 * Status and config subcommands.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import type { RecallMessageDetails } from "../index";
import { getHindsightMeta, shouldSessionBeRetained } from "../meta";
import { findProjectConfigFile, resolveProjectConfig, resolveProjectName } from "../project-config";
import { getPendingWorkCount } from "../retention";
import { getHindsightCompatibilityError, MIN_HINDSIGHT_VERSION } from "../version";
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
      lines.push(`  Bank ID: ${config.bankId}`);
      if (client) {
        const healthResult = await client.healthCheck(ctx.signal);
        if (healthResult.success) {
          lines.push(`  Server: ${config.apiUrl} (reachable)`);

          const versionResult = await client.getServerVersion(ctx.signal);
          if (versionResult.success && versionResult.version) {
            const compatibilityError = getHindsightCompatibilityError(versionResult.version);
            const state = compatibilityError ? "incompatible" : "compatible";
            // `<` / `>=` reflects the server version vs. the required minimum.
            const rel = compatibilityError ? "<" : ">=";
            lines.push(
              `  Version: ${versionResult.version} (${rel}${MIN_HINDSIGHT_VERSION}, ${state})`
            );
          } else {
            lines.push(`  Version: unavailable (${versionResult.error ?? "unknown error"})`);
          }
        } else {
          lines.push(`  Server: ${config.apiUrl} (unreachable: ${healthResult.error})`);
        }
      } else {
        const server = config.apiUrl || "(not configured)";
        const state = config.apiUrl ? "not checked: config invalid" : "not configured";
        lines.push(`  Server: ${server} (${state})`);
      }

      // Session and queue info
      lines.push("\n== Session ==");
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

      // Session-specific project config diagnostics. These are unrelated to the
      // global config above: they describe how the *current* session's project
      // name will be resolved during a flush (its cwd-local project config,
      // metadata flag, and derived name). The project-local section mirrors the
      // main Config Source block above (file/presence/status + loaded
      // projectName or invalid reason).
      lines.push("\n== Session-Specific Project Config ==");
      const header = ctx.sessionManager?.getHeader?.();
      const sessionCwd = header?.cwd ?? ctx.cwd;
      lines.push(`  Session cwd: ${sessionCwd ?? "(none)"}`);

      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      const meta = getHindsightMeta(entries);
      const usesFlag = meta?.usesProjectConfig;
      const flagLabel =
        usesFlag === undefined
          ? "<unset>"
          : usesFlag
            ? "true (requires cwd-local project config)"
            : "false (detached)";
      lines.push(`  usesProjectConfig: ${flagLabel}`);

      // Project-local config file: path/presence/status + loaded projectName
      // (or invalid reason).
      const configPath = findProjectConfigFile(sessionCwd ?? "");
      if (configPath) {
        const loaded = resolveProjectConfig(sessionCwd ?? "");
        if (loaded.ok) {
          lines.push(`  Project-local config: ${configPath} (valid)`);
          lines.push(`    projectName: ${loaded.config.projectName}`);
        } else {
          lines.push(`  Project-local config: ${configPath} (invalid — ${loaded.error})`);
        }
        for (const w of loaded.warnings) lines.push(`    warning: ${w}`);
      } else {
        lines.push("  Project-local config: <missing>");
      }

      // Compact one-line resolution: what this session would use as the
      // project name. Avoid saying flush would proceed: project-name resolution
      // is only one prerequisite, and other flush guards may still block.
      const resolutionMarked = resolveProjectName(sessionCwd ?? "", usesFlag);
      if (resolutionMarked.ok) {
        lines.push(
          `  Project name: ${resolutionMarked.projectName} (source: ${resolutionMarked.source})`
        );
      } else {
        lines.push(`  Project name: (blocked) ${resolutionMarked.error}`);
        // When blocked by project-name resolution, pending work remains queued
        // for retry after the user fixes or detaches the project-local config.
        lines.push("  Flush: blocked — pending left queued");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  };
}
