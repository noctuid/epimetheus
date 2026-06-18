/**
 * Session metadata subcommands (retention toggling, tags).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import { getHindsightMeta, shouldSessionBeRetained, updateSessionMetadata } from "../meta";
import { clearSessionQueueState, touchPendingFlag } from "../queue";
import { parseAndUpsertSession } from "../retention";
import { isToolEnabled, updateRetainToolVisibility } from "../tools";
import type { Subcommand } from "./types";

/**
 * Enable retention for the current session.
 *
 * Always marks the session as retained. Prompts the user to parse-and-upsert
 * the full session immediately, but does not cancel enabling retention if the
 * user declines — the session will be retained on the next flush instead.
 * Does not pre-clear queue state — any pending work will be flushed normally
 * on the next flush cycle.
 */
async function enableRetention(
  pi: ExtensionAPI,
  client: HindsightClientWrapper,
  config: HindsightConfig,
  ctx: ExtensionContext,
  entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>
): Promise<void> {
  // No extra-context guard here: the user can enable retention and set
  // extra context later. The guard only blocks actual upserts (flush,
  // parse-and-upsert).
  const sessionId = ctx.sessionManager.getSessionId();

  await updateSessionMetadata(pi, sessionId, entries, { retained: true }, config);

  if (isToolEnabled(config, "retain")) {
    updateRetainToolVisibility(pi, true);
  }

  // Create a pending marker immediately so that if the upsert fails or can't
  // run (missing session file, network/parse error), the session is still
  // marked dirty and will be retained on the next flush.
  if (sessionId) {
    const result = touchPendingFlag(sessionId, "toggle-retain-on");
    if (!result.success) {
      ctx.ui.notify(`Failed to queue session for retention: ${result.error}`, "warning");
    }
  }

  const answer = await ctx.ui.confirm(
    "Upsert session now?",
    "Upsert the full session to Hindsight now? If you decline, it will be retained on the next flush."
  );

  if (!answer) {
    ctx.ui.notify(
      "Session retention: enabled. The session will be retained on the next flush.",
      "info"
    );
    return;
  }

  // Parse and upsert the full session
  const sessionPath = ctx.sessionManager.getSessionFile();
  ctx.ui.notify("Session retention: enabled", "info");

  if (sessionId && sessionPath) {
    await parseAndUpsertSession(sessionPath, sessionId, config, client, ctx, ctx.signal, {
      requirePending: false,
    });
  } else {
    ctx.ui.notify("Session file not found — could not parse and upsert", "warning");
  }
}

/**
 * Disable retention for the current session.
 *
 * Marks retained false before clearing queued state so new auto/tool
 * retain attempts see retention disabled, then discards already-queued work.
 */
async function disableRetention(
  pi: ExtensionAPI,
  config: HindsightConfig,
  ctx: ExtensionContext,
  entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>
): Promise<void> {
  // Toggling OFF: confirm since queued messages will be deleted
  const answer = await ctx.ui.confirm(
    "Disable retention?",
    "Queued retain tool memories will be deleted and will not be flushed."
  );

  if (!answer) {
    ctx.ui.notify("Retention not disabled. Use /hindsight toggle-retain again to disable.", "info");
    return;
  }

  const sessionId = ctx.sessionManager.getSessionId();

  await updateSessionMetadata(pi, sessionId, entries, { retained: false }, config);

  if (isToolEnabled(config, "retain")) {
    updateRetainToolVisibility(pi, false);
  }

  // clear after retain disabled to avoid new tool retains coming in and being
  // missed
  if (sessionId) {
    clearSessionQueueState(sessionId);
  }

  ctx.ui.notify("Session retention: disabled (pending changes cleared)", "info");
}

/**
 * Create the toggle-retain subcommand — toggle whether the current session is retained.
 *
 * When toggling on, prompts the user to parse-and-upsert the full session first.
 * When toggling off, clears queue files to prevent flushing.
 * Preserves existing tags in both directions.
 */
export function createToggleRetainSubcommand(
  pi: ExtensionAPI,
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Toggle whether the current session should be retained",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      const currentRetained = shouldSessionBeRetained(entries, config);

      if (!currentRetained) {
        await enableRetention(pi, client, config, ctx, entries);
      } else {
        await disableRetention(pi, config, ctx, entries);
      }
    },
  };
}

/**
 * Create the tag subcommand — add a tag to session metadata.
 *
 * Appends the tag to the existing tag list, preserving the current retained state.
 * Warns if the tag already exists or no tag is provided.
 */
export function createTagSubcommand(pi: ExtensionAPI, config: HindsightConfig): Subcommand {
  return {
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

      const sessionId = ctx.sessionManager.getSessionId();
      await updateSessionMetadata(pi, sessionId, entries, { tags }, config);

      ctx.ui.notify(`Tag "${tag}" added`, "info");
    },
  };
}

/**
 * Create the remove-tag subcommand — remove a tag from session metadata.
 *
 * Removes the tag from the tag list, preserving the current retained state.
 * Omits the tags field entirely if no tags remain. Warns if the tag is not found.
 */
export function createRemoveTagSubcommand(pi: ExtensionAPI, config: HindsightConfig): Subcommand {
  return {
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

      const sessionId = ctx.sessionManager.getSessionId();
      await updateSessionMetadata(pi, sessionId, entries, { tags }, config);

      ctx.ui.notify(`Tag "${tag}" removed`, "info");
    },
  };
}

/**
 * Create the set-extra-context subcommand — set extra context for the Hindsight context field.
 *
 * Extra context is appended after the session name in the Hindsight context string,
 * separated by a newline. It provides caveats/instructions for extraction to help
 * Hindsight correctly classify content (e.g., "This session involves reading a fiction
 * book; characters are not the user and information is not factual").
 *
 * The extra context is used in all places the Hindsight context field is used:
 * - Fact extraction: included in the extraction prompt so the LLM knows the nature of the source
 * - Full-text search: indexed in the tsvector for recall filtering
 * - Consolidation: included in source fact data passed to the observation synthesis LLM
 * - Recall results: returned as a field on each memory fact
 * - Reflect agent: available as context for answer synthesis
 *
 * Pass an empty string ("") to indicate that no extra context is needed for this session.
 * This is distinct from not having set extra context at all: when requireExtraContextBeforeFlush
 * is enabled, an explicit empty string satisfies the flush guard (you've confirmed you don't
 * need extra context), while never having set it blocks the flush.
 * Replaces any previously set extra context.
 */
export function createExtraContextSubcommand(
  pi: ExtensionAPI,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Set extra context for extraction caveats (appended to Hindsight context field)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const extraContext = args.trim();

      const entries = ctx.sessionManager.getEntries();

      // Always store extraContext (even empty string) so the flush guard
      // can distinguish "explicitly set to empty" from "never set".
      const sessionId = ctx.sessionManager.getSessionId();
      await updateSessionMetadata(pi, sessionId, entries, { extraContext }, config);

      if (extraContext) {
        ctx.ui.notify(`Extra context set`, "info");
      } else {
        ctx.ui.notify(`No extra context needed (flush guard satisfied)`, "info");
      }
    },
  };
}
