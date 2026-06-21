/**
 * epimetheus extension entry point.
 *
 * Integrates Hindsight AI memory with pi coding agent using
 * turn-based flush with Hindsight's replace mode.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { RecallResponse } from "@vectorize-io/hindsight-client";
import { HindsightClientWrapper } from "./client";
import { registerCommands, resetNotReadyWarned } from "./commands";
import { flushAllPending } from "./commands/session";
import {
  expandAutoRecallTagGroups,
  expandAutoRecallTags,
  loadConfig,
  type TagGroupInput,
  type TagsMatch,
  validateConfig,
} from "./config";
import { prefixLog, STATUS_ID } from "./constants";
import { getDataDir } from "./data-dir";
import { getLegacyDataDir, migrateDataDir } from "./data-dir-migration";
import { evaluateActiveSessionFlushState } from "./flush-config";
import { getHindsightMeta, shouldSessionBeRetained, updateSessionMetadata } from "./meta";
import { shouldRetainMessage } from "./prepare";
import { touchPendingFlag } from "./queue";
import { flushCurrentSession } from "./retention";
import {
  clearStartupReady,
  isOperationalReady,
  markStartupReady,
  resetActiveSessionFlushReady,
  resetRegisteredHindsightTools,
  resetStartupReady,
  setActiveSessionFlushReady,
} from "./runtime-state";
import { refreshToolVisibility, registerTools } from "./tools";
import { clearProjectNameCache, extractParentSessionId, getProjectName, truncate } from "./utils";
import { getHindsightCompatibilityError } from "./version";

// Runtime toggle for recall display (overrides config)
let autoRecallDisplayOverride: boolean | null = null;

// Cache last recall message for context handler re-injection (autoRecallPersist: true)
// Consumed once per turn by the context handler.
let lastRecallMessage: ReturnType<typeof formatRecallMessage> | null = null;

// Last recall details for the popup command — persists across turns
// (not consumed by the context handler like lastRecallMessage is).
let lastRecallDetails: RecallMessageDetails | null = null;

// Track the last compatibility warning so we don't spam session_start events.
let lastCompatibilityMessage: string | null = null;

// Hindsight tools are process-global and registered lazily from session_start.
// This is separate from startupReady: readiness gates operational handlers,
// while toolsRegistered only makes registerTools() idempotent.
let toolsRegistered = false;

// In-flight health/version probe shared by overlapping readiness checks.
// Cleared after each attempt so failures can be retried; successful readiness
// is recorded in runtime-state's startupReady latch.
let startupReadyPromise: Promise<boolean> | null = null;

/**
 * Reset module-level mutable state. Exported for testing only.
 */
export function _resetState(): void {
  autoRecallDisplayOverride = null;
  lastRecallMessage = null;
  lastRecallDetails = null;
  lastCompatibilityMessage = null;
  toolsRegistered = false;
  startupReadyPromise = null;
  resetStartupReady();
  resetActiveSessionFlushReady();
  resetRegisteredHindsightTools();
  clearProjectNameCache();
  resetNotReadyWarned();
}

/**
 * Register a context handler that filters hindsight-recall messages from
 * being sent to the LLM. Only used in disabled mode.
 *
 * In enabled mode, the main context handler performs filtering as part of
 * recall re-injection.
 *
 * This only matters when autoRecallPersist is true (the default is false) and
 * old sessions with persisted entries are resumed. It is not a huge deal for
 * sessions that are not resumed, but autoRecallPersist is off by default for
 * this reason.
 *
 * If pi provided a way to render custom entries or to exclude custom_message
 * entries from convertToLlm, this filter would not be needed.
 */
function registerRecallFilter(pi: ExtensionAPI): void {
  pi.on("context", async (event) => {
    const messages = event.messages as Array<{ customType?: string }>;
    const filtered = messages.filter((msg) => msg.customType !== "hindsight-recall");
    if (filtered.length !== messages.length) {
      return { messages: filtered } as Record<string, unknown>;
    }
  });
}

/**
 * Register the custom message renderer for hindsight-recall messages.
 * The getDisplay callback is consulted on every render() call, enabling
 * dynamic show/hide when the user toggles display at runtime.
 *
 * @param getDisplay - Returns whether recall messages should be visible
 */
