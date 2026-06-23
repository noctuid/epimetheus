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
import { prefixLog } from "../constants";
import type { RecallMessageDetails } from "../index";
import { DEGRADED_REASON_PENDING, DegradedReasonKind, getDegradedReason } from "../runtime-state";
import { createDetachProjectNameSubcommand } from "./detach-project-name";
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
 * Build the manual-command blocked message, surfacing the specific degraded
 * reason when known (set by index.ts whenever readiness changes) and NEVER
 * falling back to an all-encompassing generic warning. Repeated on every
 * manual operational-command attempt (no dedup). Recovery advice is
 * cause-specific so it never tells the user to detach the project name when
 * the cause is actually a server/version or global-config issue.
 */
function blockedMessage(): string {
  return prefixLog(
    `operational commands ` +
      "(flush, parse-and-upsert-session, toggle-retain, ...) are blocked while in degraded mode." +
      `\n${degradedReasonSentence()}\n${degradedRecoveryAdvice()}`
  );
}

/**
 * The specific degraded reason as a finished sentence (or the internal
 * "startup readiness has not completed yet" fallback when no reason is
 * classified). Shared by the operational-command and popup block paths so the
 * popup message never uses the old generic "not ready" wording either.
 *
 * Causes that carry an `errors[]` (currently global-config) render them as a
 * bulleted list below the summary; the shared `epimetheus: ` log prefix is
 * stripped from each error here because it is redundant inside an
 * already-epimetheus-branded block message (and was previously duplicated
 * once per error in the joined string).
 */
function degradedReasonSentence(): string {
  const reason = getDegradedReason();
  if (reason?.errors && reason.errors.length > 0) {
    const bullets = reason.errors
      .map((e) => e.replace(/^epimetheus:\s*/, ""))
      .map((e) => `  - ${e}`)
      .join("\n");
    return `Reason: ${reason.message}:\n${bullets}`;
  }
  return `Reason: ${reason?.message ?? DEGRADED_REASON_PENDING}.`;
}

/**
 * Cause-specific recovery advice. NEVER suggests detach-project-name for a
 * server or global-config cause.
 */
function degradedRecoveryAdvice(): string {
  const reason = getDegradedReason();
  if (reason?.kind === DegradedReasonKind.ProjectName) {
    const configPath = reason.configPath ?? `${reason.cwd ?? "<cwd>"}/.pi/epimetheus/config.jsonc`;
    if (reason.projectNameRecovery === "fix-config") {
      return `Fix ${configPath} (see \`/hindsight config\` for details).`;
    }
    return `Run \`/hindsight detach-project-name\` to stop requiring it, or fix ${configPath}.`;
  }
  if (reason?.kind === DegradedReasonKind.GlobalConfig) {
    return (
      "Run `/hindsight config` to inspect the config source and validation " +
      "errors, then fix the global config file or environment variables."
    );
  }
  // Server/version unreachable/incompatible, or any other cause.
  return "Run `/hindsight status` for details, and `/reload` to retry after fixing the server or configuration.";
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
  /**
   * Operational subcommands that perform writes/network or queue work. These are
   * blocked (unavailable message, no side effects) until a healthy startup has
   * completed (`isReady()`). Diagnostic/display subcommands (`status`,
   * `config`, `toggle-display`, and the debug-only `active-tools`) remain
   * available even when not ready so users can inspect state and reason about
   * why the extension is unavailable.
   *
   * `detach-project-name` is intentionally NOT operational: it is the recovery
   * command for an active session that failed readiness because of an invalid
   * or missing cwd-local project name config. It must remain available even in
   * that failed state so the user can stop requiring the project name without
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
    "detach-project-name": createDetachProjectNameSubcommand(pi, config),
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

      // Block operational subcommands until the extension is operational.
      // Diagnostic/display subcommands (status, config, toggle-display,
      // active-tools, and the detach-project-name recovery command) remain
      // available so users can inspect why the extension is unavailable.
      //
      // Manual blocked attempts must REPEAT the reason on every invocation
      // (no dedup) and surface the specific degraded cause when known, so the
      // user is told exactly why this command is unavailable rather than a
      // generic catch-all. The reason lives in `runtime-state`'s
      // `degradedReason` slot, set by index.ts whenever readiness changes.
      if (OPERATIONAL_SUBCOMMANDS.has(subcommandName) && !isReady()) {
        ctx.ui.notify(blockedMessage(), "warning");
        return;
      }

      // `detach-project-name` is a recovery command for the project-name
      // degraded cause, so it stays available when that is the reason. But it
      // writes session metadata + a pending marker, so it must be blocked when
      // the degraded cause is global config or server/version — the fail-fast
      // bootstrap path promises no metadata/session-state/queue writes while
      // global config is invalid.
      if (
        subcommandName === "detach-project-name" &&
        !isReady() &&
        getDegradedReason()?.kind !== DegradedReasonKind.ProjectName
      ) {
        ctx.ui.notify(blockedMessage(), "warning");
        return;
      }

      // Commands that inspect the auto-recall cache are display-only but still
      // require operational auto-recall: degraded mode skips auto-recall, so
      // there is no current recall to inspect. They also require
      // `autoRecallEnabled` — without auto-recall, no recall is ever cached.
      if (AUTO_RECALL_CACHE_SUBCOMMANDS.has(subcommandName)) {
        if (!isReady()) {
          // Degraded mode skips auto-recall, so there is no current recall to
          // inspect. Surface the SPECIFIC degraded reason + cause-specific
          // recovery advice (shared with operational-command blocking) rather
          // than the old generic "not ready" wording.
          ctx.ui.notify(
            prefixLog(
              `Cannot pop up recall: auto-recall is skipped in degraded mode, ` +
                `so there is no recall to inspect. ${degradedReasonSentence()} ${degradedRecoveryAdvice()}`
            ),
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
