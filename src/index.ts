/**
 * pi-hindsight extension entry point.
 *
 * Integrates Hindsight AI memory with pi coding agent using
 * turn-based queue with Hindsight's append mode.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Box, type Component, Text } from "@mariozechner/pi-tui";
import type { RecallResponse } from "@vectorize-io/hindsight-client";
import { HindsightClientWrapper } from "./client";
import { registerCommands } from "./commands";
import { loadConfig, validateConfig } from "./config";
import { getHindsightMeta, shouldSessionBeRetained } from "./meta";
import { prepareEntry, shouldRetainMessage } from "./prepare";
import { enqueueAutoMessage } from "./queue";
import { flushQueues, getQueueCount } from "./retention";
import { registerTools } from "./tools";
import { extractParentSessionId, getSessionDisplayName, truncate } from "./utils";

// Runtime toggle for recall display (overrides config)
let recallDisplayOverride: boolean | null = null;

// Cache last recall message for context handler re-injection (recallPersist: true)
// Consumed once per turn by the context handler.
let lastRecallMessage: ReturnType<typeof formatRecallMessage> | null = null;

// Last recall details for the popup command — persists across turns
// (not consumed by the context handler like lastRecallMessage is).
let lastRecallDetails: RecallMessageDetails | null = null;

/**
 * Reset module-level mutable state. Exported for testing only.
 */
export function _resetState(): void {
  recallDisplayOverride = null;
  lastRecallMessage = null;
  lastRecallDetails = null;
}

