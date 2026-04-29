/**
 * Manual tools for Hindsight memory operations.
 */

import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Budget, RecallResponse, ReflectResponse } from "@vectorize-io/hindsight-client";
import { type Static, Type } from "typebox";
import type { HindsightClientWrapper } from "./client";
import type { HindsightConfig, MemoryType } from "./config";
import { getHindsightMeta, shouldSessionBeRetained } from "./meta";
import { queueToolRetain } from "./retention";
import { extractParentSessionId } from "./utils";

// Reusable schemas
/** Tags match strategy for recall/reflect operations. */
const TagsMatchSchema = Type.Union(
  [
    Type.Literal("any"),
    Type.Literal("all"),
    Type.Literal("any_strict"),
    Type.Literal("all_strict"),
  ],
  {
    description:
      "Match mode: 'any'(OR)/'all'(AND), '_strict' variants exclude untagged. Default: 'any'.",
  }
);
type TagsMatch = Static<typeof TagsMatchSchema>;

const MemoryTypeSchema = Type.Union([
  Type.Literal("world"),
  Type.Literal("experience"),
  Type.Literal("observation"),
]);

/** Budget level for recall/reflect operations. */
const BudgetSchema = Type.Union([Type.Literal("low"), Type.Literal("mid"), Type.Literal("high")], {
  description:
    "Budget level: 'low', 'mid', or 'high'. Controls how much effort to spend on retrieval and reasoning.",
});

interface RetainDetails {
  success: boolean;
  error?: string;
}

interface RecallDetails {
  success: boolean;
  error?: string;
  response?: RecallResponse;
}

interface ReflectDetails {
  success: boolean;
  error?: string;
  response?: ReflectResponse;
}

/**
 * Register hindsight_retain, hindsight_recall, and hindsight_reflect tools.
 * hindsight_retain is always available (queues to disk).
 * hindsight_recall and hindsight_reflect are only available when client is provided.
 */
export function registerTools(
  pi: ExtensionAPI,
  config: HindsightConfig,
  client: HindsightClientWrapper | null
): void {
  if (!config.toolsEnabled) return;

  // hindsight_retain - always available, just queues to disk
  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description:
      "Store information to long-term memory. Use for facts, preferences, decisions, or anything worth remembering across sessions",
    parameters: Type.Object({
      content: Type.String({ description: "Information to store" }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tags for recall filtering, e.g. 'topic:billing'",
        })
      ),
      metadata: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Extra context for fact extraction. Returned with memories but cannot filter by on recall.",
        })
      ),
    }),

    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx
    ): Promise<AgentToolResult<RetainDetails>> {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "Failed to store memory: no active session" }],
          details: { success: false, error: "no active session" },
        };
      }

      // Check if session is retained
      const entries = ctx.sessionManager.getEntries();
      if (!shouldSessionBeRetained(entries, config)) {
        return {
          content: [
            {
              type: "text",
              text: "Warning: Session does not allow retention. Use /hindsight toggle-retain to enable retention.",
            },
          ],
          details: { success: false, error: "session does not allow retention" },
        };
      }

      const header = ctx.sessionManager.getHeader();
      const parentSessionId = extractParentSessionId(header?.parentSession);

      // Get session tags from metadata
      const meta = getHindsightMeta(entries);
      const sessionTags = meta?.tags;

      const success = queueToolRetain(
        sessionId,
        params.content,
        params.tags,
        params.metadata,
        ctx.cwd,
        parentSessionId,
        config,
        sessionTags
      );
      if (!success) {
        return {
          content: [{ type: "text", text: "Failed to queue memory for storage." }],
          details: { success: false, error: "enqueue failed" },
        };
      }

      return {
        content: [{ type: "text", text: "Memory queued for storage." }],
        details: { success: true },
      };
    },
  });

  // hindsight_recall - only available when client is configured
  if (!client) return;

  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: "Search long-term memory",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Filter by tags",
        })
      ),
      tagsMatch: Type.Optional(TagsMatchSchema),
      // TODO: Consider adding tag_groups for complex tag matching (may be unnecessary and overly complex)
      types: Type.Optional(
        Type.Array(MemoryTypeSchema, {
          description:
            "Filter by type: `world` (external facts), `experience` (user-specific), `observation` (consolidated patterns). Default: all types.",
        })
      ),
      budget: Type.Optional(BudgetSchema),
    }),

    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      _ctx
    ): Promise<AgentToolResult<RecallDetails>> {
      // Use config default if not specified, otherwise use params
      const types = params.types ?? config.recallTypes ?? undefined;
      const result = await client.recall(
        {
          query: params.query,
          tags: params.tags,
          tagsMatch: params.tagsMatch as TagsMatch | undefined,
          types: types as MemoryType[] | undefined,
          budget: params.budget as Budget | undefined,
        },
        signal
      );

      if (!result.success) {
        return {
          content: [
            { type: "text", text: `Failed to recall memories: ${result.error ?? "unknown error"}` },
          ],
          details: { success: false, error: result.error },
        };
      }

      const response = result.response;
      const results = response?.results ?? [];

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No relevant memories found." }],
          details: { success: true, response },
        };
      }

      const text = results.map((r, i) => `${i + 1}. ${r.text}`).join("\n");

      return {
        content: [{ type: "text", text }],
        details: { success: true, response },
      };
    },
  });

  // hindsight_reflect - only available when client is configured
  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description:
      "Synthesize an answer from memories using multi-step reasoning. Use recall for raw facts or observations and reflect for answers, topic summaries, etc. requiring synthesis across many memories. Budget defaults to 'low'; higher budgets are much slower and should only be used if necessary",
    parameters: Type.Object({
      query: Type.String({ description: "Question to answer" }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Filter by tags",
        })
      ),
      tagsMatch: Type.Optional(TagsMatchSchema),
      budget: Type.Optional(BudgetSchema),
    }),

    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      _ctx
    ): Promise<AgentToolResult<ReflectDetails>> {
      const result = await client.reflect(
        {
          query: params.query,
          tags: params.tags,
          tagsMatch: params.tagsMatch as TagsMatch | undefined,
          budget: params.budget as Budget | undefined,
        },
        signal
      );

      if (!result.success) {
        return {
          content: [
            { type: "text", text: `Failed to reflect: ${result.error ?? "unknown error"}` },
          ],
          details: { success: false, error: result.error },
        };
      }

      const response = result.response;
      const text = response?.text;

      if (!text) {
        return {
          content: [{ type: "text", text: "No relevant memories found to reflect on." }],
          details: { success: true, response },
        };
      }

      return {
        content: [{ type: "text", text }],
        details: { success: true, response },
      };
    },
  });
}
