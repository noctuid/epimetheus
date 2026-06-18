/**
 * Slash commands for pi-hindsight.
 *
 * Registers the `/hindsight` command with subcommands organized by concern:
 * - **status/config** — read-only inspection ({@link ./status.ts})
 * - **session** — parsing, flushing, upserting ({@link ./session.ts})
 * - **meta** — retention toggling, tags ({@link ./meta.ts})
 * - **recall** — display toggling, popup overlay ({@link ./recall.ts})
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import type { RecallMessageDetails } from "../index";
import {
  createExtraContextSubcommand,
  createRemoveTagSubcommand,
  createTagSubcommand,
  createToggleRetainSubcommand,
} from "./meta";
import { createPopupSubcommand, createToggleDisplaySubcommand } from "./recall";
import {
  createFlushPendingSubcommand,
  createFlushSubcommand,
  createParseAndUpsertSessionSubcommand,
  createParseSessionSubcommand,
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
 * @param getAutoRecallDisplayOverride - Getter for the runtime display override.
 * @param setAutoRecallDisplayOverride - Setter for the runtime display override.
 * @param configMeta - Metadata about config source (file path, env vars, warnings).
 */
export function registerCommands(
  pi: ExtensionAPI,
  config: HindsightConfig,
  client: HindsightClientWrapper | null,
  getRecallDetails: () => RecallMessageDetails | null,
  getAutoRecallDisplayOverride: () => boolean | null,
  setAutoRecallDisplayOverride: (value: boolean | null) => void,
  configMeta: {
    configPath?: string;
    envVars: string[];
    warning?: string;
    validationWarnings: string[];
  }
): void {
  const subcommands: Record<string, Subcommand> = {
    flush: createFlushSubcommand(client, config),
    "flush-pending": createFlushPendingSubcommand(client, config),
    "parse-session": createParseSessionSubcommand(config),
    "parse-and-upsert-session": createParseAndUpsertSessionSubcommand(client, config),
    ...(config.debug
      ? {
          "active-tools": {
            description: "Show currently active tool names (debug)",
            handler: async (_args: string, ctx: ExtensionContext) => {
              const activeTools = pi.getActiveTools();
              const hindsightTools = activeTools.filter((n) => n.startsWith("hindsight_"));
              const otherTools = activeTools.filter((n) => !n.startsWith("hindsight_"));
              ctx.ui.notify(
                `Active tools (${activeTools.length}):\n` +
                  `  hindsight: [${hindsightTools.join(", ") || "none"}]\n` +
                  `  other: [${otherTools.join(", ")}]`,
                "info"
              );
            },
          },
        }
      : {}),
    "toggle-retain": createToggleRetainSubcommand(pi, client, config),
    tag: createTagSubcommand(pi, config),
    "remove-tag": createRemoveTagSubcommand(pi, config),
    "set-extra-context": createExtraContextSubcommand(pi, config),
    "toggle-display": createToggleDisplaySubcommand(
      config,
      getAutoRecallDisplayOverride,
      setAutoRecallDisplayOverride
    ),
    popup: createPopupSubcommand(getRecallDetails),
    status: createStatusSubcommand(client, config, getRecallDetails),
    config: createConfigSubcommand(config, configMeta),
  };

  // Build subcommand list
  const subcommandNames = Object.keys(subcommands);
  const subcommandList = subcommandNames
    .map((name) => `  ${name} - ${subcommands[name]?.description ?? ""}`)
    .join("\n");

  /**
   * Return the index of the first whitespace character (space, tab, newline,
   * etc.) in `s`, or -1 when none is found. Used to split off the subcommand
   * token without collapsing or normalizing any internal whitespace in the
   * remaining argument string.
   */
  function searchFirstWhitespace(s: string): number {
    return s.search(/\s/);
  }

  pi.registerCommand("hindsight", {
    description: `Hindsight memory commands. Subcommands:\n${subcommandList}`,
    getArgumentCompletions: async (argumentPrefix: string) => {
      // Identify only the first token (the subcommand name) with whitespace;
      // do not collapse internal whitespace in the remaining argument prefix.
      const trimmedPrefix = argumentPrefix.trimStart();
      const firstSpace = searchFirstWhitespace(trimmedPrefix);
      const subcommandName = firstSpace === -1 ? trimmedPrefix : trimmedPrefix.slice(0, firstSpace);

      if (subcommandName && subcommands[subcommandName]) {
        const subcommand = subcommands[subcommandName];
        if (subcommand.getArgumentCompletions) {
          // Drop the subcommand name, then trim only leading whitespace before
          // the remaining argument prefix (internal whitespace preserved).
          const subArgPrefix = trimmedPrefix.slice(subcommandName.length).trimStart();
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
          description: subcommands[name]?.description ?? "",
        }));

      return matching.length > 0 ? matching : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      // Identify the subcommand name using only the first run of whitespace;
      // preserve internal whitespace/newlines in the remaining argument
      // string exactly. The subcommand handler trims its own boundaries.
      const trimmedArgs = args.trimStart();
      const firstSpace = searchFirstWhitespace(trimmedArgs);
      const subcommandName = firstSpace === -1 ? trimmedArgs : trimmedArgs.slice(0, firstSpace);
      const subArgs = firstSpace === -1 ? "" : trimmedArgs.slice(firstSpace + 1);

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
