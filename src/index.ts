/**
 * pi-hindsight extension entry point.
 *
 * Integrates Hindsight AI memory with pi coding agent using
 * turn-based queue with Hindsight's append mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RecallResponse } from "@vectorize-io/hindsight-client";
import { loadConfig, validateConfig } from "./config";
import { HindsightClientWrapper } from "./client";
import { registerTools } from "./tools";
import { registerCommands } from "./commands";
import { queueToolRetain, flushQueues, getQueueCount } from "./retention";
import { enqueueAutoMessage } from "./queue";
import { shouldRetainMessage, prepareEntry } from "./prepare";
import { extractTextFromContent, getSessionDisplayName, truncate, extractParentSessionId } from "./utils";

export default function (pi: ExtensionAPI) {
  // Load and validate config
  const { config, warning } = loadConfig();
  const validation = validateConfig(config);

  // Global disable check
  if (!config.enabled) {
    console.log("pi-hindsight disabled via config");
    return;
  }

  let client: HindsightClientWrapper | null = null;

  if (!validation.valid) {
    console.error("pi-hindsight disabled: " + validation.errors.join(", "));
  } else if (warning) {
    console.warn(warning);
  }

  if (validation.valid) {
    client = new HindsightClientWrapper(config);
    console.log("pi-hindsight initialized");
  }

  // Register tools (hindsight_retain always, hindsight_recall when configured)
  registerTools(pi, config, client);

  // Register slash commands
  registerCommands(pi, config, client);

  // Auto-recall on context event (only when last message is from user)
  // @ts-expect-error - AgentMessage union includes types without 'content' (e.g., BashExecutionMessage).
  // We filter to user messages with content at runtime.
  pi.on("context", async (event: { messages: Array<{ role: string; content?: unknown }> }, ctx: ExtensionContext) => {
    if (!client || !config.autoRecallEnabled) return;

    const messages = event.messages;

    // Only trigger recall if the last message is from user
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") return;

    const userMessage = extractTextFromContent(lastMessage.content);
    if (!userMessage) return;

    // Truncate query safely (handles multi-byte Unicode)
    const query = truncate(userMessage, config.recallMaxQueryChars);

    try {
      const result = await client.recall({ query, types: config.recallTypes ?? undefined }, ctx.signal);

      if (!result.success) {
        console.warn("Auto-recall failed:", result.error);
        return;
      }

      const response = result.response;
      const results = response?.results ?? [];

      if (results.length > 0) {
        const recallMessage = formatRecallMessage(results, config.recallPromptPreamble, config.recallShowDateTime);
        return { messages: [...messages, recallMessage] };
      }
    } catch (e) {
      console.warn("Auto-recall error:", e);
    }
  });

  // Queue messages on message_end event
  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    if (!config.autoRetainEnabled) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;

    // event.message is AgentMessage union (many types). Cast to Record for processing.
    const message = event.message as unknown as Record<string, unknown> | undefined;
    if (!message) return;

    // Check if this message type should be retained
    if (!shouldRetainMessage(message, config.retainContent)) return;

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

  // Flush queues on session switch (before leaving current session)
  pi.on("session_before_switch", async (_event, ctx: ExtensionContext) => {
    await flushCurrentSession(ctx, "before session switch");
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
   * Flush current session's queue to Hindsight.
   * @param ctx - Extension context
   * @param reason - Reason for flush (used in log messages)
   * @param notifyOnError - If true, show UI notification on error
   */
  async function flushCurrentSession(ctx: ExtensionContext, reason: string, notifyOnError = false): Promise<void> {
    if (!client) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;

    const count = getQueueCount(sessionId);
    if (count === 0) return;

    console.log(`pi-hindsight: Flushing ${count} messages ${reason}`);

    const header = ctx.sessionManager.getHeader();
    const sessionName = getSessionDisplayName(
      ctx.sessionManager.getSessionName.bind(ctx.sessionManager),
      ctx.sessionManager.getEntries.bind(ctx.sessionManager),
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
    );

    if (!result.success) {
      console.error("pi-hindsight: Flush failed:", result.error);
      if (notifyOnError) {
        ctx.ui.notify(`Hindsight flush failed: ${result.error}`, "error");
      }
    } else if (result.autoCount > 0 || result.toolCount > 0) {
      console.log(`pi-hindsight: Flushed ${result.autoCount} auto + ${result.toolCount} tool entries`);
    }
  }
}

/**
 * Format recall results into a hidden message with memory context fencing.
 * Precondition: results must be non-empty (caller checks results.length > 0).
 * Uses display: false so message is sent to LLM but not shown to user or persisted.
 *
 * Memory context fencing format inspired by Hermes + Hindsight:
 * <memory-context>
 * {preamble}
 *
 * {date/time if enabled}
 * {memories}
 * </memory-context>
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
): { role: "custom"; customType: string; content: string; display: boolean; timestamp: number } {
  const memories = results.map((r) => r.text).join("\n\n---\n\n");

  // Build content with preamble first, then optional date/time, then memories
  const innerParts: string[] = [];

  // Preamble is the configurable system note (appears at top)
  innerParts.push(preamble);

  if (showDateTime) {
    const now = new Date();
    const dateStr = now.getFullYear() + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0");
    const timeStr = String(now.getHours()).padStart(2, "0") + ":" +
      String(now.getMinutes()).padStart(2, "0");
    // Get timezone abbreviation (e.g., "EST", "PST", "UTC")
    const timeZone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(now)
      .find(p => p.type === "timeZoneName")?.value ?? "";
    innerParts.push(`Current date and time: ${dateStr} ${timeStr} ${timeZone}`.trim());
  }

  innerParts.push(memories);

  // Wrap in memory-context tags
  const content = `<memory-context>
${innerParts.join("\n\n")}
</memory-context>`;

  return {
    role: "custom",
    customType: "hindsight-recall",
    content,
    display: false,
    timestamp: Date.now(),
  };
}