export default function (pi: ExtensionAPI) {
  // Load and validate config
  const { config, configPath, warning, envVars } = loadConfig();
  const validation = validateConfig(config);

  // Global disable check
  // Note: register a lightweight context handler to filter hindsight-recall
  // messages even when disabled (prevents stale recalls from reaching the LLM)
  if (!config.enabled) {
    console.log("pi-hindsight disabled via config");
    pi.on("context", async (event) => {
      const messages = event.messages as Array<{ customType?: string }>;
      const filtered = messages.filter((msg) => msg.customType !== "hindsight-recall");
      if (filtered.length !== messages.length) {
        return { messages: filtered } as Record<string, unknown>;
      }
    });
    return;
  }

  let client: HindsightClientWrapper | null = null;

  if (!validation.valid) {
    console.error(`pi-hindsight disabled: ${validation.errors.join(", ")}`);
  } else {
    if (warning) {
      console.warn(warning);
    }
    if (validation.warnings && validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        console.warn(w);
      }
    }
  }

  if (validation.valid) {
    client = new HindsightClientWrapper(config);
    console.log("pi-hindsight initialized");
  }

  // Set status bar indicator based on health
  // Unhealthy when config is invalid (no client) or server is unreachable.
  // Validation warnings (e.g. recallDisplay with recallPersist) are cosmetic
  // and should not override a successful connectivity check.
  const hasUsableConfig = validation.valid;
  pi.on("session_start", async (_event, ctx) => {
    // Auto-create session metadata if none exists, using retainSessionsByDefault
    // as the default retained state. This ensures every session has explicit
    // metadata, so toggle-retain and other commands work predictably.
    const entries = ctx.sessionManager.getEntries();
    const existingMeta = getHindsightMeta(entries);
    if (!existingMeta) {
      pi.appendEntry("hindsight-meta", { retained: config.retainSessionsByDefault });
    }

    if (!hasUsableConfig) {
      ctx.ui.setStatus("pi-hindsight", config.statusUnhealthy);
      return;
    }
    // Verify server is reachable
    const healthResult = await client?.healthCheck(ctx.signal);
    if (healthResult?.success) {
      ctx.ui.setStatus("pi-hindsight", config.statusHealthy);
    } else {
      ctx.ui.setStatus("pi-hindsight", config.statusUnhealthy);
    }
  });

  // Register tools (hindsight_retain always, hindsight_recall when configured)
  registerTools(pi, config, client);

  // Register slash commands (pass getter/setter for runtime state)
  registerCommands(
    pi,
    config,
    client,
    () => lastRecallDetails,
    () => recallDisplayOverride,
    (value) => {
      recallDisplayOverride = value;
    },
    {
      configPath,
      envVars,
      warning,
      validationWarnings: validation.warnings,
    }
  );

  // Getter for current recall display state — used by dynamic renderers
  // to re-check toggle state on every render pass, enabling immediate
  // show/hide when the user toggles display.
  const getRecallDisplay = () => recallDisplayOverride ?? config.recallDisplay;

  // Register custom message renderer for hindsight-recall messages.
  // Uses dynamic components that check the runtime toggle on every render()
  // call, so toggling display immediately shows/hides existing messages.
  pi.registerMessageRenderer<RecallMessageDetails>(
    "hindsight-recall",
    (message, { expanded }, theme) => {
      const details = message.details;
      if (!details) return undefined;

      if (expanded) {
        return new RecallExpandedComponent(details, theme, getRecallDisplay);
      }

      return new RecallCollapsedComponent(details, theme, getRecallDisplay);
    }
  );

  // Auto-recall on before_agent_start.
  // Always performs recall and caches the result for the context handler to re-inject.
  // Only returns the message (persisting it to session) when recallPersist is true.
  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!client || !config.autoRecallEnabled) return;

    // Use event.prompt directly — available before the user message is
    // persisted to the session (fixes first-message recall).
    const query = event.prompt;
    if (!query) return;

    // display controls whether the recall message is shown in the TUI.
    // When recallPersist is true, always use display: true so the message is
    // added to the TUI chat container. The custom renderer dynamically checks
    // the runtime toggle on every render() call to show/hide the content.
    // When recallPersist is false, the message is ephemeral (re-injected only
    // by the context handler), so display controls the context handler's
    // message visibility directly.
    const displayValue = config.recallPersist
      ? true
      : (recallDisplayOverride ?? config.recallDisplay);

    // Call shared recall helper
    const result = await doAutoRecall(query, ctx.signal, displayValue);
    if (result) {
      lastRecallMessage = result.recallMessage;
      lastRecallDetails = result.recallMessage.details;
      // Only persist to session file when recallPersist is true
      if (config.recallPersist) {
        return { message: result.recallMessage };
      }
    }
  });

  // Context event handler:
  // 1. Always filter out hindsight-recall messages (prevent stale recalls from being sent to LLM)
  // 2. Re-inject cached recall from before_agent_start (so the LLM sees fresh recall)
  pi.on("context", async (event, _ctx: ExtensionContext) => {
    const messages = event.messages as Array<{
      role: string;
      content?: unknown;
      customType?: string;
    }>;

    // Always filter out existing hindsight-recall messages from the messages array
    // This is critical to prevent old recall messages from being sent to the LLM
    const filteredMessages = messages.filter((msg) => msg.customType !== "hindsight-recall");
    const hadRecallMessages = filteredMessages.length !== messages.length;

    // Re-inject the cached recall from before_agent_start.
    // before_agent_start always does the recall and caches the message here.
    // When recallPersist: true, the message was also persisted to the session file;
    // when recallPersist: false, it's ephemeral (re-injected here only for this turn).
    const cachedRecall = lastRecallMessage;
    lastRecallMessage = null; // Clear after reading (consume once per turn)
    if (cachedRecall) {
      lastRecallDetails = cachedRecall.details;
      return { messages: [...filteredMessages, cachedRecall] } as Record<string, unknown>;
    }

    // If we filtered out recall messages but didn't re-inject, return filtered array
    if (hadRecallMessages) {
      return { messages: filteredMessages } as Record<string, unknown>;
    }
  });

  // Queue messages on message_end event
  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    if (!config.autoRetainEnabled) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;

    // Check if session is retained
    const entries = ctx.sessionManager.getEntries();
    if (!shouldSessionBeRetained(entries, config)) return;

    // event.message is AgentMessage union (many types). Cast to Record for processing.
    const message = event.message as unknown as Record<string, unknown> | undefined;
    if (!message) return;

    // Check if this message type should be retained
    if (!shouldRetainMessage(message, config.retainContent, config.toolFilter)) return;

    // Build entry from message
    const entry: Record<string, unknown> = {
      type: "message",
      timestamp: new Date().toISOString(),
      message: message,
    };

    // Queue the message
    const prepared = prepareEntry(entry, config);
    const success = enqueueAutoMessage(sessionId, { entry: prepared, store_method: "auto" });
    if (!success) {
      ctx.ui.notify("Failed to queue message for Hindsight retention", "warning");
    }
  });

  // Flush queues and reset recall cache on session switch
  pi.on("session_before_switch", async (_event, ctx: ExtensionContext) => {
    lastRecallMessage = null;
    lastRecallDetails = null;
    await flushCurrentSession(ctx, "before session switch");
  });

  // Flush queues and reset recall cache before forking
  pi.on("session_before_fork", async (_event, ctx: ExtensionContext) => {
    lastRecallMessage = null;
    lastRecallDetails = null;
    await flushCurrentSession(ctx, "before session fork");
  });

  // Flush queues after compaction (if enabled)
  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    if (config.flushOnCompact) {
      await flushCurrentSession(ctx, "after compaction");
    }
  });

  // Flush queues on session shutdown
  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    await flushCurrentSession(ctx, "on shutdown", true);
  });

  /**
   * Perform auto-recall with the given query.
   * Shared by before_agent_start and context handlers.
   *
   * @param query - The user's query text (will be truncated)
   * @param signal - AbortSignal for cancellation
   * @param display - Whether the recall message should be visible in TUI
   * @returns Object with recallMessage if results found, null otherwise
   */
  async function doAutoRecall(
    query: string,
    signal: AbortSignal | undefined,
    display: boolean
  ): Promise<{ recallMessage: ReturnType<typeof formatRecallMessage> } | null> {
    // Clear stale recall on error/no-results (doAutoRecallImpl calls cacheDetails(null))
    return doAutoRecallImpl(client, query, signal, display, config, (details) => {
      lastRecallMessage = null;
      lastRecallDetails = details;
    });
  }

  /**
   * Flush current session's queue to Hindsight.
   * @param ctx - Extension context
   * @param reason - Reason for flush (used in log messages)
   * @param notifyOnError - If true, show UI notification on error
   */
  async function flushCurrentSession(
    ctx: ExtensionContext,
    reason: string,
    notifyOnError = false
  ): Promise<void> {
    if (!client) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;

    const count = getQueueCount(sessionId);
    if (count === 0) return;

    console.log(`pi-hindsight: Flushing ${count} messages ${reason}`);

    const header = ctx.sessionManager.getHeader();
    const entries = ctx.sessionManager.getEntries();
    const sessionName = getSessionDisplayName(
      ctx.sessionManager.getSessionName.bind(ctx.sessionManager),
      ctx.sessionManager.getEntries.bind(ctx.sessionManager)
    );
    const parentSessionId = extractParentSessionId(header?.parentSession);
    const result = await flushQueues(
      sessionId,
      sessionName,
      header?.timestamp ?? new Date().toISOString(),
      header?.cwd ?? ctx.cwd,
      parentSessionId,
      config,
      client,
      ctx.signal,
      entries
    );

    if (!result.success) {
      console.error("pi-hindsight: Flush failed:", result.error);
      if (notifyOnError) {
        ctx.ui.notify(`Hindsight flush failed: ${result.error}`, "error");
      }
    } else if (result.autoCount > 0 || result.toolCount > 0) {
      console.log(
        `pi-hindsight: Flushed ${result.autoCount} auto + ${result.toolCount} tool entries`
      );
    }
  }
}

