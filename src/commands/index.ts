/**
 * Slash commands for epimetheus.
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
import { EXTENSION_ID } from "../constants";
import type { RecallMessageDetails } from "../index";
import { createDetachFlushConfigSubcommand } from "./detach-flush-config";
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

// Whether the not-ready warning has been shown this process. Resets on
// /reload (module re-import) and from index.ts's test reset hook. Avoids
// spamming the same unavailable warning on repeated blocked operational
// commands while startup hasn't completed.
let notReadyWarned = false;

/** Reset module-level command state. Exported for tests via index.ts._resetState(). */
export function resetNotReadyWarned(): void {
  notReadyWarned = false;
}

/**
 * Register the `/hindsight` command with all subcommands.
 *
 * @param pi - Extension API for registering commands and appending entries.
 * @param config - Resolved Hindsight configuration.
 * @param client - Hindsight client wrapper, or null if not configured.
 * @param getRecallDetails - Getter for the last recall details (cached per session).
 * @param getAutoRecallDisplayOverride - Getter for the runtime display override.
 * @param setAutoRecallDisplayOverride - Setter for the runtime display override.
 * @param isReady - Getter returning whether startup health + version checks have
 *   passed. Operational subcommands are blocked (with an unavailable message and
 *   no writes/network) while not ready; diagnostic/display subcommands keep
 *   working even when not ready.
 * @param configMeta - Metadata about config source (file path, env vars, warnings).
 */
export function registerCommands(
  pi: ExtensionAPI,
  config: HindsightConfig,
  client: HindsightClientWrapper | null,
  getRecallDetails: () => RecallMessageDetails | null,
  getAutoRecallDisplayOverride: () => boolean | null,
  setAutoRecallDisplayOverride: (value: boolean | null) => void,
  isReady: () => boolean,
  configMeta: {
    configPath?: string;
    envVars: string[];
    warning?: string;
    validationWarnings: string[];
  }
): void {
  // Reset the not-ready dedup flag on each (re)registration: in production this
  // is once per extension load (resets on /reload); in tests, once per
  // extension.default(pi), so each test starts with a fresh warning.
  resetNotReadyWarned();

  /**
   * Operational subcommands that perform writes/network or queue work. These are
   * blocked (unavailable message, no side effects) until a healthy startup has
   * completed (`isReady()`). Diagnostic/display subcommands (`status`,
   * `config`, `toggle-display`, and the debug-only `active-tools`) remain
   * available even when not ready so users can inspect state and reason about
   * why the extension is unavailable.
   *
   * `detach-flush-config` is intentionally NOT operational: it is the recovery
   * command for an active session that failed readiness because of an invalid
   * or missing cwd-local flush config. It must remain available even in that
   * failed state so the user can stop requiring the flush config without
   * manually editing the session file. It only writes session metadata + a
   * pending marker (no client/network), so running it while not ready is safe.
   *
   * `popup` is display-only but gated separately (see the handler): degraded
   * mode skips auto-recall, so there is no current recall to inspect; it also
   * requires `autoRecallEnabled`.
   */
  const OPERATIONAL_SUBCOMMANDS = new Set([
    "flush",
    "flush-pending",
    "parse-session",
    "parse-and-upsert-session",
    "toggle-retain",
    "tag",
    "remove-tag",
    "set-extra-context",
  ]);

  // Display-only, but only meaningful when auto-recall can run and cache a
  // current recall. Kept out of OPERATIONAL_SUBCOMMANDS so it gets a specific
  // user-facing explanation instead of the generic operational-command warning.
  const AUTO_RECALL_CACHE_SUBCOMMANDS = new Set(["popup"]);

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
    "detach-flush-config": createDetachFlushConfigSubcommand(pi, config),
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

      // Block operational subcommands until a healthy startup completes.
      // Diagnostic/display subcommands (status, config, toggle-display,
      // active-tools, and the detach-flush-config recovery command) remain
      // available so users can inspect why the extension is unavailable.
      if (OPERATIONAL_SUBCOMMANDS.has(subcommandName) && !isReady()) {
        // Surface the full reason once per process; subsequent blocked attempts
        // stay quiet so repeated commands while unhealthy don't spam.
        if (!notReadyWarned) {
          notReadyWarned = true;
          ctx.ui.notify(
            `${EXTENSION_ID} is not ready (startup checks have not completed, the ` +
              `server is unreachable/incompatible, or the active session's ` +
              `project-local flush config is required-but-missing/invalid). ` +
              `Operational commands (flush, parse-and-upsert-session, toggle-retain, ...) ` +
              `are unavailable until startup succeeds and the active session's ` +
              `flush config is valid or detached via \`/hindsight detach-flush-config\`. ` +
              `Run \`/hindsight status\` for details.`,
            "warning"
          );
        }
        return;
      }

      // Commands that inspect the auto-recall cache are display-only but still
      // require operational auto-recall: degraded mode skips auto-recall, so
      // there is no current recall to inspect. They also require
      // `autoRecallEnabled` — without auto-recall, no recall is ever cached.
      if (AUTO_RECALL_CACHE_SUBCOMMANDS.has(subcommandName)) {
        if (!isReady()) {
          ctx.ui.notify(
            `${EXTENSION_ID} is not ready; auto-recall is skipped in degraded mode, ` +
              `so there is no recall to inspect. Run \`/hindsight status\` for details.`,
            "info"
          );
          return;
        }
        if (!config.autoRecallEnabled) {
          ctx.ui.notify(
            "Cannot pop up recall: autoRecallEnabled is false (no recall is cached).",
            "info"
          );
          return;
        }
      }

      await subcommand.handler(subArgs, ctx);
    },
  });
}
