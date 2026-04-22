/**
 * Slash commands for pi-hindsight.
 *
 * Registers the `/hindsight` command with subcommands organized by concern:
 * - **status/config** — read-only inspection ({@link ./status.ts})
 * - **session** — parsing, flushing, upserting ({@link ./session.ts})
 * - **meta** — retention toggling, tags ({@link ./meta.ts})
 * - **recall** — display toggling, popup overlay ({@link ./recall.ts})
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import type { RecallMessageDetails } from "../index";
import {
  createRemoveTagSubcommand,
  createTagSubcommand,
  createToggleRetainSubcommand,
} from "./meta";
import { createPopupSubcommand, createToggleDisplaySubcommand } from "./recall";
import {
  createFlushSubcommand,
  createParseAndUpsertSessionSubcommand,
  createParseSessionSubcommand,
  createUpsertAllParsedSubcommand,
} from "./session";
import { createConfigSubcommand, createStatusSubcommand } from "./status";
import type { Subcommand } from "./types";

/**
 * Register the `/hindsight` command with all subcommands.
 *
 * @param pi - Extension API for registering commands and appending entries.
 * @param config - Resolved Hindsight configuration.
 * @param client - Hindsight client wrapper, or null if not configured.
 * @param getRecallDetails - Getter for the last recall details (cached per session).
 * @param getRecallDisplayOverride - Getter for the runtime display override.
 * @param setRecallDisplayOverride - Setter for the runtime display override.
 * @param configMeta - Metadata about config source (file path, env vars, warnings).
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
    flush: createFlushSubcommand(client, config),
    "parse-session": createParseSessionSubcommand(config),
    "parse-and-upsert-session": createParseAndUpsertSessionSubcommand(client, config),
    "upsert-all-parsed": createUpsertAllParsedSubcommand(client, config),
    "toggle-retain": createToggleRetainSubcommand(pi, client, config),
    tag: createTagSubcommand(pi),
    "remove-tag": createRemoveTagSubcommand(pi),
    "toggle-display": createToggleDisplaySubcommand(
      config,
      getRecallDisplayOverride,
      setRecallDisplayOverride
    ),
    popup: createPopupSubcommand(getRecallDetails),
    status: createStatusSubcommand(client, config, getRecallDetails),
    config: createConfigSubcommand(config, configMeta),
  };

  // Build subcommand list
  const subcommandNames = Object.keys(subcommands);
  const subcommandList = subcommandNames
    .map((name) => `  ${name} - ${subcommands[name]!.description}`)
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
          description: subcommands[name]!.description,
        }));

      return matching.length > 0 ? matching : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = args.trim().split(/\s+/);
      const subcommandName = parts[0] ?? "";
      const subArgs = parts.slice(1).join(" ");

      if (!subcommandName) {
        // No subcommand — show status
        await subcommands.status!.handler("", ctx);
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