function registerRecallRenderer(pi: ExtensionAPI, getDisplay: () => boolean): void {
  pi.registerMessageRenderer<RecallMessageDetails>(
    "hindsight-recall",
    (message, { expanded }, theme) => {
      const details = message.details;
      if (!details) return undefined;

      if (expanded) {
        return new RecallExpandedComponent(details, theme, getDisplay);
      }

      return new RecallCollapsedComponent(details, theme, getDisplay);
    }
  );
}

export default function (pi: ExtensionAPI) {
  // One-time data-dir migration (legacy <agentdir>/extensions/pi-hindsight →
  // <agentdir>/epimetheus). Runs before config load / new-dir creation so the
  // config and data the rest of the extension reads already lives in the new
  // location. Non-destructive copy; safe to run on every startup (a marker
  // file makes it a silent no-op once done).
  const migration = migrateDataDir();
  if (migration.action === "copied") {
    console.log(
      prefixLog(
        `migrated data directory to ${getDataDir()} (copied from ${getLegacyDataDir()}). ` +
          `The legacy directory was left in place; remove it after verifying the migration.`
      )
    );
  } else if (migration.action === "warned" && migration.message) {
    console.warn(migration.message);
  }

  // Load and validate config
  const { config, configPath, warning, envVars } = loadConfig();
  const validation = validateConfig(config);

  // Global disable check
  // Even when disabled, we register handlers to ensure:
  // 1. hindsight-recall messages are filtered from LLM context (prevents stale
  //    recalls from reaching the model)
  // 2. The custom message renderer is registered so persisted recall messages
  //    display correctly based on autoRecallDisplay:
  //    - autoRecallDisplay: true  → messages render with formatted content
  //    - autoRecallDisplay: false → renderer hides messages from the chat
  //      (returns empty lines), preventing raw custom message data from showing
  if (!config.enabled) {
    console.log(prefixLog("disabled via config"));

    // Filter hindsight-recall messages from context
    registerRecallFilter(pi);

    // Register custom message renderer. autoRecallDisplayOverride is not
    // consulted because the toggle-display command is not registered in
    // disabled mode, so the override can never be set.
    registerRecallRenderer(pi, () => config.autoRecallDisplay);

    return;
  }

  let client: HindsightClientWrapper | null = null;

  if (warning) {
    console.warn(warning);
  }
  if (validation.warnings && validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      console.warn(w);
    }
  }

  // Fail fast on invalid config: no client, tools, auto-retain, auto-recall,
  // metadata, session-state, or queue writes. Still register recall display
  // handlers and read-only /hindsight diagnostics so users can inspect why the
  // extension is unavailable.
  //
  // Previously the full handler set was still registered with a null client,
  // and session_start could append hindsight-meta / write session-state before
  // reaching the hasUsableConfig check.
  if (!validation.valid) {
    for (const error of validation.errors) {
      console.error(error);
    }
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setStatus(STATUS_ID, config.statusUnhealthy);
    });
    registerRecallFilter(pi);
    registerRecallRenderer(pi, () => autoRecallDisplayOverride ?? config.autoRecallDisplay);
    registerCommands(
      pi,
      config,
      null,
      () => lastRecallDetails,
      () => autoRecallDisplayOverride,
      (value) => {
        autoRecallDisplayOverride = value;
      },
      () => false,
      {
        configPath,
        envVars,
        warning,
        validationWarnings: [...validation.errors, ...validation.warnings],
      }
    );
    return;
  }

  client = new HindsightClientWrapper(config);

  /**
   * Probe server reachability + version compatibility and update the status bar.
   *
   * This deliberately does not latch readiness, register tools, create
   * metadata, or update retain visibility. Callers decide what to do with the
   * boolean result. Compatibility warnings are deduped across probes.
   */
  async function probeStartupHealth(
    targetClient: HindsightClientWrapper | null,
    ctx: ExtensionContext
  ): Promise<boolean> {
    if (!targetClient) {
      ctx.ui.setStatus(STATUS_ID, config.statusUnhealthy);
      return false;
    }
    // Verify server is reachable before querying version.
    const healthResult = await targetClient.healthCheck(ctx.signal);
    if (!healthResult.success) {
      ctx.ui.setStatus(STATUS_ID, config.statusUnhealthy);
      return false;
    }

    // Verify server version compatibility.
    const versionResult = await targetClient.getServerVersion(ctx.signal);
    const compatibilityError = versionResult.success
      ? getHindsightCompatibilityError(versionResult.version)
      : `Unable to query Hindsight server version: ${versionResult.error ?? "unknown error"}`;
    if (compatibilityError) {
      if (compatibilityError !== lastCompatibilityMessage) {
        ctx.ui.notify(compatibilityError, "warning");
        lastCompatibilityMessage = compatibilityError;
      }
      ctx.ui.setStatus(STATUS_ID, config.statusUnhealthy);
      return false;
    }

    ctx.ui.setStatus(STATUS_ID, config.statusHealthy);
    return true;
  }

  /**
   * Probe server health + version and update the readiness latch. Single-flight
   * so overlapping `session_start` callers share one probe pass.
   *
   * Readiness is re-enterable: there is no fast-path skip when already latched.
   * Every call probes and updates the latch (`true` on success, `false` on
   * failure via {@link clearStartupReady}) so that a later `session_start`
   * observing an unreachable/incompatible server re-enters the unified degraded
   * mode (all tools hidden, auto-recall/retain/flush skipped, operational
   * commands blocked). A subsequent healthy probe restores readiness.
   *
   * This helper must not perform session setup (metadata, tools, visibility,
   * startup flush) — that stays in `session_start`.
   */
  function ensureStartupReady(ctx: ExtensionContext): Promise<boolean> {
    // Single-flight: a concurrent session_start joins the in-flight probe.
    if (startupReadyPromise) return startupReadyPromise;

    startupReadyPromise = (async () => {
      try {
        const healthy = await probeStartupHealth(client, ctx);
        if (healthy) markStartupReady();
        else clearStartupReady();
        return healthy;
      } finally {
        // Clear so a failed attempt can be retried, and so a post-latch caller
        // never observes a stale resolved promise.
        startupReadyPromise = null;
      }
    })();
    return startupReadyPromise;
  }

  pi.on("session_start", async (event, ctx) => {
    // session_start owns per-session setup. Health/version readiness is probed
    // every time (re-enterable): a failed probe re-enters the unified degraded
    // mode (startupReady=false → isOperationalReady=false → all tools hidden,
    // auto-recall/retain/flush skipped, operational commands blocked); a healthy
    // probe restores readiness. setup then runs on every session_start so
    // new/resumed sessions get their own metadata and tool visibility.
    const probeHealthy = await ensureStartupReady(ctx);
    if (!probeHealthy) {
      // Server unreachable/incompatible → unified degraded mode. Status was
      // already set unhealthy by probeStartupHealth. If tools were already
      // registered (e.g. from a prior healthy session_start), hide ALL of them
      // now that we've re-entered degraded mode (isOperationalReady() is false).
      // On a first-ever failed start, no tools are registered yet — tools
      // register lazily only on a healthy session_start, so there is nothing to
      // hide and no setActiveTools call. activeSessionFlushReady is left as-is;
      // the server failure is the degraded cause for this session.
      if (toolsRegistered) {
        refreshToolVisibility(pi, false);
      }
      return;
    }

    // Validate the active session's project-local flush-config state BEFORE
    // enabling operational behavior (retain tool visibility, auto-mark metadata,
    // startup flush). An invalid/required-but-missing cwd-local flush config
    // hard-fails the ACTIVE session through this degraded pathway: unhealthy
    // status, retain tool hidden, auto-retain skipped (see message_end), and no
    // startup flush. Diagnostic commands (/hindsight status, /hindsight
    // config) and the recovery command (/hindsight detach-flush-config, which
    // is NOT in OPERATIONAL_SUBCOMMANDS) remain available. The flush path
    // (parseAndUpsertSession) re-validates freshly so flush-pending still
    // handles other sessions and catches files that disappeared later.
    const entries = ctx.sessionManager.getEntries();
    const existingMeta = getHindsightMeta(entries);
    const sessionHeader = ctx.sessionManager.getHeader();
    const sessionCwd = sessionHeader?.cwd ?? ctx.cwd;
    const flushState = evaluateActiveSessionFlushState(sessionCwd, existingMeta);

    if (!flushState.ready) {
      // Active session is in failed project-local flush-config state → single
      // degraded mode: unhealthy status, ALL Hindsight tools hidden (not just
      // retain), no auto-retain (message_end), no startup flush. Diagnostic
      // commands (/hindsight status, /hindsight config, /hindsight toggle-display,
      // /hindsight popup) and the recovery command (/hindsight detach-flush-config,
      // which is NOT in OPERATIONAL_SUBCOMMANDS) remain available. The flush path
      // (parseAndUpsertSession) re-validates freshly per target session so
      // flush-pending still handles other sessions and catches files that
      // disappeared later.
      setActiveSessionFlushReady(false);
      ctx.ui.setStatus(STATUS_ID, config.statusUnhealthy);
      ctx.ui.notify(
        `Hindsight active session unavailable: ${flushState.reason}. ` +
          `All Hindsight tools are hidden and retention is disabled for this session. ` +
          `Run \`/hindsight detach-flush-config\` to stop requiring the project-local ` +
          `flush config, or fix ${sessionCwd ?? "<cwd>"}/.pi/epimetheus/flush-config.jsonc.`,
        "warning"
      );
      // Register hindsight tools once (process-global) so they can be
      // re-shown when the session recovers; then hide ALL of them via the
      // unified visibility refresh (isOperationalReady() is false here, so
      // refreshToolVisibility hides every registered hindsight_* tool).
      if (!toolsRegistered) {
        registerTools(pi, config, client);
        toolsRegistered = true;
      }
      refreshToolVisibility(pi, false);
      return;
    }

    // Active session flush-config OK. Mirror this in the per-session latch so
    // message_end auto-retain and the retain tool visibility reflect the now-
    // healthy session (a prior failed session may have left it false).
    setActiveSessionFlushReady(true);

    // Auto-create session metadata if none exists, using retainSessionsByDefault
    // as the default retained state. This ensures every session has explicit
    // metadata, so toggle-retain and other commands work predictably.
    //
    // If a valid cwd-local flush config exists for an unmarked session,
    // auto-mark usesProjectFlushConfig:true so future flushes require it
    // (latest value wins, so an explicit false from /hindsight
    // detach-flush-config survives — auto-mark only fires when the flag is
    // still undefined).
    if (!existingMeta) {
      const sessionId = ctx.sessionManager.getSessionId();
      const updates: Partial<{ retained: boolean; usesProjectFlushConfig: boolean }> = {
        retained: config.retainSessionsByDefault,
      };
      if (flushState.autoMark) updates.usesProjectFlushConfig = true;
      await updateSessionMetadata(pi, sessionId, entries, updates, config);
    } else if (existingMeta.usesProjectFlushConfig === undefined && flushState.autoMark) {
      // Legacy session without an explicit usesProjectFlushConfig flag. Auto-mark
      // true without touching pending (the flag affects future flushes; the
      // user can re-flush manually if they want retroactive tag correction).
      // Explicit user detach (usesProjectFlushConfig:false) is preserved because
      // latest-wins only re-marks when the flag is still undefined.
      const sessionId = ctx.sessionManager.getSessionId();
      await updateSessionMetadata(pi, sessionId, entries, { usesProjectFlushConfig: true }, config);
    }

    // Register hindsight tools once (process-global). Late registration
    // auto-activates the tools via refreshTools, so they are visible from the
    // first agent turn on. Idempotent — only the first session_start reaching
    // here with toolsRegistered false registers; later session_starts skip this
    // for tools but still run the per-session metadata/visibility work.
    if (!toolsRegistered) {
      registerTools(pi, config, client);
      toolsRegistered = true;
    }
    // Refresh tool visibility for the unified operational state + this
    // session's retention flag. Operational here (startupReady latched and the
    // active-session flush config just validated OK), so all registered tools
    // are shown except hindsight_retain when the session is not retained.
    refreshToolVisibility(pi, shouldSessionBeRetained(entries, config));

    // On startup, optionally flush pending work across all sessions. This is
    // reason-gated to `session_start` only — it is a best-effort cleanup of old
    // pending sessions, not a readiness prerequisite.
    if (event.reason === "startup" && config.autoFlushPendingOn.includes("startup") && client) {
      await flushAllPending(config, client, ctx, { notifyNoWork: false, autoFlush: true });
    }
  });

  // Tools are registered lazily in the session_start success path (after
  // health + version checks pass), not at extension init. This means no
  // hindsight_* tool exists until the first healthy session_start (whenever
  // it occurs), and there is no init-time global setActiveTools hide call. Recall
  // filter/renderer and the /hindsight command are still registered now.

  // Register slash commands (pass getter/setter for runtime state)
  registerCommands(
    pi,
    config,
    client,
    () => lastRecallDetails,
    () => autoRecallDisplayOverride,
    (value) => {
      autoRecallDisplayOverride = value;
    },
    isOperationalReady,
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
  const getRecallDisplay = () => autoRecallDisplayOverride ?? config.autoRecallDisplay;

  // Register custom message renderer for hindsight-recall messages.
  // Uses dynamic components that check the runtime toggle on every render()
  // call, so toggling display immediately shows/hides existing messages.
  registerRecallRenderer(pi, getRecallDisplay);

  // Auto-recall on before_agent_start.
  // Always performs recall and caches the result for the context handler to re-inject.
  // Only returns the message (persisting it to session) when autoRecallPersist is true.
  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!client || !config.autoRecallEnabled) return;

    // session_start is awaited before the first prompt in current Pi (interactive,
    // print, and RPC), so by the time before_agent_start fires, startup readiness
    // and the active session's flush-config state have already been evaluated.
    // Only check the unified operational state here and return if degraded —
    // never probe or mutate readiness from before_agent_start (that risks
    // surprising first-prompt side effects and is session_start's job). If the
    // session is degraded (server unreachable/incompatible, or required-but-
    // missing/invalid cwd-local flush config), auto-recall is skipped for this
    // turn; the first turn after recovery will recall.
    if (!isOperationalReady()) return;

    // Use event.prompt directly — available before the user message is
    // persisted to the session (fixes first-message recall).
    const query = event.prompt;
    if (!query) return;

    // display controls whether the recall message is shown in the TUI.
    // When autoRecallPersist is true, always use display: true so the message is
    // added to the TUI chat container. The custom renderer dynamically checks
    // the runtime toggle on every render() call to show/hide the content.
    // When autoRecallPersist is false, the message is ephemeral (re-injected only
    // by the context handler), so display controls the context handler's
    // message visibility directly.
    const displayValue = config.autoRecallPersist
      ? true
      : (autoRecallDisplayOverride ?? config.autoRecallDisplay);

    // Call shared recall helper
    const header = ctx.sessionManager.getHeader();
    const sessionId = ctx.sessionManager.getSessionId();
    // sessionId is always available by before_agent_start (set during session_start),
    // so this guard is purely defensive and not practically reachable
    if (!sessionId) {
      ctx.ui.notify(prefixLog("auto-recall skipped: no active session"), "warning");
      return;
    }
    const sessionCwd = header?.cwd ?? ctx.cwd;
    const parentSessionId = extractParentSessionId(header?.parentSession);
    const result = await doAutoRecall(
      query,
      ctx.signal,
      displayValue,
      sessionId,
      sessionCwd,
      parentSessionId
    );
    if (result) {
      lastRecallMessage = result.recallMessage;
      lastRecallDetails = result.recallMessage.details;
      // Only persist to session file when autoRecallPersist is true
      if (config.autoRecallPersist) {
        return { message: result.recallMessage };
      }
    }
  });

  // Context event handler:
  // 1. Always filter out hindsight-recall custom messages from being sent to the LLM
  //    (only matters when autoRecallPersist is true and old sessions are resumed)
  // 2. Re-inject cached recall from before_agent_start as the configured role
  //    (user or assistant, per autoRecallRole config)
  pi.on("context", async (event, _ctx: ExtensionContext) => {
    const messages = event.messages as Array<{
      role: string;
      content?: unknown;
      customType?: string;
    }>;

    // Always filter out existing hindsight-recall messages from the messages array.
    // This is critical to prevent old recall messages from being sent to the LLM
    const filteredMessages = messages.filter((msg) => msg.customType !== "hindsight-recall");
    const hadRecallMessages = filteredMessages.length !== messages.length;

    // Re-inject the cached recall from before_agent_start.
    // before_agent_start always does the recall and caches the message here.
    // When autoRecallPersist: true, the message was also persisted to the session file
    // (as a custom_message for TUI display); when autoRecallPersist: false, it's
    // ephemeral (re-injected here only for this turn).
    // The recall is injected as the configured role (user or assistant) so the LLM
    // receives it as a proper conversation message, not a custom message.
    const cachedRecall = lastRecallMessage;
    lastRecallMessage = null; // Clear after reading (consume once per turn)
    if (cachedRecall) {
      lastRecallDetails = cachedRecall.details;
      // Content must be in the format expected by the provider:
      // - user role: string or content array (pi's convertToLlm handles both)
      // - assistant role: content array [{ type: "text", text: "..." }] (plain string
      //   would fail because provider SDKs expect .flatMap on assistant content)
      const recallContent =
        config.autoRecallRole === "assistant"
          ? [{ type: "text", text: cachedRecall.content }]
          : cachedRecall.content;
      const recallMessage: Record<string, unknown> = {
        role: config.autoRecallRole,
        content: recallContent,
        timestamp: cachedRecall.timestamp,
      };
      return { messages: [...filteredMessages, recallMessage] } as Record<string, unknown>;
    }

    // If we filtered out recall messages but didn't re-inject, return filtered array
    if (hadRecallMessages) {
      return { messages: filteredMessages } as Record<string, unknown>;
    }
  });

  // Mark sessions as dirty on message_end event
  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    if (!config.autoRetainEnabled || !isOperationalReady()) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) {
      ctx.ui.notify(prefixLog("auto-retain skipped: no active session"), "warning");
      return;
    }

    // Check if session is retained
    const entries = ctx.sessionManager.getEntries();
    if (!shouldSessionBeRetained(entries, config)) return;

    // event.message is AgentMessage union (many types). Cast to Record for processing.
    const message = event.message as unknown as Record<string, unknown> | undefined;
    if (!message) return;

    // Check if this message type should be retained
    if (!shouldRetainMessage(message, config.retainContent, config.toolFilter)) return;

    // Touch the pending marker — session needs re-upsert on next flush
    const result = touchPendingFlag(sessionId);
    if (!result.success) {
      ctx.ui.notify(`Failed to queue session for retention: ${result.error}`, "warning");
    }
  });

  /** Auto-flush: suppresses transient block notifications unless debug mode is on. */
  const autoFlush = async (ctx: ExtensionContext): Promise<void> => {
    if (!client || !isOperationalReady()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionId || !sessionPath) return;
    await flushCurrentSession(sessionId, sessionPath, config, client, ctx, ctx.signal, {
      autoFlush: true,
    });
  };

  /**
   * Return an {@link ExtensionContext} whose `ui.notify` calls for `warning`
   * and `error` levels are also echoed to the console (via `console.warn` /
   * `console.error`). Used for `session_shutdown` with `reason: "quit"`, where
   * pi stops the TUI before running shutdown handlers — so `ctx.ui.notify`
   * warnings (extra-context guard, retention disabled, parse warnings, upsert/
   * queue failures) are no longer visible. `info`-level notifications are not
   * echoed, so quit stays quiet for success/no-work unless `debug: true` already
   * surfaces them through the normal notify path.
   *
   * All other `ctx`/`ui` members pass through unchanged. Uses a Proxy, not a
   * clone, so prototype-backed members on the real ExtensionContext are kept.
   */
  const withWarningErrorConsoleEcho = (ctx: ExtensionContext): ExtensionContext => {
    const echoUi = new Proxy(ctx.ui as object, {
      get(target, prop, receiver) {
        if (prop === "notify") {
          const notify = Reflect.get(target, "notify", target) as (
            message: string,
            level?: "info" | "warning" | "error"
          ) => void;
          return (message: string, level?: "info" | "warning" | "error") => {
            notify(message, level);
            if (level === "warning") {
              console.warn(prefixLog(message));
            } else if (level === "error") {
              console.error(prefixLog(message));
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return new Proxy(ctx as object, {
      get(target, prop, receiver) {
        if (prop === "ui") {
          return echoUi;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ExtensionContext;
  };

  /**
   * Return a wrapped {@link ExtensionContext} plus a `replay()` function. The
   * wrapped ctx buffers `ui.notify` calls instead of emitting them immediately.
   * Used for `session_compact`, where synchronous `ctx.ui.notify` feedback can
   * be swallowed by the compact transition — calling `replay()` on the next
   * tick (once the TUI has settled) re-emits the buffered notifications through
   * the real `ctx.ui.notify`.
   *
   * Only `notify` is intercepted; every other `ui`/`ctx` member passes through
   * unchanged (Proxy-based, so prototype-backed members are preserved). The
   * flush itself still runs synchronously and performs its real work (upsert /
   * queue drain) — only the notifications are deferred.
   */
  const withNotifyCapture = (
    ctx: ExtensionContext
  ): { ctx: ExtensionContext; replay: () => void } => {
    const captured: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
    const captureUi = new Proxy(ctx.ui as object, {
      get(target, prop, receiver) {
        if (prop === "notify") {
          return (message: string, level?: "info" | "warning" | "error") => {
            captured.push({ message, level });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const captureCtx = new Proxy(ctx as object, {
      get(target, prop, receiver) {
        if (prop === "ui") {
          return captureUi;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ExtensionContext;
    return {
      ctx: captureCtx,
      replay: () => {
        for (const { message, level } of captured) {
          ctx.ui.notify(message, level);
        }
      },
    };
  };

  // Flush queues and reset recall cache on session switch (/new, /resume)
  pi.on("session_before_switch", async (_event, ctx: ExtensionContext) => {
    lastRecallMessage = null;
    lastRecallDetails = null;
    if (config.autoFlushSessionOn.includes("switch")) {
      await autoFlush(ctx);
    }
  });

  // Flush queues and reset recall cache before forking (/fork, /clone)
  pi.on("session_before_fork", async (_event, ctx: ExtensionContext) => {
    lastRecallMessage = null;
    lastRecallDetails = null;
    if (config.autoFlushSessionOn.includes("fork")) {
      await autoFlush(ctx);
    }
  });

  // Flush queues and reset recall cache before navigating in the session tree
  // (/navigate-tree). Like switch/fork, the active session is about to change,
  // so pending work is flushed first. Off by default; enabled via
  // autoFlushSessionOn including "tree". Uses auto-flush semantics: routine
  // block/not-retained warnings and success/no-work are suppressed unless
  // debug; true errors still surface.
  pi.on("session_before_tree", async (_event, ctx: ExtensionContext) => {
    lastRecallMessage = null;
    lastRecallDetails = null;
    if (config.autoFlushSessionOn.includes("tree")) {
      await autoFlush(ctx);
    }
  });

  // Flush queues after compaction. The compact transition can swallow
  // synchronous `ctx.ui.notify` feedback, so notifications emitted during the
  // flush are captured and replayed via the real `ctx.ui.notify` on the next
  // tick, once the TUI has settled. Compact uses auto-flush notification
  // semantics: success, no-work, and block/not-retained warnings are suppressed
  // unless `debug: true` (compaction is not a final-chance event like `/quit`).
  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    if (!config.autoFlushSessionOn.includes("compact") || !client || !isOperationalReady()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionId || !sessionPath) return;
    const { ctx: captureCtx, replay } = withNotifyCapture(ctx);
    await flushCurrentSession(sessionId, sessionPath, config, client, captureCtx, ctx.signal, {
      autoFlush: true,
    });
    // Replay captured notifications after the handler unwinds so they reach a
    // settled TUI instead of being swallowed mid-compact.
    setTimeout(replay, 0);
  });

  // Flush queues on session shutdown (reload/quit only).
  // For new/resume/fork, session_before_switch or session_before_fork already flushed.
  //
  // reload: auto-flush the current active session (notifications suppressed unless debug).
  // quit: two configurable modes —
  //   - `autoFlushPendingOn` includes "quit" (default): run the flush-pending flow
  //     across all sessions. pi stops the TUI before shutdown handlers, so warning/error
  //     notifications are mirrored to the console so blocking/failure feedback is visible.
  //   - else if `autoFlushSessionOn` includes "quit": flush only the current active
  //     session with console-mirrored warnings/errors.
  //   If "quit" is in both, pending takes precedence and the active-session flush is
  //     skipped to avoid duplicate work (see config validation warning).
  pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") return;
    if (!client || !isOperationalReady()) return;
    if (event.reason === "reload") {
      if (!config.autoFlushSessionOn.includes("reload")) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionId || !sessionPath) return;
      await flushCurrentSession(sessionId, sessionPath, config, client, ctx, ctx.signal, {
        autoFlush: true,
      });
      return;
    }
    if (event.reason === "quit") {
      if (config.autoFlushPendingOn.includes("quit")) {
        await flushAllPending(config, client, ctx, {
          notifyNoWork: false,
          ctxWrapper: withWarningErrorConsoleEcho,
        });
        return;
      }
      if (config.autoFlushSessionOn.includes("quit")) {
        const sessionId = ctx.sessionManager.getSessionId();
        const sessionPath = ctx.sessionManager.getSessionFile();
        if (!sessionId || !sessionPath) return;
        const flushCtx = withWarningErrorConsoleEcho(ctx);
        await flushCurrentSession(sessionId, sessionPath, config, client, flushCtx, ctx.signal, {
          autoFlush: false,
          surfaceBlocks: true,
        });
      }
    }
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
    display: boolean,
    sessionId: string,
    sessionCwd: string,
    parentSessionId?: string
  ): Promise<{ recallMessage: ReturnType<typeof formatRecallMessage> } | null> {
    // Expand recall tag placeholders with session context
    const placeholderParams = {
      sessionId,
      sessionCwd,
      parentSessionId,
      projectName: getProjectName(sessionCwd),
    };
    const expandedTags = expandAutoRecallTags(config.autoRecallTags, placeholderParams);
    const expandedTagGroups = expandAutoRecallTagGroups(
      config.autoRecallTagGroups,
      placeholderParams
    );
    const recallConfig: AutoRecallConfig = {
      recallMaxQueryChars: config.recallMaxQueryChars,
      autoRecallTypes: config.autoRecallTypes,
      recallPromptPreamble: config.recallPromptPreamble,
      autoRecallShowDateTime: config.autoRecallShowDateTime,
      autoRecallTags: expandedTags,
      autoRecallTagsMatch: config.autoRecallTagsMatch,
      autoRecallTagGroups: expandedTagGroups,
    };
    // Clear stale recall on error/no-results (doAutoRecallImpl calls cacheDetails(null))
    return doAutoRecallImpl(client, query, signal, display, recallConfig, (details) => {
      lastRecallMessage = null;
      lastRecallDetails = details;
    });
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
 * - When autoRecallPersist is true, display is always true (message is persisted to
 *   session and added to chat container; the custom renderer dynamically checks
 *   the runtime toggle to show/hide content).
 * - When autoRecallPersist is false, the caller passes the current
 *   autoRecallDisplay/override value, which may be true or false. However, since
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
 * Options for the recall client wrapper.
 * Minimal interface for dependency injection in testing.
 */
export interface RecallClient {
  recall: (
    options: {
      query: string;
      types?: ("world" | "experience" | "observation")[];
      tags?: string[];
      tagsMatch?: TagsMatch;
      tagGroups?: TagGroupInput[];
    },
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
  autoRecallTypes: ("world" | "experience" | "observation")[] | null;
  recallPromptPreamble: string;
  autoRecallShowDateTime: boolean;
  autoRecallTags: string[] | null;
  autoRecallTagsMatch: TagsMatch;
  autoRecallTagGroups: TagGroupInput[] | null;
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
      {
        query: truncatedQuery,
        types: config.autoRecallTypes ?? undefined,
        tags: config.autoRecallTags ?? undefined,
        tagsMatch: config.autoRecallTags ? config.autoRecallTagsMatch : undefined,
        tagGroups: config.autoRecallTagGroups ?? undefined,
      },
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
        config.autoRecallShowDateTime,
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