/**
 * Custom component for rendering collapsed recall messages.
 * Dynamically checks the runtime display toggle on every render() call,
 * so toggling display immediately shows/hides the message content.
 */
class RecallCollapsedComponent implements Component {
  constructor(
    private details: RecallMessageDetails,
    private theme: Theme,
    private getDisplay: () => boolean
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.getDisplay()) {
      return [];
    }

    const th = this.theme;
    const text =
      th.fg("accent", "\ud83e\udde0 Hindsight recalled ") +
      th.fg("muted", `${this.details.count} ${this.details.count === 1 ? "memory" : "memories"}`) +
      " " +
      th.fg("dim", `[${this.details.snippet}]`);
    const box = new Box(1, 1, (t) => th.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box.render(width);
  }
}

/**
 * Custom component for rendering expanded recall messages with full-width separators.
 * Separators stretch to fill the terminal width, like tool block borders.
 * Dynamically checks the runtime display toggle on every render() call,
 * so toggling display immediately shows/hides the message content.
 */
class RecallExpandedComponent implements Component {
  constructor(
    private details: RecallMessageDetails,
    private theme: Theme,
    private getDisplay: () => boolean
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.getDisplay()) {
      return [];
    }

    const th = this.theme;
    // Build content with full-width separators inside a Box with customMessageBg
    const box = new Box(1, 1, (t) => th.bg("customMessageBg", t));

