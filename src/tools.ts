/**
 * Manual tools for Hindsight memory operations.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Budget, RecallResponse, ReflectResponse } from "@vectorize-io/hindsight-client";
import { type Static, Type } from "typebox";
import type { HindsightClientWrapper } from "./client";
import type { HindsightConfig, MemoryType, ToolName } from "./config";
import { getHindsightMeta, shouldSessionBeRetained, updateSessionMetadata } from "./meta";
import { resolveProjectName } from "./project-config";
import { queueToolRetain } from "./retention";
import {
  getRegisteredHindsightTools,
  isOperationalReady,
  setRegisteredHindsightTools,
} from "./runtime-state";
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

interface ExtraContextDetails {
  success: boolean;
  extraContext?: string;
  error?: string;
}

/**
 * Check if a specific tool is enabled based on config.toolsEnabled.
 * - `true` (default): all tools enabled
 * - `false`: no tools enabled
 * - array of tool names: only listed tools enabled
 */
export function isToolEnabled(config: HindsightConfig, tool: ToolName): boolean {
  const { toolsEnabled } = config;
  if (typeof toolsEnabled === "boolean") return toolsEnabled;
  return toolsEnabled.includes(tool);
}

/**
 * Register the hindsight manual tools:
 * `hindsight_set_extra_context`, `hindsight_get_extra_context`, `hindsight_retain`,
 * `hindsight_recall`, and `hindsight_reflect`. Each is gated by
 * `config.toolsEnabled` (via {@link isToolEnabled}) — `true` (default) enables
 * all, `false` disables all, and an array enables only the listed tool names.
 * The extra-context and retain tools are client-free (disk/local operations),
 * so they are registered based solely on `toolsEnabled`. `hindsight_recall`
 * and `hindsight_reflect` need a live client and are not registered at all
 * when `client` is null (`if (!client) return;` runs before their blocks).
 *
 * This is called lazily from the `session_start` success path (after health +
 * version checks pass), not at extension init. Late `registerTool()`
 * auto-activates the tools via `refreshTools`, so they are visible to the LLM
 * from the first agent turn on; callers then re-apply retention-based
 * visibility via {@link updateRetainToolVisibility}.
 */
