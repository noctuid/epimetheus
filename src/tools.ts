/**
 * Manual tools for Hindsight memory operations.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI, AgentToolResult } from "@mariozechner/pi-coding-agent";
import type { RecallResponse, Budget } from "@vectorize-io/hindsight-client";
import type { HindsightConfig, MemoryType } from "./config";
import type { HindsightClientWrapper } from "./client";
import { queueToolRetain } from "./retention";
import { extractParentSessionId } from "./utils";

// Reusable schemas
const TagsMatchSchema = Type.Union([
  Type.Literal("any"),
  Type.Literal("all"),
  Type.Literal("any_strict"),
  Type.Literal("all_strict"),
]);
type TagsMatch = Static<typeof TagsMatchSchema>;

const MemoryTypeSchema = Type.Union([
  Type.Literal("world"),
  Type.Literal("experience"),
  Type.Literal("observation"),
]);

const BudgetSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("mid"),
  Type.Literal("high"),
]);

interface RetainDetails {
  success: boolean;
  error?: string;
}

interface RecallDetails {
  success: boolean;
  error?: string;
  response?: RecallResponse;
}

/**
 * Register hindsight_retain and hindsight_recall tools.
 * hindsight_retain is always available (queues to disk).
 * hindsight_recall is only available when client is provided.
 */
export function registerTools(
  pi: ExtensionAPI,
  config: HindsightConfig,
  client: HindsightClientWrapper | null,
): void {
  if (!config.toolsEnabled) return;

  // hindsight_retain - always available, just queues to disk
  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description: `Store information to long-term memory. Hindsight automatically extracts structured facts, resolves entities, and indexes for retrieval. Use this for facts, preferences, decisions, or any information worth remembering for future sessions.`,
    parameters: Type.Object({
      content: Type.String({ description: "The information to store" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for filtering during recall. Use namespaced tags like 'topic:billing' or 'priority:high'." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional context included in fact extraction prompt (improves accuracy). Returned with recalled memories for client-side filtering." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<RetainDetails>> {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "Failed to store memory: no active session" }],
          details: { success: false, error: "no active session" },
        };
      }

      const header = ctx.sessionManager.getHeader();
      const parentSessionId = extractParentSessionId(header?.parentSession);

      const success = queueToolRetain(
        sessionId,
        params.content,
        params.tags,
        params.metadata,
        ctx.cwd,
        parentSessionId,
        config,
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
    description: `Search long-term memory using multi-strategy retrieval.

**Memory Types:**
- \`world\`: General knowledge, external facts (e.g., "The Eiffel Tower is in Paris")
- \`experience\`: Personal events, user-specific facts (e.g., "User prefers dark mode")
- \`observation\`: Consolidated patterns synthesized from facts (e.g., "User consistently prefers async communication")`,
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags. A memory tagged 'user:alice' is only returned when tags=['user:alice']." })),
      tagsMatch: Type.Optional(TagsMatchSchema),
      // TODO: Consider adding tag_groups for complex tag matching (may be unnecessary and overly complex)
      types: Type.Optional(Type.Array(MemoryTypeSchema, { description: "Filter by memory type. Default: all types. Common alternative would be [\"observation\"] to avoid duplication." })),
      budget: Type.Optional(BudgetSchema),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx): Promise<AgentToolResult<RecallDetails>> {
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
          content: [{ type: "text", text: `Failed to recall memories: ${result.error ?? "unknown error"}` }],
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
}