    const contentWidth = Math.max(1, width - 2); // 2 = Box paddingX * 2
    const title =
      th.fg("accent", "\ud83e\udde0 Hindsight recalled ") +
      th.fg("muted", `${this.details.count} ${this.details.count === 1 ? "memory" : "memories"}`);
    const separator = th.fg("dim", "\u2500".repeat(contentWidth));

    box.addChild(new Text(title, 0, 0));
    box.addChild(new Text(separator, 0, 0));
    box.addChild(new Text(this.details.memories, 0, 0));
    box.addChild(new Text(separator, 0, 0));

    return box.render(width);
  }
}

/**
 * Details included in hindsight-recall messages for the custom renderer.
 * Exported for testing.
 */
export interface RecallMessageDetails {
  count: number;
  snippet: string;
  memories: string;
}

/**
 * Format recall results into a custom message with hindsight_memories fencing.
 * Precondition: results must be non-empty (caller checks results.length > 0).
 *
 * The `display` parameter controls TUI visibility:
 * - When recallPersist is true, display is always true (message is persisted to
 *   session and added to chat container; the custom renderer dynamically checks
 *   the runtime toggle to show/hide content).
 * - When recallPersist is false, the caller passes the current
 *   recallDisplay/override value, which may be true or false. However, since
 *   the message is ephemeral (not added to the TUI chat container), the
 *   display value has no practical effect on rendering — it only controls
 *   whether pi's addMessageToChat adds a CustomMessageComponent.
 *
 * Memory context fencing format inspired by Hermes + Hindsight:
 * <hindsight_memories>
 * {preamble}
 *
 * {date/time if enabled}
 * {memories}
 * </hindsight_memories>
 *
 * The preamble IS the configurable system note that appears at the top.
 * By default, it contains the combined Hermes/Hindsight wording.
 *
 * Exported for testing.
 */
export function formatRecallMessage(
  results: RecallResponse["results"],
  preamble: string,
  showDateTime: boolean,
  display: boolean = false
): {
  role: "custom";
  customType: string;
  content: string;
  display: boolean;
  timestamp: number;
  details: RecallMessageDetails;
} {
  const memories = results.map((r) => r.text).join("\n\n---\n\n");

  // Build content with preamble first, then optional date/time, then memories
  const innerParts: string[] = [];

  // Preamble is the configurable system note (appears at top)
  innerParts.push(preamble);

  if (showDateTime) {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now);
    const dateStr =
      weekday +
      ", " +
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0");
    const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    // Get timezone abbreviation (e.g., "EST", "PST", "UTC")
    const timeZone =
      new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
    innerParts.push(`Current date and time: ${dateStr} ${timeStr} ${timeZone}`.trim());
  }

  innerParts.push(memories);

  // Wrap in hindsight_memories tags
  const content = `<hindsight_memories>
${innerParts.join("\n\n")}
</hindsight_memories>`;

  // Build details for custom renderer
  const count = results.length;
  const snippet = truncate(
    results
      .slice(0, 3)
      .map((r) => r.text)
      .join(" \u00b7 "),
    200
  );

  return {
    role: "custom",
    customType: "hindsight-recall",
    content,
    display,
    timestamp: Date.now(),
    details: { count, snippet, memories },
  };
}

