/**
 * `/hindsight detach-project-name` subcommand.
 *
 * Stops the current session from requiring the cwd-local projectName override.
 * Appends a new `hindsight-meta` entry with `usesProjectConfig: false` (latest
 * metadata wins) and marks the session pending so the next flush re-runs with
 * the cwd-derived project name (basename, or git common dir for worktrees).
 *
 * The cwd-local config file at `<cwd>/.pi/epimetheus/config.jsonc|.json` is
 * **not** deleted — only this session's projectName requirement is removed.
 * Other sessions (and the file itself) are untouched. Use a `cursor`/rm or
 * `/hindsight detach-project-name` separately on any session you want to detach.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "../config";
import { STATUS_ID } from "../constants";
import { getHindsightMeta, shouldSessionBeRetained, updateSessionMetadata } from "../meta";
import { touchPendingFlag } from "../queue";
import {
  DegradedReasonKind,
  getDegradedReason,
  isOperationalReady,
  setActiveSessionProjectReady,
  setDegradedReason,
} from "../runtime-state";
import { refreshToolVisibility } from "../tools";
import type { Subcommand } from "./types";

/**
 * Create the detach-project-name subcommand.
 *
 * Confirms (because future flushes may derive a different project name and
 * thus produce different document tags / observation-scope linkage), appends
 * `usesProjectConfig: false`, marks the session pending, and makes clear
 * the file is left in place.
 */
export function createDetachProjectNameSubcommand(
  pi: ExtensionAPI,
  config: HindsightConfig
): Subcommand {
  return {
    description:
      "Stop requiring the cwd-local projectName for this session (does not delete the file)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const answer = await ctx.ui.confirm(
        "Detach the project-local project name?",
        "This session will stop requiring the cwd-local projectName override. Future " +
          "flushes and auto-recall will use the derived project name instead, and " +
          "pending work will be queued for re-flush. The config file is not deleted. Continue?"
      );
      if (!answer) {
        ctx.ui.notify("Project name not detached", "info");
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      const sessionId = ctx.sessionManager.getSessionId();
      const existingMeta = getHindsightMeta(entries);

      await updateSessionMetadata(pi, sessionId, entries, { usesProjectConfig: false }, config);

      if (sessionId) {
        const result = touchPendingFlag(sessionId, "detach-project-name");
        if (!result.success) {
          ctx.ui.notify(`Failed to queue session for re-flush: ${result.error}`, "warning");
        }
      }

      // Detaching clears only the active-session project-name failure. Tool
      // visibility still depends on the unified operational-ready state, so an
      // unrelated server/global-config failure keeps tools hidden.
      setActiveSessionProjectReady(true);
      // Clear the degraded reason ONLY if it was a project-name cause; a server/
      // version issue is owned by the startup probe path.
      const currentReason = getDegradedReason();
      if (currentReason?.kind === DegradedReasonKind.ProjectName) {
        setDegradedReason(null);
      }
      const isRetained = shouldSessionBeRetained(entries, config);
      refreshToolVisibility(pi, isRetained);

      // If detach restored operational readiness (startup was already healthy and
      // the project-name failure was the only degraded cause), update the status
      // bar so it doesn't stay unhealthy until the next session_start.
      if (isOperationalReady()) {
        ctx.ui.setStatus(STATUS_ID, config.statusHealthy);
      }

      // Surface the prior state for context: if the session wasn't actually
      // marked as using a projectName override, detaching is a no-op future-proof mark.
      const wasMarked = existingMeta?.usesProjectConfig === true;
      ctx.ui.notify(
        wasMarked
          ? "Detached project name for this session. Future flushes and auto-recall will use the derived project name. Pending work queued; the config file was not deleted."
          : "Recorded project-name detach for this session. Future flushes and auto-recall will use the derived project name; the config file was not deleted.",
        "info"
      );
    },
  };
}
