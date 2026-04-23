/**
 * Session metadata subcommands (retention toggling, tags).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import { getHindsightMeta, type HindsightMeta, shouldSessionBeRetained } from "../meta";
import { deleteAutoQueue, deleteToolQueue } from "../queue";
import type { Subcommand } from "./types";
import { parseAndUpsertSession } from "./utils";

/**
 * Create the toggle-retain subcommand — toggle whether the current session is retained.
 *
 * When toggling on, prompts the user to parse-and-upsert the full session first,
 * then deletes queue files since the full session was just upserted.
 * When toggling off, deletes queue files to prevent flushing.
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
        // Note: there should not be a tool queue for a non-retained session
        // (tool retains are only queued when retention is enabled), but clean up
        // defensively in case the state got out of sync.
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
  };
}

/**
 * Create the tag subcommand — add a tag to session metadata.
 *
 * Appends the tag to the existing tag list, preserving the current retained state.
 * Warns if the tag already exists or no tag is provided.
 */
export function createTagSubcommand(pi: ExtensionAPI): Subcommand {
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

      const meta: HindsightMeta = {
        ...(existingMeta?.retained !== undefined ? { retained: existingMeta.retained } : {}),
        tags,
      };

      pi.appendEntry("hindsight-meta", meta);
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
export function createRemoveTagSubcommand(pi: ExtensionAPI): Subcommand {
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

      const meta: HindsightMeta = {
        ...(existingMeta?.retained !== undefined ? { retained: existingMeta.retained } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      };

      pi.appendEntry("hindsight-meta", meta);
      ctx.ui.notify(`Tag "${tag}" removed`, "info");
    },
  };
}
