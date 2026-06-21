/**
 * `/hindsight detach-flush-config` subcommand.
 *
 * Stops the current session from requiring a cwd-local flush config. Appends a
 * new `hindsight-meta` entry with `usesProjectFlushConfig: false` (latest
 * metadata wins) and marks the session pending so the next flush re-runs with
 * the cwd-derived project name (basename, or git common dir for worktrees).
 *
 * The cwd-local flush config file at
 * `<cwd>/.pi/epimetheus/flush-config.jsonc|.json` is **not** deleted — only
 * this session's requirement is removed. Other sessions (and the file itself)
 * are untouched. Use a `cursor`/rm or `/hindsight detach-flush-config` separately
 * on any session you want to detach.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "../config";
import { getHindsightMeta, shouldSessionBeRetained, updateSessionMetadata } from "../meta";
import { touchPendingFlag } from "../queue";
import { setActiveSessionFlushReady } from "../runtime-state";
import { refreshToolVisibility } from "../tools";
import type { Subcommand } from "./types";

/**
 * Create the detach-flush-config subcommand.
 *
 * Confirms (because future flushes may derive a different project name and
 * thus produce different document tags / observation-scope linkage), appends
 * `usesProjectFlushConfig: false`, marks the session pending, and makes clear
 * the file is left in place.
 */
export function createDetachFlushConfigSubcommand(
  pi: ExtensionAPI,
  config: HindsightConfig
): Subcommand {
  return {
    description:
      "Stop requiring the cwd-local flush config for this session (does not delete the file)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const answer = await ctx.ui.confirm(
        "Detach the project-local flush config?",
        "This stops the current session from requiring a cwd-local flush config (its " +
          "usesProjectFlushConfig metadata is set to false, latest-wins). Future flushes " +
          "will derive the project name from the cwd (basename, or the git common dir " +
          "for worktrees), which may differ from the flush-config projectName and change " +
          "the document's project tag — pending work is queued for a re-flush. The flush " +
          "config file at <cwd>/.pi/epimetheus/ is NOT deleted. Continue?"
      );
      if (!answer) {
        ctx.ui.notify("Flush config not detached", "info");
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      const sessionId = ctx.sessionManager.getSessionId();
      const existingMeta = getHindsightMeta(entries);

      await updateSessionMetadata(
        pi,
        sessionId,
        entries,
        { usesProjectFlushConfig: false },
        config
      );

      if (sessionId) {
        const result = touchPendingFlag(sessionId, "detach-flush-config");
        if (!result.success) {
          ctx.ui.notify(`Failed to queue session for re-flush: ${result.error}`, "warning");
        }
      }

      // Detaching clears only the active-session flush-config failure. Tool
      // visibility still depends on the unified operational-ready state, so an
      // unrelated server/config failure keeps tools hidden.
      setActiveSessionFlushReady(true);
      const isRetained = shouldSessionBeRetained(entries, config);
      refreshToolVisibility(pi, isRetained);

      // Surface the prior state for context: if the session wasn't actually
      // marked as using flush config, detaching is a no-op future-proof mark.
      const wasMarked = existingMeta?.usesProjectFlushConfig === true;
      ctx.ui.notify(
        wasMarked
          ? "Detached flush config for this session. The project name will be derived from cwd on the next flush (pending work queued). The flush-config file was NOT deleted."
          : "Recorded usesProjectFlushConfig=false for this session (it was not flagged as using a flush config). Future flushes will derive the project name from cwd. The flush-config file was NOT deleted.",
        "info"
      );
    },
  };
}