export function registerTools(
  pi: ExtensionAPI,
  config: HindsightConfig,
  client: HindsightClientWrapper | null
): string[] {
  const registered: string[] = [];
  if (isToolEnabled(config, "set_extra_context")) {
    registered.push("hindsight_set_extra_context");
    pi.registerTool({
      name: "hindsight_set_extra_context",
      label: "Hindsight Extra Context",
      description:
        "Set extra context/caveats for memory extraction. Use when the session involves content that could be misclassified when split into chunks.",
      parameters: Type.Object({
        text: Type.String({
          description:
            "The extra context. Replaces any existing value. Example: 'This session involves reading Dune; characters are not the user and information is not factual.'",
        }),
      }),

      renderResult(result, _options, theme, context) {
        const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
        const details = result.details as ExtraContextDetails;
        if (details.success) {
          if (details.extraContext) {
            text.setText(theme.fg("success", `✓ Extra context set: ${details.extraContext}`));
          } else {
            text.setText(theme.fg("success", "✓ No extra context needed (flush guard satisfied)"));
          }
        } else {
          text.setText(theme.fg("error", `✗ ${details.error ?? "Failed to set extra context"}`));
        }
        return text;
      },

      async execute(
        _toolCallId,
        params,
        _signal,
        _onUpdate,
        ctx
      ): Promise<AgentToolResult<ExtraContextDetails>> {
        const entries = ctx.sessionManager.getEntries();

        const extraContext = params.text.trim();
        // Always store extraContext (even empty string) so the flush guard
        // can distinguish "explicitly set to empty" from "never set".
        const sessionId = ctx.sessionManager.getSessionId();
        await updateSessionMetadata(pi, sessionId, entries, { extraContext }, config);

        const message = extraContext
          ? "Extra context set."
          : "No extra context needed (flush guard satisfied).";

        return {
          content: [{ type: "text", text: message }],
          details: { success: true, extraContext },
        };
      },
    });
  }

  if (isToolEnabled(config, "get_extra_context")) {
    registered.push("hindsight_get_extra_context");
    pi.registerTool({
      name: "hindsight_get_extra_context",
      label: "Hindsight Get Extra Context",
      description: "Get the current extra context set for this session.",
      parameters: Type.Object({}),

      renderResult(result, _options, theme, context) {
        const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
        const details = result.details as ExtraContextDetails;
        if (details.success) {
          if (details.extraContext) {
            text.setText(theme.fg("success", `✓ Extra context: ${details.extraContext}`));
          } else if (details.extraContext === "") {
            text.setText(theme.fg("success", "✓ No extra context needed (flush guard satisfied)"));
          } else {
            text.setText(theme.fg("success", "✓ No extra context set"));
          }
        } else {
          text.setText(theme.fg("error", `✗ ${details.error ?? "Failed to get extra context"}`));
        }
        return text;
      },

      async execute(
        _toolCallId,
        _params,
        _signal,
        _onUpdate,
        ctx
      ): Promise<AgentToolResult<ExtraContextDetails>> {
        const entries = ctx.sessionManager.getEntries();
        const existingMeta = getHindsightMeta(entries);
        const extraContext = existingMeta?.extraContext;

        const message =
          extraContext !== undefined
            ? extraContext || "No extra context needed (flush guard satisfied)"
            : "No extra context set";

        return {
          content: [{ type: "text", text: message }],
          details: { success: true, extraContext },
        };
      },
    });
  }

  // Register hindsight_retain if enabled
  if (isToolEnabled(config, "retain")) {
    registered.push("hindsight_retain");
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
              "Extra context for fact extraction. Returned with recalled memories but can't use for recall filtering.",
          })
        ),
      }),

      renderResult(result, _options, theme, context) {
        const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
        const details = result.details as RetainDetails;
        if (details.success) {
          const retained = context.args.content ?? "";
          text.setText(
            `${theme.fg("success", "✓ Memory queued for storage")}\n${theme.fg("dim", retained)}`
          );
        } else {
          text.setText(theme.fg("error", `✗ ${details.error ?? "Failed to store memory"}`));
        }
        return text;
      },

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
        const sessionUserTags = meta?.tags ?? [];

        // Resolve the project name project-aware so tool retains share the
        // same `project:` tag as session flushes. The session's recorded cwd
        // (header.cwd) is authoritative — matches what the upsert path uses.
        // If the session is marked as using project-local config and the
        // resolution fails (cwd gone, or config missing/invalid), fail closed:
        // do not queue — the memory would otherwise be tagged with the wrong
        // project name
        const retainCwd = header?.cwd ?? ctx.cwd;
        const projectNameResult = resolveProjectName(retainCwd, meta?.usesProjectConfig);
        if (!projectNameResult.ok) {
          const recoveryAdvice =
            projectNameResult.recovery === "fix-config"
              ? `Fix the config at ${retainCwd}/.pi/epimetheus/config.jsonc.`
              : `Use /hindsight detach-project-name to stop requiring the project-local projectName override, or restore the config at ${retainCwd}/.pi/epimetheus/.`;
          return {
            content: [
              {
                type: "text",
                text: `Failed to store memory: ${projectNameResult.error}. ${recoveryAdvice}`,
              },
            ],
            details: { success: false, error: projectNameResult.error },
          };
        }

        const result = await queueToolRetain(
          sessionId,
          params.content,
          params.tags,
          params.metadata,
          retainCwd,
          parentSessionId,
          config,
          sessionUserTags,
          projectNameResult.projectName
        );
        if (!result.success) {
          return {
            content: [{ type: "text", text: `Failed to queue memory: ${result.error}` }],
            details: { success: false, error: result.error },
          };
        }

        return {
          content: [{ type: "text", text: "Memory queued for storage." }],
          details: { success: true },
        };
      },
    });
  }

  // recall and reflect require client
  if (!client) return registered;

  // Register hindsight_recall if enabled
  if (isToolEnabled(config, "recall")) {
    registered.push("hindsight_recall");
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
        const types = params.types ?? config.autoRecallTypes ?? undefined;
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
              {
                type: "text",
                text: `Failed to recall memories: ${result.error ?? "unknown error"}`,
              },
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
  }

  // Register hindsight_reflect if enabled
  if (isToolEnabled(config, "reflect")) {
    registered.push("hindsight_reflect");
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

  setRegisteredHindsightTools(registered);
  return registered;
}

/**
 * Refresh the visibility of all registered Hindsight tools based on the
 * unified operational state and the session's retention flag.
 *
 * - Degraded (`!isOperationalReady()`): hide ALL hindsight tools so the LLM
 *   never sees any of them (no recall/reflect/retain/extra-context). This is
 *   the single degraded mode regardless of cause (unreachable/incompatible
 *   server, or required-but-missing/invalid cwd-local project config).
 * - Operational: show all registered hindsight tools, except `hindsight_retain`
 *   is hidden when the session is not retained (so the LLM never sees a tool
 *   whose calls would fail). `retained` has no effect on the other tools.
 *
 * Reads `isOperationalReady()` and the registered-tool list from
 * `runtime-state`, so callers only need to pass the session's `retained` flag.
 *
 * Enabling/disabling tools is the only place degraded mode is enforced — there
 * are no operational-state checks inside tool execute handlers.
 */
export function refreshToolVisibility(pi: ExtensionAPI, retained: boolean): void {
  const activeNames = pi.getActiveTools();
  // Preserve non-hindsight tools (other extensions / built-ins) unchanged.
  const nonHindsight = activeNames.filter((n) => !n.startsWith("hindsight_"));

  if (!isOperationalReady()) {
    // Degraded: hide all hindsight tools.
    pi.setActiveTools(nonHindsight);
    return;
  }

  // Operational: show all registered hindsight tools except retain when not
  // retained.
  const toShow = getRegisteredHindsightTools().filter(
    (name) => name !== "hindsight_retain" || retained
  );
  pi.setActiveTools([...nonHindsight, ...toShow]);
}