/**
 * Render recall message details for display.
 * Returns plain text suitable for testing (no ANSI codes).
 * Exported for testing.
 */
export function renderRecallMessage(
  details: RecallMessageDetails,
  expanded: boolean,
  width?: number
): string {
  if (expanded) {
    // When expanded: show the full memory content
    const sepWidth = width ?? 80;
    return `Hindsight recalled ${details.count} ${details.count === 1 ? "memory" : "memories"}\n${"\u2500".repeat(sepWidth)}\n${details.memories}\n${"\u2500".repeat(sepWidth)}`;
  } else {
    // When collapsed: show summary with snippet
    return `Hindsight recalled ${details.count} ${details.count === 1 ? "memory" : "memories"} [${details.snippet}]`;
  }
}

/**
 * Options for the recall client wrapper.
 * Minimal interface for dependency injection in testing.
 */
export interface RecallClient {
  recall: (
    options: { query: string; types?: ("world" | "experience" | "observation")[] },
    signal: AbortSignal | undefined
  ) => Promise<{
    success: boolean;
    response?: RecallResponse;
    error?: string;
  }>;
}

/**
 * Options for auto-recall configuration.
 */
export interface AutoRecallConfig {
  recallMaxQueryChars: number;
  recallTypes: ("world" | "experience" | "observation")[] | null;
  recallPromptPreamble: string;
  recallShowDateTime: boolean;
}

/**
 * Perform auto-recall with the given query.
 * This is the core implementation shared by event handlers.
 *
 * @param client - The Hindsight client wrapper (or mock for testing)
 * @param query - The user's query text (will be truncated)
 * @param signal - AbortSignal for cancellation
 * @param display - Whether the recall message should be visible in TUI
 * @param config - Recall configuration
 * @param cacheDetails - Callback to cache recall details (receives null on no results)
 * @returns Object with recallMessage if results found, null otherwise
 *
 * Exported for testing.
 */
export async function doAutoRecallImpl(
  client: RecallClient | null,
  query: string,
  signal: AbortSignal | undefined,
  display: boolean,
  config: AutoRecallConfig,
  cacheDetails: (details: RecallMessageDetails | null) => void
): Promise<{ recallMessage: ReturnType<typeof formatRecallMessage> } | null> {
  if (!client) return null;

  // Truncate query safely (handles multi-byte Unicode)
  const truncatedQuery = truncate(query, config.recallMaxQueryChars);

  try {
    // Create a fallback signal if none provided
    const abortSignal = signal ?? new AbortController().signal;
    const result = await client.recall(
      { query: truncatedQuery, types: config.recallTypes ?? undefined },
      abortSignal
    );

    if (!result.success) {
      console.warn("Auto-recall failed:", result.error);
      cacheDetails(null);
      return null;
    }

    const response = result.response;
    const results = response?.results ?? [];

    if (results.length > 0) {
      const recallMessage = formatRecallMessage(
        results,
        config.recallPromptPreamble,
        config.recallShowDateTime,
        display
      );
      // Cache recall details for show-recall command
      cacheDetails(recallMessage.details);
      return { recallMessage };
    }

    cacheDetails(null);
    return null;
  } catch (e) {
    console.warn("Auto-recall error:", e);
    cacheDetails(null);
    return null;
  }
}
