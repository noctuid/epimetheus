/**
 * Tests for the real entrypoint bootstrap.
 *
 * Uses a mutable state pattern for mock.module() to avoid re-mocking
 * between tests (which is fragile in Bun's module system). The mock
 * reads from `activeConfig`, `activeClientFactory`, etc., and each test
 * sets those variables before importing/exercising the extension.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// Import the real config module BEFORE mocking to preserve exports
import * as realConfig from "../src/config";

import {
  cleanupParsedArtifacts,
  createMockContext,
  createMockPi,
  HINDSIGHT_ENV_KEYS,
  readToolQueueFromDisk,
  saveEnvKeys,
  setupTempAgentDir,
  testConfig,
} from "./fixtures";

// ============================================
// Setup: redirect agent-dir filesystem operations to temp directory
// ============================================

setupTempAgentDir("bootstrap");
// ============================================
// Mutable state for mock.module() — tests set these before exercising handlers
// ============================================

/** Active config that the mocked loadConfig() returns. */
let activeConfig: realConfig.HindsightConfig = { ...testConfig };

/** Active loadConfig warning. */
let activeWarning: string | undefined;

/** Factory that creates the mock client class. Tests override to change healthCheck/version behavior. */
let activeClientFactory: () => {
  healthCheck: ReturnType<typeof mock>;
  getServerVersion?: ReturnType<typeof mock>;
  retain: ReturnType<typeof mock>;
  retainBatch: ReturnType<typeof mock>;
  recall: ReturnType<typeof mock>;
  reflect: ReturnType<typeof mock>;
} = () => ({
  healthCheck: mock(() => Promise.resolve({ success: true })),
  getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
  retain: mock(() => Promise.resolve({ success: true })),
  retainBatch: mock(() => Promise.resolve({ success: true })),
  recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
  reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
});

// ============================================
// Top-level module mocks (set once, read from mutable state)
// ============================================

mock.module("../src/config", () => ({
  ...realConfig,
  loadConfig: () => ({
    config: activeConfig,
    configPath: undefined,
    warning: activeWarning,
    envVars: [],
  }),
}));

mock.module("@vectorize-io/hindsight-client", () => ({
  HindsightError: class extends Error {
    statusCode: number;
    constructor(msg: string, statusCode: number) {
      super(msg);
      this.statusCode = statusCode;
    }
  },
}));

mock.module("../src/client", () => ({
  HindsightClientWrapper: class {
    healthCheck = activeClientFactory().healthCheck;
    getServerVersion =
      activeClientFactory().getServerVersion ??
      mock(() => Promise.resolve({ success: true, version: "0.9.0" }));
    retain = activeClientFactory().retain;
    retainBatch = activeClientFactory().retainBatch;
    recall = activeClientFactory().recall;
    reflect = activeClientFactory().reflect;
  },
}));

const BOOTSTRAP_SESSION = "test-bootstrap-session";

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = saveEnvKeys(HINDSIGHT_ENV_KEYS);
});

afterEach(async () => {
  const { removePendingFlag, clearSessionQueueState } =
    require("../src/queue") as typeof import("../src/queue");
  removePendingFlag(BOOTSTRAP_SESSION);
  clearSessionQueueState(BOOTSTRAP_SESSION);

  // Clean up parsed-session artifacts to prevent stale artifacts from blocking flushes
  cleanupParsedArtifacts(BOOTSTRAP_SESSION);

  // Reset module-level mutable state (autoRecallDisplayOverride, lastRecallMessage)
  // to prevent test order dependencies — toggle-display tests mutate this state
  // and the module is cached by Bun's module system.
  const { _resetState } = require("../src/index") as typeof import("../src/index");
  _resetState();

  // Reset active state for next test
  activeConfig = { ...testConfig };
  activeWarning = undefined;
  activeClientFactory = () => ({
    healthCheck: mock(() => Promise.resolve({ success: true })),
    getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
    retain: mock(() => Promise.resolve({ success: true })),
    retainBatch: mock(() => Promise.resolve({ success: true })),
    recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
    reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
  });

  restoreEnv();
});

describe("real entrypoint bootstrap", () => {
  it("registers all expected event handlers", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const expectedEvents = [
      "session_start",
      "context",
      "message_end",
      "before_agent_start",
      "session_before_switch",
      "session_before_fork",
      "session_compact",
      "session_shutdown",
    ];

    for (const event of expectedEvents) {
      expect(pi.handlers.has(event), `handler for ${event} should be registered`).toBe(true);
      expect(typeof pi.handlers.get(event), `handler for ${event} should be a function`).toBe(
        "function"
      );
    }
  });

  it("registers hindsight tools", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const toolNames = pi.tools.map((t) => t.name);
    expect(toolNames).toContain("hindsight_retain");
    expect(toolNames).toContain("hindsight_recall");
    expect(toolNames).toContain("hindsight_reflect");
  });

  it("registers /hindsight command", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    expect(pi.commands.has("hindsight")).toBe(true);
  });

  it("registers hindsight-recall message renderer", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    expect(pi.renderers.has("hindsight-recall")).toBe(true);
  });

  it("renderer returns dynamic components that respect display toggle", async () => {
    activeConfig = { ...testConfig, autoRecallPersist: true, autoRecallDisplay: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const renderer = pi.renderers.get("hindsight-recall") as (
      message: Record<string, unknown>,
      options: { expanded: boolean },
      theme: Record<string, unknown>
    ) => { render: (width: number) => string[] } | undefined;
    expect(renderer).toBeDefined();

    const details = {
      count: 2,
      snippet: "Memory 1 · Memory 2",
      memories: "Memory 1\n\n---\n\nMemory 2",
    };
    const message = {
      role: "custom",
      customType: "hindsight-recall",
      content: "test",
      display: true,
      details,
    };
    const mockTheme = {
      fg: (_name: string, text: string) => text,
      bg: (_name: string, text: string) => text,
    };

    // Create collapsed component — default state: autoRecallDisplay false → hidden
    const collapsed = renderer(message, { expanded: false }, mockTheme)!;
    expect(collapsed.render(80)).toEqual([]);

    // Toggle display ON via the command handler
    const commandHandler = pi.commands.get("hindsight") as
      | {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        }
      | undefined;
    expect(commandHandler).toBeDefined();
    await commandHandler!.handler("toggle-display", createMockContext());

    // Same component instance should now render content (dynamic toggle)
    const collapsedLines = collapsed.render(80);
    expect(collapsedLines.length).toBeGreaterThan(0);
    expect(collapsedLines.join("\n")).toContain("Hindsight recalled");

    // Toggle display OFF — component should hide again
    await commandHandler!.handler("toggle-display", createMockContext());
    expect(collapsed.render(80)).toEqual([]);

    // Expanded component also respects the toggle
    const expanded = renderer(message, { expanded: true }, mockTheme)!;
    expect(expanded.render(80)).toEqual([]); // display is off

    await commandHandler!.handler("toggle-display", createMockContext()); // toggle on
    const expandedLines = expanded.render(80);
    expect(expandedLines.length).toBeGreaterThan(0);
    expect(expandedLines.join("\n")).toContain("Hindsight recalled");
  });

  it("session_start handler sets healthy status", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🧠");
  });

  it("session_start runs flush-pending on startup when autoFlushPendingOn includes startup (no-work stays silent)", async () => {
    // Regression: with "startup" in autoFlushPendingOn, the session_start
    // handler runs the flush-pending flow. With no pending work it stays silent
    // (notifyNoWork: false for lifecycle flushes) and does not throw.
    activeConfig = { ...testConfig, autoFlushPendingOn: ["startup"] };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🧠");
    // No notifications: no "No pending changes", no errors.
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    expect(notifyCalls.length).toBe(0);
  });

  it("session_start auto-creates metadata with retained=true when retainSessionsByDefault=true and no existing metadata", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // getEntries returns no hindsight-meta entries
    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0]).toEqual({
      customType: "hindsight-meta",
      data: { retained: true },
    });
  });

  it("session_start auto-creates metadata with retained=false when retainSessionsByDefault=false and no existing metadata", async () => {
    activeConfig = { ...testConfig, retainSessionsByDefault: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0]).toEqual({
      customType: "hindsight-meta",
      data: { retained: false },
    });
  });

  it("session_start does not auto-create metadata when it already exists", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // getEntries returns existing hindsight-meta
    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ]),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(pi.appendedEntries).toHaveLength(0);
  });

  it("session_start handler sets unhealthy status when server version is incompatible", async () => {
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.7.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🤯");
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
    expect(messages.some((m: string) => m.includes("0.7.0") && m.includes("too old"))).toBe(true);
  });

  it("session_start handler sets unhealthy status when server returns a malformed version", async () => {
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "dev" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🤯");
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
    expect(messages.some((m: string) => m.includes("invalid version") && m.includes("dev"))).toBe(
      true
    );
  });

  it("session_start handler sets unhealthy status when server version query fails", async () => {
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      getServerVersion: mock(() => Promise.resolve({ success: false, error: "HTTP 500" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🤯");
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
    expect(
      messages.some((m: string) => m.includes("Unable to query Hindsight server version"))
    ).toBe(true);
    expect(messages.some((m: string) => m.includes("HTTP 500"))).toBe(true);
  });

  it("session_start does not query version when health check fails", async () => {
    const getServerVersion = mock(() => Promise.resolve({ success: true, version: "0.9.0" }));
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "Connection refused" })),
      getServerVersion,
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🤯");
    expect(getServerVersion).not.toHaveBeenCalled();
  });

  it("session_start does not query health or version when config is invalid", async () => {
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "" };

    const healthCheck = mock(() => Promise.resolve({ success: true }));
    const getServerVersion = mock(() => Promise.resolve({ success: true, version: "0.9.0" }));
    activeClientFactory = () => ({
      healthCheck,
      getServerVersion,
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🤯");
    expect(healthCheck).not.toHaveBeenCalled();
    expect(getServerVersion).not.toHaveBeenCalled();
  });

  it("session_start warns only once for repeated incompatible version checks", async () => {
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.7.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;

    await handler({ type: "session_start" }, ctx);
    await handler({ type: "session_start" }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    const compatibilityWarnings = notifyCalls.filter((c: unknown[]) =>
      String(c[0]).includes("too old")
    );
    expect(compatibilityWarnings).toHaveLength(1);
  });

  it("tool queue flushes on shutdown when autoRetainEnabled=false and session retained=true", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { enqueueToolMessage, removePendingFlag, clearSessionQueueState } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    // Simulate a tool retain (hindsight_retain tool queues to tool queue)
    await enqueueToolMessage(sessionId, {
      content: "Important fact",
      tags: ["harness:pi", `session:${sessionId}`],
      timestamp: new Date().toISOString(),
      store_method: "tool",
      sessionId,
    });
    expect(readToolQueueFromDisk(sessionId)).toHaveLength(1);

    // Shutdown should flush the tool queue even though autoRetainEnabled=false
    const shutdownHandler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: sessionId });
    await shutdownHandler({ type: "session_shutdown", reason: "reload" }, ctx);

    expect(readToolQueueFromDisk(sessionId)).toHaveLength(0);
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("auto-queue stays empty on shutdown when autoRetainEnabled=false and session retained=true", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    // message_end handler should NOT queue because autoRetainEnabled=false
    const messageEndHandler = pi.handlers.get("message_end")!;
    const ctx = createMockContext({ _sessionId: sessionId });
    await messageEndHandler(
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      ctx
    );

    expect(hasPendingFlag(sessionId)).toBe(false);
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  // ============================================
  // autoRetainEnabled × retained state combinations
  //
  // These tests verify the interaction table from the README:
  // | autoRetainEnabled | retained | Auto-queue | Auto-queue flush | hindsight_retain | Parse & upsert |
  // |:---:|:---:|:---:|:---:|:---:|:---:|
  // | true  | true  | ✅ | ✅ | ✅ | ✅ |
  // | true  | false | ❌ | N/A | ❌ | ❌ |
  // | false | true  | ❌ | N/A | ✅ | ✅ |
  // | false | false | ❌ | N/A | ❌ | ❌ |

  it("autoRetainEnabled=true + retained=true: auto-queue works, tool works, parse-and-upsert works", async () => {
    // Default config: autoRetainEnabled=true, retainSessionsByDefault=true
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    // Auto-queue: message_end should queue
    const messageEndHandler = pi.handlers.get("message_end")!;
    const ctx = createMockContext({ _sessionId: sessionId });
    await messageEndHandler(
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      ctx
    );
    expect(hasPendingFlag(sessionId)).toBe(true);

    // Tool: hindsight_retain should succeed
    const retainTool = pi.tools.find((t) => t.name === "hindsight_retain")!;
    const toolResult = await retainTool.execute(
      "test-call-id",
      { content: "Important fact" },
      undefined,
      undefined,
      createMockContext({ _sessionId: sessionId })
    );
    const details = (toolResult as { details: { success: boolean } }).details;
    expect(details.success).toBe(true);

    // Parse-and-upsert: should succeed (retained=true)
    const { writeSessionFile, withTempDir } = await import("./fixtures");
    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId);
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);

      const parseCtx = createMockContext({
        _sessionId: sessionId,
        sessionManager: {
          ...createMockContext({ _sessionId: sessionId }).sessionManager,
          getSessionFile: mock(() => sessionPath),
        },
      });

      const commandHandler = (
        pi.commands.get("hindsight") as {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        }
      ).handler;
      await commandHandler("parse-and-upsert-session", parseCtx);

      const parseNotification = (parseCtx as unknown as { ui: { notify: ReturnType<typeof mock> } })
        .ui.notify.mock.calls;
      const lastCall = parseNotification[parseNotification.length - 1]!;
      expect(lastCall[0]).toContain("Parsed and upserted");
      expect(lastCall[0]).not.toContain("does not allow retention");
    });

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("autoRetainEnabled=true + retained=false: no auto-queue, tool blocked, parse-and-upsert-session blocked", async () => {
    // Default autoRetainEnabled=true, but retained=false
    activeConfig = { ...testConfig, retainSessionsByDefault: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    const ctx = createMockContext({
      _sessionId: sessionId,
      _retained: false,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ]),
      },
    });

    // Auto-queue: message_end should NOT queue (retained=false)
    const messageEndHandler = pi.handlers.get("message_end")!;
    await messageEndHandler(
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      ctx
    );
    expect(hasPendingFlag(sessionId)).toBe(false);

    // Tool: hindsight_retain should be blocked (retained=false)
    const retainTool = pi.tools.find((t) => t.name === "hindsight_retain")!;
    const toolResult = await retainTool.execute(
      "test-call-id",
      { content: "Important fact" },
      undefined,
      undefined,
      ctx
    );
    const toolDetails = (toolResult as { details: { success: boolean; error?: string } }).details;
    expect(toolDetails.success).toBe(false);
    expect(toolDetails.error).toContain("does not allow retention");

    // Parse-and-upsert: should be blocked (retained=false)
    // Need a session file so parseCurrentSession gets past the file check
    const { writeSessionFile, withTempDir } = await import("./fixtures");
    const { writeSessionState } = await import("../src/session-state");
    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId, { retained: false });
      // Write live state with retained=false (session_start may have created retained=true)
      writeSessionState(sessionId, {
        retained: false,
        extraContext: null,
        updatedAt: new Date().toISOString(),
      });
      const parseCtx = createMockContext({
        _sessionId: sessionId,
        _retained: false,
        sessionManager: {
          ...createMockContext({ _sessionId: sessionId }).sessionManager,
          getSessionFile: mock(() => sessionPath),
          getEntries: mock(() => [
            { type: "custom", customType: "hindsight-meta", data: { retained: false } },
          ]),
        },
      });

      const commandHandler = (
        pi.commands.get("hindsight") as {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        }
      ).handler;
      await commandHandler("parse-and-upsert-session", parseCtx);

      const parseNotification = (parseCtx as unknown as { ui: { notify: ReturnType<typeof mock> } })
        .ui.notify.mock.calls;
      const lastCall = parseNotification[parseNotification.length - 1]!;
      expect(lastCall[0]).toContain("does not allow retention");
      expect(lastCall[1]).toBe("warning");
    });

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("autoRetainEnabled=false + retained=true: no auto-queue, tool works, parse-and-upsert works", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    const ctx = createMockContext({ _sessionId: sessionId });

    // Auto-queue: message_end should NOT queue (autoRetainEnabled=false)
    const messageEndHandler = pi.handlers.get("message_end")!;
    await messageEndHandler(
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      ctx
    );
    expect(hasPendingFlag(sessionId)).toBe(false);

    // Tool: hindsight_retain should succeed (retained=true, autoRetainEnabled not checked)
    const retainTool = pi.tools.find((t) => t.name === "hindsight_retain")!;
    const toolResult = await retainTool.execute(
      "test-call-id",
      { content: "Important fact" },
      undefined,
      undefined,
      ctx
    );
    const toolDetails = (toolResult as { details: { success: boolean } }).details;
    expect(toolDetails.success).toBe(true);

    // Parse-and-upsert: should succeed (retained=true, autoRetainEnabled not checked)
    const { writeSessionFile, withTempDir } = await import("./fixtures");
    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId);
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);

      const parseCtx = createMockContext({
        _sessionId: sessionId,
        sessionManager: {
          ...createMockContext({ _sessionId: sessionId }).sessionManager,
          getSessionFile: mock(() => sessionPath),
        },
      });

      const commandHandler = (
        pi.commands.get("hindsight") as {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        }
      ).handler;
      await commandHandler("parse-and-upsert-session", parseCtx);

      const parseNotification = (parseCtx as unknown as { ui: { notify: ReturnType<typeof mock> } })
        .ui.notify.mock.calls;
      const lastCall = parseNotification[parseNotification.length - 1]!;
      expect(lastCall[0]).toContain("Parsed and upserted");
      expect(lastCall[0]).not.toContain("does not allow retention");
    });

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("autoRetainEnabled=false + retained=false: no auto-queue, tool blocked, parse-and-upsert-session blocked", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false, retainSessionsByDefault: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    const ctx = createMockContext({
      _sessionId: sessionId,
      _retained: false,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ]),
      },
    });

    // Auto-queue: message_end should NOT queue
    const messageEndHandler = pi.handlers.get("message_end")!;
    await messageEndHandler(
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      ctx
    );
    expect(hasPendingFlag(sessionId)).toBe(false);

    // Tool: hindsight_retain should be blocked (retained=false)
    const retainTool = pi.tools.find((t) => t.name === "hindsight_retain")!;
    const toolResult = await retainTool.execute(
      "test-call-id",
      { content: "Important fact" },
      undefined,
      undefined,
      ctx
    );
    const toolDetails = (toolResult as { details: { success: boolean; error?: string } }).details;
    expect(toolDetails.success).toBe(false);
    expect(toolDetails.error).toContain("does not allow retention");

    // Parse-and-upsert: should be blocked (retained=false)
    const { writeSessionFile, withTempDir } = await import("./fixtures");
    const { writeSessionState } = await import("../src/session-state");
    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId, { retained: false });
      // Write live state with retained=false (session_start may have created retained=true)
      writeSessionState(sessionId, {
        retained: false,
        extraContext: null,
        updatedAt: new Date().toISOString(),
      });
      const parseCtx = createMockContext({
        _sessionId: sessionId,
        _retained: false,
        sessionManager: {
          ...createMockContext({ _sessionId: sessionId }).sessionManager,
          getSessionFile: mock(() => sessionPath),
          getEntries: mock(() => [
            { type: "custom", customType: "hindsight-meta", data: { retained: false } },
          ]),
        },
      });

      const commandHandler = (
        pi.commands.get("hindsight") as {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        }
      ).handler;
      await commandHandler("parse-and-upsert-session", parseCtx);

      const parseNotification = (parseCtx as unknown as { ui: { notify: ReturnType<typeof mock> } })
        .ui.notify.mock.calls;
      const lastCall = parseNotification[parseNotification.length - 1]!;
      expect(lastCall[0]).toContain("does not allow retention");
      expect(lastCall[1]).toBe("warning");
    });

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("context handler filters out hindsight-recall messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("context")!;
    const messages = [
      { role: "user", content: "Hello" },
      { role: "custom", customType: "hindsight-recall", content: "Old recall" },
      { role: "assistant", content: "Hi" },
    ];

    const result = (await handler({ messages }, createMockContext())) as
      | Record<string, unknown>
      | undefined;

    expect(result).toBeDefined();
    const msgs = (result as Record<string, unknown>).messages as Array<{ customType?: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.customType !== "hindsight-recall")).toBe(true);
  });

  it("context handler returns undefined when no recall messages present", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("context")!;
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const result = (await handler({ messages }, createMockContext())) as
      | Record<string, unknown>
      | undefined;
    expect(result).toBeUndefined();
  });

  it("message_end handler queues user messages for retention", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("message_end")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);

    await handler(
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      ctx
    );

    const queued = hasPendingFlag(BOOTSTRAP_SESSION);
    expect(queued).toBe(true);

    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("message_end handler does not queue system messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("message_end")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);

    await handler(
      { type: "message_end", message: { role: "system", content: "system prompt" } },
      ctx
    );

    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("disabled extension registers context handler and message renderer", async () => {
    activeConfig = { ...testConfig, enabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    expect(pi.handlers.has("context")).toBe(true);
    expect(pi.renderers.has("hindsight-recall")).toBe(true);
    // Only context handler (renderer is tracked separately)
    expect(pi.handlers.size).toBe(1);
  });

  it("disabled extension renderer hides messages when autoRecallDisplay is false", async () => {
    activeConfig = { ...testConfig, enabled: false, autoRecallDisplay: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const renderer = pi.renderers.get("hindsight-recall") as (
      message: Record<string, unknown>,
      options: { expanded: boolean },
      theme: Record<string, unknown>
    ) => { render: (width: number) => string[] } | undefined;
    const details = { count: 1, snippet: "test", memories: "test memory" };
    const component = renderer({ details }, { expanded: false }, {});
    expect(component).toBeDefined();
    // When display is false, render returns empty lines
    const lines = component!.render(80);
    expect(lines).toHaveLength(0);
  });

  it("disabled extension renderer shows messages when autoRecallDisplay is true", async () => {
    activeConfig = { ...testConfig, enabled: false, autoRecallDisplay: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const renderer = pi.renderers.get("hindsight-recall") as (
      message: Record<string, unknown>,
      options: { expanded: boolean },
      theme: Record<string, unknown>
    ) => { render: (width: number) => string[] } | undefined;
    const details = { count: 1, snippet: "test", memories: "test memory" };
    const mockTheme = {
      fg: (_color: unknown, text: string) => text,
      bg: (_color: unknown, text: string) => text,
    };
    const component = renderer({ details }, { expanded: false }, mockTheme);
    expect(component).toBeDefined();
    // When display is true, render returns non-empty lines
    const lines = component!.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("disabled extension renderer ignores autoRecallDisplayOverride (toggle-display command not registered)", async () => {
    // In disabled mode, the toggle-display command is not registered, so the
    // override can never be set. The renderer should use config.autoRecallDisplay
    // directly, not autoRecallDisplayOverride ?? config.autoRecallDisplay.
    // We verify this by testing both display states — the renderer behavior
    // is determined solely by config, since there is no way to set an override.
    activeConfig = { ...testConfig, enabled: false, autoRecallDisplay: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const renderer = pi.renderers.get("hindsight-recall") as (
      message: Record<string, unknown>,
      options: { expanded: boolean },
      theme: Record<string, unknown>
    ) => { render: (width: number) => string[] } | undefined;
    const details = { count: 1, snippet: "test", memories: "test memory" };
    const component = renderer({ details }, { expanded: false }, {});
    expect(component).toBeDefined();
    // config.autoRecallDisplay: false → renderer hides messages
    expect(component!.render(80)).toHaveLength(0);

    // Verify no commands registered in disabled mode
    // (toggle-display cannot be invoked, so override can never be set)
    expect(pi.commands.size).toBe(0);
  });

  it("disabled extension context handler filters recall messages", async () => {
    activeConfig = { ...testConfig, enabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("context")!;
    const messages = [
      { role: "user", content: "Hello" },
      { role: "custom", customType: "hindsight-recall", content: "Old recall" },
    ];

    const result = (await handler({ messages }, createMockContext())) as
      | Record<string, unknown>
      | undefined;
    const msgs = (result as Record<string, unknown>).messages as Array<{ role: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
  });

  it("session_shutdown handler flushes queued messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    await handler({ type: "session_shutdown", reason: "reload" }, ctx);

    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("session_shutdown reload does not notify No pending changes when debug is false", async () => {
    activeConfig = { ...testConfig, debug: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);

    await handler({ type: "session_shutdown", reason: "reload" }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
    expect(messages).not.toContain("No pending changes");
  });

  it("session_shutdown reload notifies No pending changes when debug is true", async () => {
    activeConfig = { ...testConfig, debug: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);

    await handler({ type: "session_shutdown", reason: "reload" }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
    expect(messages).toContain("No pending changes");
  });

  it("session_shutdown quit echoes blocking warnings to console (extra-context guard)", async () => {
    // Regression: pi stops the TUI before emitting shutdown handlers, so on
    // `reason: "quit"` ctx.ui.notify warnings aren't visible. Warning/error
    // notifications must also be mirrored to console.warn/console.error so the
    // user sees why the quit flush was blocked.
    activeConfig = {
      ...testConfig,
      requireExtraContextBeforeFlush: true,
      debug: false,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "quit"],
      autoFlushPendingOn: [],
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_shutdown")!;
    // createMockContext writes a session file with hindsight-meta {retained:true}
    // and no extraContext — so the extra-context guard must block the flush.
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    // Capture console.warn/console.error output (TUI is shut down on quit)
    const originalWarn = console.warn;
    const originalError = console.error;
    const warnCalls: string[] = [];
    const errorCalls: string[] = [];
    console.warn = (msg: unknown) => {
      warnCalls.push(String(msg));
    };
    console.error = (msg: unknown) => {
      errorCalls.push(String(msg));
    };
    try {
      await handler({ type: "session_shutdown", reason: "quit" }, ctx);

      // The warning is still emitted through ctx.ui.notify ...
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m) => m.includes("extra context not set"))).toBe(true);
      // ... AND it is mirrored to console.warn (visible after TUI shutdown)
      expect(warnCalls.some((m) => m.includes("extra context not set"))).toBe(true);
      expect(warnCalls.some((m) => m.startsWith("pi-hindsight:"))).toBe(true);
      // Pending marker stays (guard blocks, setting context later allows flush)
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_shutdown quit echoes retention-disabled warning to console", async () => {
    // Regression: a non-retained session on quit must surface the retention
    // warning via console (not only ctx.ui.notify), since the TUI is gone.
    activeConfig = {
      ...testConfig,
      debug: false,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "quit"],
      autoFlushPendingOn: [],
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION, _retained: false });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    // Pretend-persist a non-retained live state so the fast pre-parse guard
    // blocks without re-parsing the (retained=false) session file.
    const { writeSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");
    writeSessionState(BOOTSTRAP_SESSION, {
      retained: false,
      extraContext: null,
      updatedAt: new Date().toISOString(),
    });

    const originalWarn = console.warn;
    const warnCalls: string[] = [];
    console.warn = (msg: unknown) => {
      warnCalls.push(String(msg));
    };
    try {
      await handler({ type: "session_shutdown", reason: "quit" }, ctx);

      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m) => m.includes("does not allow retention"))).toBe(true);
      expect(warnCalls.some((m) => m.includes("does not allow retention"))).toBe(true);
      // Pending marker cleared by the retention-disabled block path
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    } finally {
      console.warn = originalWarn;
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_shutdown quit stays quiet on console for info/no-work", async () => {
    // Regression: quit console-echo mirrors only warning/error notifications.
    // A retained session with no pending work ("No pending changes" info / no
    // success) must NOT be echoed to console, so quit stays non-noisy.
    activeConfig = {
      ...testConfig,
      debug: false,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "quit"],
      autoFlushPendingOn: [],
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);

    const originalWarn = console.warn;
    const originalError = console.error;
    const warnCalls: string[] = [];
    const errorCalls: string[] = [];
    console.warn = (msg: unknown) => {
      warnCalls.push(String(msg));
    };
    console.error = (msg: unknown) => {
      errorCalls.push(String(msg));
    };
    try {
      await handler({ type: "session_shutdown", reason: "quit" }, ctx);

      // No warning/error notifications should be mirrored to console for this
      // clean no-work quit.
      expect(warnCalls.length).toBe(0);
      expect(errorCalls.length).toBe(0);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_shutdown quit runs flush-pending and stays silent on no-work (default config)", async () => {
    // Regression: with the default autoFlushPendingOn: ["quit"], quit triggers
    // the flush-pending flow across all sessions. With no pending work anywhere,
    // it stays silent (notifyNoWork: false for lifecycle flushes) and does not
    // throw even though the mock session is not registered with SessionManager.
    activeConfig = { ...testConfig, debug: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);

    try {
      await handler({ type: "session_shutdown", reason: "quit" }, ctx);

      // No notifications at all: no "No pending changes", no errors.
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      expect(notifyCalls.length).toBe(0);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_before_switch handler flushes queued messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_before_switch")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);

    await handler({ type: "session_before_switch" }, ctx);

    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("invalid config: session_shutdown does not throw and skips flush without clearing queue", async () => {
    // Invalid config: apiUrl and apiKey empty → validation fails, client is null
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "" };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    // Should not throw
    await handler({ type: "session_shutdown", reason: "quit" }, ctx);

    // Queue should still be intact — flush was skipped due to invalid config
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
    // Auto-flushes suppress notifications for invalid config (transient, not useful)

    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("invalid config: session_before_switch does not throw and skips flush without clearing queue", async () => {
    // Invalid config: apiUrl and apiKey empty → validation fails, client is null
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "" };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_before_switch")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    // Should not throw
    await handler({ type: "session_before_switch" }, ctx);

    // Queue should still be intact — flush was skipped due to invalid config
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
    // Auto-flushes suppress notifications for invalid config (transient, not useful)

    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("session_start creates default metadata without rewriting the parsed .meta.json artifact", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    // Pre-create a parsed .meta.json artifact. Session-start metadata updates should
    // not patch parsed artifacts; they are refreshed by parse/flush paths.
    const { writeMetaFile, readMetaFile } = require("../src/meta") as typeof import("../src/meta");
    const { cleanupParsedArtifacts } = await import("./fixtures");
    cleanupParsedArtifacts(sessionId);

    // Write an initial parsed artifact with retained=false. It should remain unchanged
    // until the session is parsed/flushed again.
    writeMetaFile(sessionId, {
      sessionId: sessionId,
      sessionName: "test session",
      extraContext: null,
      sessionUserTags: [],
      sessionCwd: "/test",
      sessionTimestamp: "2026-01-01T00:00:00Z",
      messageCount: 0,
      retained: false,
    });

    const { readSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");

    // Verify initial .meta.json exists with retained=false (pre-condition)
    const beforeMeta = readMetaFile(sessionId);
    expect(beforeMeta).toBeDefined();
    expect(beforeMeta!.retained).toBe(false);

    // Call session_start with no existing hindsight-meta entries
    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    // Verify in-session metadata was appended
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0]).toEqual({
      customType: "hindsight-meta",
      data: { retained: true },
    });

    // Verify live session state was updated with retained=true
    const liveState = readSessionState(sessionId);
    expect(liveState).not.toBeNull();
    expect(liveState!.retained).toBe(true);

    // Re-read .meta.json artifact and verify session_start did not patch the parsed artifact.
    const afterMeta = readMetaFile(sessionId);
    expect(afterMeta).not.toBeNull();
    expect(afterMeta!.retained).toBe(false);

    cleanupParsedArtifacts(sessionId);
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("session_before_fork handler flushes queued messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_before_fork")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);

    await handler({ type: "session_before_fork" }, ctx);

    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("session_before_tree handler flushes when tree is in autoFlushSessionOn", async () => {
    // Regression: with "tree" enabled, the session_before_tree handler flushes
    // the current active session (auto-flush semantics), clearing the pending
    // marker. Exercise the real bootstrap handler; do not reimplement flush
    // logic.
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "tree"],
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_before_tree")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);

    await handler({ type: "session_before_tree", preparation: {}, signal: undefined }, ctx);

    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("session_before_tree handler skips flush when tree is not in autoFlushSessionOn", async () => {
    // Regression: "tree" is off by default, so the handler must not flush and
    // the pending marker stays intact.
    activeConfig = { ...testConfig };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_before_tree")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);

    await handler({ type: "session_before_tree", preparation: {}, signal: undefined }, ctx);

    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("session_compact handler skips flush when compact is not in autoFlushSessionOn", async () => {
    activeConfig = { ...testConfig };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);

    await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

    // Queue should still be intact — compact is not in autoFlushSessionOn
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("session_compact handler flushes when compact is in autoFlushSessionOn", async () => {
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);

    await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);
    // Drain the deferred notify replay (setTimeout(0)) scheduled by the handler
    await new Promise<void>((resolve) => setTimeout(resolve, 1));

    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("session_compact suppresses blocking warnings in non-debug mode (extra-context guard)", async () => {
    // Regression: compact uses auto-flush notification semantics, so routine
    // block/not-retained warnings are suppressed unless debug: true. In non-debug
    // mode the extra-context guard blocks the compact flush without surfacing a
    // warning. The deferred notify replay still applies (so any captured
    // notifications reach the TUI next tick), but no block warning is emitted.
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      requireExtraContextBeforeFlush: true,
      debug: false,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    // createMockContext writes a session file with hindsight-meta {retained:true}
    // and no extraContext — so the extra-context guard blocks the compact flush.
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

      // Synchronously (mid-compact) nothing is replayed yet
      let notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      let messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m) => m.includes("extra context not set"))).toBe(false);

      // After the next tick, the deferred replay reaches the real ctx.ui.notify —
      // but the block warning was suppressed (auto-flush, non-debug), so it is NOT
      // replayed.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m: string) => m.includes("extra context not set"))).toBe(false);
      // Pending marker stays (guard blocks, setting context later allows flush)
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_compact replays blocking warnings in debug mode (extra-context guard)", async () => {
    // In debug mode the compact flush surfaces the block warning via deferred
    // notify replay, consistent with other auto-flushes in debug.
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      requireExtraContextBeforeFlush: true,
      debug: true,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

      // Synchronously (mid-compact) the warning is captured, not yet replayed
      let notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      let messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m) => m.includes("extra context not set"))).toBe(false);

      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m: string) => m.includes("extra context not set"))).toBe(true);
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_compact suppresses retention-disabled warning in non-debug mode", async () => {
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      debug: false,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION, _retained: false });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    // Pretend-persist a non-retained live state so the fast pre-parse guard
    // blocks without re-parsing the (retained=false) session file.
    const { writeSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");
    writeSessionState(BOOTSTRAP_SESSION, {
      retained: false,
      extraContext: null,
      updatedAt: new Date().toISOString(),
    });

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

      // Synchronously the warning is captured, not yet replayed
      expect(
        (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.some((c: unknown[]) =>
          String(c[0]).includes("does not allow retention")
        )
      ).toBe(false);

      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      // Suppressed in non-debug: the retention-disabled warning is NOT replayed.
      expect(messages.some((m: string) => m.includes("does not allow retention"))).toBe(false);
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_compact replays retention-disabled warning in debug mode", async () => {
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      debug: true,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION, _retained: false });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    const { writeSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");
    writeSessionState(BOOTSTRAP_SESSION, {
      retained: false,
      extraContext: null,
      updatedAt: new Date().toISOString(),
    });

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

      expect(
        (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.some((c: unknown[]) =>
          String(c[0]).includes("does not allow retention")
        )
      ).toBe(false);

      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m: string) => m.includes("does not allow retention"))).toBe(true);
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_compact replays tool queue success after the handler", async () => {
    // Regression: the user's scenario may be tool-queue-only (no session
    // pending marker). In debug mode the tool queue success message "Flushed N
    // tool entries" is captured during the flush and replayed via ctx.ui.notify
    // next tick.
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      debug: true,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, enqueueToolMessage } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);

    await enqueueToolMessage(BOOTSTRAP_SESSION, {
      content: "Important fact",
      tags: ["harness:pi", `session:${BOOTSTRAP_SESSION}`],
      timestamp: new Date().toISOString(),
      store_method: "tool",
      sessionId: BOOTSTRAP_SESSION,
    });
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

      // Synchronously (mid-compact) the success info is captured, not replayed
      expect(
        (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.some((c: unknown[]) =>
          String(c[0]).includes("Flushed")
        )
      ).toBe(false);

      // After the next tick the deferred replay reaches the real ctx.ui.notify
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m: string) => m.includes("Flushed 1 tool entries"))).toBe(true);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_compact stays quiet for a successful flush (non-debug)", async () => {
    // Regression: compact uses auto-flush notification semantics, so a
    // successful flush ("Parsed and upserted …") is suppressed in non-debug
    // mode (compaction is not a final-chance event like /quit). Block warnings
    // are also absent. The flush still runs and clears the pending marker.
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      debug: false,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

      // Drain the deferred notify replay scheduled by the compact handler.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      // Success is suppressed in non-debug.
      expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(false);
      expect(messages.every((m: string) => !m.includes("does not allow retention"))).toBe(true);
      // The flush still ran and cleared the pending marker.
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_compact shows successful flush info in debug mode", async () => {
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      debug: true,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);
      // In debug mode the success info is emitted (captured) and replayed next tick
      await new Promise<void>((resolve) => setTimeout(resolve, 1));

      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(true);
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_compact stays quiet when there is no pending work", async () => {
    // Regression: compact should not emit a "No pending changes" info when
    // there is nothing to flush. The flush still runs so stale inflight claims
    // can be recovered, but with autoFlush no notifications are emitted/replayed.
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      debug: false,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));

      // No notifications should be captured/replayed (no work, and autoFlush
      // suppresses "No pending changes"), but the flush path still ran.
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      expect(notifyCalls.length).toBe(0);
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_compact shows No pending changes on no-work compaction when debug is true", async () => {
    // Regression: compact should follow the same auto-flush no-work semantics
    // as other auto-flush paths: "No pending changes" is suppressed unless
    // debug is enabled, in which case it is captured and replayed next tick.
    activeConfig = {
      ...testConfig,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
      debug: true,
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    clearSessionQueueState(BOOTSTRAP_SESSION);
    cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

      // Synchronously (mid-compact) the no-work info is captured, not replayed
      expect(
        (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.some((c: unknown[]) =>
          String(c[0]).includes("No pending changes")
        )
      ).toBe(false);

      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
      const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
      expect(messages.some((m: string) => m.includes("No pending changes"))).toBe(true);
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(false);
    } finally {
      removePendingFlag(BOOTSTRAP_SESSION);
      clearSessionQueueState(BOOTSTRAP_SESSION);
      cleanupParsedArtifacts(BOOTSTRAP_SESSION);
    }
  });

  it("session_start handler sets unhealthy status when server is unreachable", async () => {
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "Connection refused" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_start")!;
    const ctx = createMockContext();
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🤯");
  });

  it("session_start handler sets unhealthy status when config is invalid", async () => {
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "" };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_start")!;
    const ctx = createMockContext();
    await handler({ type: "session_start" }, ctx);

    // Should set unhealthy without calling healthCheck
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🤯");
  });

  it("session_start handler sets healthy status when config has load warnings but server is reachable", async () => {
    activeWarning = "Some load warning";

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_start")!;
    const ctx = createMockContext();
    await handler({ type: "session_start" }, ctx);

    // Load warnings are cosmetic; server is reachable → healthy
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🧠");
  });

  it("before_agent_start handler returns recall message when autoRecallPersist is true", async () => {
    activeConfig = { ...testConfig, autoRecallPersist: true };
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "User prefers dark mode" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("before_agent_start")!;
    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "What do I prefer?" }] },
          },
        ]),
      },
    });

    const result = (await handler(
      { type: "before_agent_start", prompt: "What do I prefer?" },
      ctx
    )) as Record<string, unknown> | undefined;

    expect(result).toBeDefined();
    expect(result?.message).toBeDefined();
    const msg = result?.message as Record<string, unknown>;
    expect(msg.customType).toBe("hindsight-recall");
    // When autoRecallPersist: true, display is always true so the message is added
    // to the TUI chat container (renderer dynamically controls visibility)
    expect(msg.display).toBe(true);
  });

  it("before_agent_start uses display: true even when autoRecallDisplay: false and autoRecallPersist: true", async () => {
    activeConfig = { ...testConfig, autoRecallPersist: true, autoRecallDisplay: false };
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("before_agent_start")!;
    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          },
        ]),
      },
    });

    const result = (await handler({ type: "before_agent_start", prompt: "Hello" }, ctx)) as
      | Record<string, unknown>
      | undefined;
    const msg = result?.message as Record<string, unknown>;
    expect(msg.display).toBe(true);
  });

  it("before_agent_start caches recall but does not persist when autoRecallPersist is false", async () => {
    // activeConfig already has autoRecallPersist: false from afterEach reset
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Cached memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          },
        ]),
      },
    });

    // before_agent_start should NOT return a message (not persisted)
    const result = await basHandler({ type: "before_agent_start", prompt: "Hello" }, ctxBas);
    expect(result).toBeUndefined();

    // But it should have cached the recall for the context handler to re-inject
    const contextHandler = pi.handlers.get("context")!;
    const ctxContext = createMockContext();
    const contextResult = (await contextHandler(
      {
        type: "context",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }], customType: undefined },
        ],
      },
      ctxContext
    )) as Record<string, unknown> | undefined;

    expect(contextResult).toBeDefined();
    const messages = contextResult?.messages as Array<{ role?: string; content?: unknown }>;
    // Recall is re-injected as the configured role (user by default)
    const recallMsg = messages.find(
      (m) =>
        m.role === "user" && typeof m.content === "string" && m.content.includes("Cached memory")
    );
    expect(recallMsg).toBeDefined();
    expect(recallMsg?.content).toContain("Cached memory");
  });

  it("before_agent_start performs recall on first message of session", async () => {
    // Verifies that auto-recall uses event.prompt instead of scanning entries.
    // getEntries() returns empty here (first message of session), confirming
    // the handler doesn't depend on entries being populated.
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "First message memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []), // First message — no entries yet
      },
    });

    // event.prompt is available even though entries are empty
    await basHandler({ type: "before_agent_start", prompt: "Hello from first message" }, ctxBas);

    // Recall was performed and cached — context handler re-injects it
    const contextHandler = pi.handlers.get("context")!;
    const ctxContext = createMockContext();
    const contextResult = (await contextHandler(
      {
        type: "context",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello from first message" }],
            customType: undefined,
          },
        ],
      },
      ctxContext
    )) as Record<string, unknown> | undefined;

    expect(contextResult).toBeDefined();
    const messages = contextResult?.messages as Array<{ role?: string; content?: unknown }>;
    // Recall is re-injected as the configured role (user by default)
    const recallMsg = messages.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("First message memory")
    );
    expect(recallMsg).toBeDefined();
    expect(recallMsg?.content).toContain("First message memory");
  });

  // ============================================
  // autoRecallPersist context filtering regression (integration)
  // ============================================
  //
  // Bug: When autoRecallPersist: true, before_agent_start injects a hindsight-recall
  // message into the session, but the context handler stripped ALL hindsight-recall
  // messages and never re-injected, so the LLM never saw recalled memories.
  //
  // Fix: before_agent_start always does recall and caches the message.
  // The context handler strips stale recalls and re-injects the cached recall.
  // These tests exercise the real handler flow (before_agent_start → context).

  it("autoRecallPersist: true - recall survives before_agent_start → context handler flow", async () => {
    activeConfig = { ...testConfig, autoRecallPersist: true };
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Important memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const contextHandler = pi.handlers.get("context")!;

    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "What do I prefer?" }] },
          },
        ]),
      },
    });

    // Step 1: before_agent_start should return message (persisted) and cache it
    const basResult = (await basHandler(
      { type: "before_agent_start", prompt: "What do I prefer?" },
      ctxBas
    )) as Record<string, unknown> | undefined;
    expect(basResult).toBeDefined();
    const basMsg = basResult?.message as Record<string, unknown>;
    expect(basMsg.customType).toBe("hindsight-recall");
    expect(basMsg.content).toContain("Important memory");

    // Step 2: context handler should filter the persisted recall and re-inject it
    const ctxContext = createMockContext();
    const contextResult = (await contextHandler(
      {
        type: "context",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What do I prefer?" }],
            customType: undefined,
          },
          // The persisted recall message is in the session, so it appears here
          { role: "custom", customType: "hindsight-recall", content: "Important memory" },
        ],
      },
      ctxContext
    )) as Record<string, unknown> | undefined;

    expect(contextResult).toBeDefined();
    const messages = contextResult?.messages as Array<{
      role?: string;
      customType?: string;
      content?: unknown;
    }>;
    // Exactly 2 messages: user + one re-injected recall (stale persisted recall was filtered)
    expect(messages).toHaveLength(2);
    // The re-injected recall is a proper role message (not a custom message)
    const recallMsg = messages.find(
      (m) =>
        m.role === "user" && typeof m.content === "string" && m.content.includes("Important memory")
    );
    expect(recallMsg).toBeDefined();
    // No customType recall messages remain (they were filtered)
    const customRecallMsgs = messages.filter((m) => m.customType === "hindsight-recall");
    expect(customRecallMsgs).toHaveLength(0); // no duplication from persisted custom messages
  });

  it("autoRecallPersist: true - stale recalls filtered when no recall this turn", async () => {
    activeConfig = { ...testConfig, autoRecallPersist: true };
    // recall returns no results this turn (simulating no new recall)
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const contextHandler = pi.handlers.get("context")!;

    // before_agent_start with no results → no cached recall
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          },
        ]),
      },
    });
    await basHandler({ type: "before_agent_start", prompt: "Hello" }, ctxBas);

    // Context handler receives stale recall from session
    const ctxContext = createMockContext();
    const contextResult = (await contextHandler(
      {
        type: "context",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }], customType: undefined },
          { role: "custom", customType: "hindsight-recall", content: "Old stale memory" },
        ],
      },
      ctxContext
    )) as Record<string, unknown> | undefined;

    // Stale recall should be filtered, no recall re-injected
    expect(contextResult).toBeDefined();
    const messages = contextResult?.messages as Array<{ customType?: string }>;
    const recallMsgs = messages.filter((m) => m.customType === "hindsight-recall");
    expect(recallMsgs).toHaveLength(0);
    expect(messages).toHaveLength(1); // just user message
  });

  it("autoRecallPersist: false - recall cached by before_agent_start is re-injected by context", async () => {
    // activeConfig already has autoRecallPersist: false
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Ephemeral memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const contextHandler = pi.handlers.get("context")!;

    // before_agent_start caches recall but does NOT return it (not persisted)
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          },
        ]),
      },
    });
    const basResult = await basHandler({ type: "before_agent_start", prompt: "Hello" }, ctxBas);
    expect(basResult).toBeUndefined(); // not persisted

    // Context handler re-injects the cached recall (ephemeral, for LLM this turn only)
    const ctxContext = createMockContext();
    const contextResult = (await contextHandler(
      {
        type: "context",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }], customType: undefined },
        ],
      },
      ctxContext
    )) as Record<string, unknown> | undefined;

    expect(contextResult).toBeDefined();
    const messages = contextResult?.messages as Array<{ role?: string; content?: unknown }>;
    // Recall is re-injected as the configured role (user by default)
    const recallMsg = messages.find(
      (m) =>
        m.role === "user" && typeof m.content === "string" && m.content.includes("Ephemeral memory")
    );
    expect(recallMsg).toBeDefined();
    expect(recallMsg?.content).toContain("Ephemeral memory");
  });

  // ============================================
  // lastRecallDetails regression (integration)
  //
  // Bug: /hindsight popup always showed "No recall this session" because
  // lastRecallMessage was consumed by the context handler (set to null)
  // before the user could ever invoke the popup command. The same variable
  // served two purposes: context re-injection (consumed once per turn) and
  // popup details (needs to persist across turns).
  //
  // Fix: Added a separate lastRecallDetails variable that persists across
  // the context handler's consumption of lastRecallMessage.
  // These tests exercise the real handler flow (before_agent_start → context → popup).

  it("popup command shows recall details after context handler consumes lastRecallMessage (autoRecallPersist: true)", async () => {
    activeConfig = { ...testConfig, autoRecallPersist: true };
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Popup regression memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const contextHandler = pi.handlers.get("context")!;
    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    // Step 1: before_agent_start performs recall and caches the message
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "What do I prefer?" }] },
          },
        ]),
      },
    });
    await basHandler({ type: "before_agent_start", prompt: "What do I prefer?" }, ctxBas);

    // Step 2: context handler consumes lastRecallMessage (sets it to null)
    const ctxContext = createMockContext();
    await contextHandler(
      {
        type: "context",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What do I prefer?" }],
            customType: undefined,
          },
        ],
      },
      ctxContext
    );

    // Step 3: popup command should still work (lastRecallDetails persists)
    let popupCalled = false;
    const ctxPopup = createMockContext({
      ui: {
        ...createMockContext().ui,
        custom: mock(async () => {
          popupCalled = true;
        }),
      },
    });
    await commandHandler("popup", ctxPopup);

    expect(popupCalled).toBe(true);
    // The notification for "No recall this session" should NOT have been called
    expect(ctxPopup.ui.notify).not.toHaveBeenCalled();
  });

  it("popup command shows recall details after context handler consumes lastRecallMessage (autoRecallPersist: false)", async () => {
    // autoRecallPersist: false is the default
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Ephemeral popup memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const contextHandler = pi.handlers.get("context")!;
    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    // Step 1: before_agent_start performs recall (not persisted, but cached)
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          },
        ]),
      },
    });
    await basHandler({ type: "before_agent_start", prompt: "Hello" }, ctxBas);

    // Step 2: context handler consumes lastRecallMessage (sets it to null) and re-injects
    const ctxContext = createMockContext();
    await contextHandler(
      {
        type: "context",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }], customType: undefined },
        ],
      },
      ctxContext
    );

    // Step 3: popup command should still work (lastRecallDetails persists)
    let popupCalled = false;
    const ctxPopup = createMockContext({
      ui: {
        ...createMockContext().ui,
        custom: mock(async () => {
          popupCalled = true;
        }),
      },
    });
    await commandHandler("popup", ctxPopup);

    expect(popupCalled).toBe(true);
    expect(ctxPopup.ui.notify).not.toHaveBeenCalled();
  });

  it("popup command shows 'No recall this session' when no recall has occurred this session", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const ctx = createMockContext();
    await commandHandler("popup", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No recall this session", "info");
  });

  it("lastRecallDetails is cleared on session switch", async () => {
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Session memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const switchHandler = pi.handlers.get("session_before_switch")!;
    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    // Step 1: Perform a recall
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          },
        ]),
      },
    });
    await basHandler({ type: "before_agent_start", prompt: "Hello" }, ctxBas);

    // Step 2: Session switch clears lastRecallDetails
    const ctxSwitch = createMockContext({ _sessionId: BOOTSTRAP_SESSION });
    await switchHandler({ type: "session_before_switch" }, ctxSwitch);

    // Step 3: popup should show "No recall this session"
    const ctxPopup = createMockContext();
    await commandHandler("popup", ctxPopup);
    expect(ctxPopup.ui.notify).toHaveBeenCalledWith("No recall this session", "info");
  });

  it("lastRecallDetails is cleared on session fork", async () => {
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Fork memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const forkHandler = pi.handlers.get("session_before_fork")!;
    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    // Step 1: Perform a recall
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          },
        ]),
      },
    });
    await basHandler({ type: "before_agent_start", prompt: "Hello" }, ctxBas);

    // Step 2: Session fork clears lastRecallDetails
    const ctxFork = createMockContext({ _sessionId: BOOTSTRAP_SESSION });
    await forkHandler({ type: "session_before_fork" }, ctxFork);

    // Step 3: popup should show "No recall this session"
    const ctxPopup = createMockContext();
    await commandHandler("popup", ctxPopup);
    expect(ctxPopup.ui.notify).toHaveBeenCalledWith("No recall this session", "info");
  });

  it("context handler filters stale recalls when no recall cached", async () => {
    activeConfig = { ...testConfig, autoRecallPersist: false };
    // No results → nothing cached by before_agent_start
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // Run before_agent_start (no results → no cache)
    const basHandler = pi.handlers.get("before_agent_start")!;
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          },
        ]),
      },
    });
    await basHandler({ type: "before_agent_start", prompt: "Hello" }, ctxBas);

    // Context handler should filter out stale recall with nothing to re-inject
    const contextHandler = pi.handlers.get("context")!;
    const ctxContext = createMockContext();
    const contextResult = (await contextHandler(
      {
        type: "context",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }], customType: undefined },
          { role: "custom", customType: "hindsight-recall", content: "Stale recall" },
        ],
      },
      ctxContext
    )) as Record<string, unknown> | undefined;

    expect(contextResult).toBeDefined();
    const messages = contextResult?.messages as Array<{ customType?: string }>;
    const recallMsgs = messages.filter((m) => m.customType === "hindsight-recall");
    expect(recallMsgs).toHaveLength(0);
  });

  // ============================================
  // autoRecallTags placeholder expansion integration tests
  // ============================================

  it("before_agent_start expands {project} in autoRecallTags and passes to client.recall", async () => {
    activeConfig = {
      ...testConfig,
      autoRecallPersist: false,
      autoRecallTags: ["{project}"],
      autoRecallTagsMatch: "any_strict",
    };

    let receivedTags: string[] | undefined;
    let receivedTagsMatch: string | undefined;
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock((opts: { tags?: string[]; tagsMatch?: string }) => {
        receivedTags = opts.tags;
        receivedTagsMatch = opts.tagsMatch;
        return Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Memory" }] },
        });
      }),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("before_agent_start")!;
    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getHeader: mock(() => ({
          id: "test-session-123",
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/home/user/myapp",
          parentSession: undefined,
        })),
      },
    });

    await handler({ type: "before_agent_start", prompt: "Hello" }, ctx);

    // {project} should expand to project:myapp (basename of /home/user/myapp)
    expect(receivedTags).toEqual(["project:myapp"]);
    expect(receivedTagsMatch).toBe("any_strict");
  });

  it("before_agent_start expands {cwd} in autoRecallTags with session header cwd", async () => {
    activeConfig = {
      ...testConfig,
      autoRecallPersist: false,
      autoRecallTags: ["{cwd}"],
      autoRecallTagsMatch: "any_strict",
    };

    let receivedTags: string[] | undefined;
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock((opts: { tags?: string[] }) => {
        receivedTags = opts.tags;
        return Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Memory" }] },
        });
      }),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("before_agent_start")!;
    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getHeader: mock(() => ({
          id: "test-session-123",
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/home/user/myapp",
          parentSession: undefined,
        })),
      },
    });

    await handler({ type: "before_agent_start", prompt: "Hello" }, ctx);

    expect(receivedTags).toEqual(["cwd:/home/user/myapp"]);
  });

  it("before_agent_start expands {parent} in autoRecallTags with parent session id", async () => {
    activeConfig = {
      ...testConfig,
      autoRecallPersist: false,
      autoRecallTags: ["{parent}"],
      autoRecallTagsMatch: "any",
    };

    // Create a temp parent session file that extractParentSessionId can read
    const parentDir = join(tmpdir(), "pi-hindsight-parent-test");
    mkdirSync(parentDir, { recursive: true });
    const parentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const parentPath = join(parentDir, `${parentId}.jsonl`);
    writeFileSync(parentPath, `${JSON.stringify({ type: "session", id: parentId })}\n`);

    try {
      let receivedTags: string[] | undefined;
      activeClientFactory = () => ({
        healthCheck: mock(() => Promise.resolve({ success: true })),
        retain: mock(() => Promise.resolve({ success: true })),
        retainBatch: mock(() => Promise.resolve({ success: true })),
        recall: mock((opts: { tags?: string[] }) => {
          receivedTags = opts.tags;
          return Promise.resolve({
            success: true,
            response: { results: [{ id: "1", text: "Memory" }] },
          });
        }),
        reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
      });

      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const handler = pi.handlers.get("before_agent_start")!;
      const ctx = createMockContext({
        sessionManager: {
          ...createMockContext().sessionManager,
          getHeader: mock(() => ({
            id: "test-session-123",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: "/home/user/myapp",
            parentSession: parentPath,
          })),
        },
      });

      await handler({ type: "before_agent_start", prompt: "Hello" }, ctx);

      expect(receivedTags).toEqual([`parent:${parentId}`]);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it("before_agent_start does not pass tags/tagsMatch when autoRecallTags is null", async () => {
    activeConfig = {
      ...testConfig,
      autoRecallPersist: false,
      autoRecallTags: null,
      autoRecallTagsMatch: "all_strict",
    };

    let receivedTags: string[] | undefined;
    let receivedTagsMatch: string | undefined;
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock((opts: { tags?: string[]; tagsMatch?: string }) => {
        receivedTags = opts.tags;
        receivedTagsMatch = opts.tagsMatch;
        return Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Memory" }] },
        });
      }),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("before_agent_start")!;
    const ctx = createMockContext();

    await handler({ type: "before_agent_start", prompt: "Hello" }, ctx);

    expect(receivedTags).toBeUndefined();
    expect(receivedTagsMatch).toBeUndefined();
  });

  it("before_agent_start expands {project} in autoRecallTagGroups and passes to client.recall", async () => {
    activeConfig = {
      ...testConfig,
      autoRecallPersist: false,
      autoRecallTagGroups: [
        { tags: ["{project}"], match: "any_strict" },
        { not: { tags: ["{session}"], match: "any_strict" } },
      ],
    };

    let receivedTagGroups: unknown;
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock((opts: { tagGroups?: unknown }) => {
        receivedTagGroups = opts.tagGroups;
        return Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "Memory" }] },
        });
      }),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("before_agent_start")!;
    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getHeader: mock(() => ({
          id: "test-session-123",
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/home/user/myapp",
          parentSession: undefined,
        })),
      },
    });

    await handler({ type: "before_agent_start", prompt: "Hello" }, ctx);

    // {project} should expand to project:myapp, {session} to session:test-session-123
    expect(receivedTagGroups).toEqual([
      { tags: ["project:myapp"], match: "any_strict" },
      { not: { tags: ["session:test-session-123"], match: "any_strict" } },
    ]);
  });

  // ============================================
  // updateRetainToolVisibility integration tests
  // ============================================

  it("session_start hides hindsight_retain when retainSessionsByDefault=false", async () => {
    activeConfig = { ...testConfig, retainSessionsByDefault: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // getEntries returns no hindsight-meta entries (auto-create will use retained=false)
    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    // setActiveTools should have been called to remove hindsight_retain
    expect(pi.setActiveToolsCalls.length).toBeGreaterThan(0);
    const lastCall = pi.setActiveToolsCalls[pi.setActiveToolsCalls.length - 1]!;
    expect(lastCall).not.toContain("hindsight_retain");
  });

  it("session_start keeps hindsight_retain visible when retainSessionsByDefault=true", async () => {
    // Default config has retainSessionsByDefault=true
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []), // no meta → auto-create with retained=true
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    // setActiveTools should NOT have been called (tool is already active by default)
    expect(pi.setActiveToolsCalls.length).toBe(0);
  });

  it("session_start respects existing retained=false metadata", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ]),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    // setActiveTools should have been called to remove hindsight_retain
    expect(pi.setActiveToolsCalls.length).toBeGreaterThan(0);
    const lastCall = pi.setActiveToolsCalls[pi.setActiveToolsCalls.length - 1]!;
    expect(lastCall).not.toContain("hindsight_retain");
  });

  it("session_start does not call updateRetainToolVisibility when retain tool is not in toolsEnabled array", async () => {
    activeConfig = { ...testConfig, toolsEnabled: ["recall" as const] };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    // setActiveTools should NOT have been called — retain tool isn't registered
    expect(pi.setActiveToolsCalls.length).toBe(0);
  });

  it("toggle-retain on restores hindsight_retain tool visibility after session_start hid it", async () => {
    activeConfig = { ...testConfig, retainSessionsByDefault: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // Fire session_start — tool should be hidden because retained=false
    const ctxStart = createMockContext({
      _retained: false,
      _sessionId: BOOTSTRAP_SESSION,
      sessionManager: {
        ...createMockContext({ _retained: false, _sessionId: BOOTSTRAP_SESSION }).sessionManager,
        getEntries: mock(() => []), // no meta → auto-create with retained=false
      },
      ui: {
        ...createMockContext().ui,
        confirm: mock(() => Promise.resolve(false)), // decline immediate upsert
      },
    });
    const sessionStartHandler = pi.handlers.get("session_start")!;
    await sessionStartHandler({ type: "session_start" }, ctxStart);

    // Verify tool was hidden
    expect(pi.getActiveTools()).not.toContain("hindsight_retain");

    // Now toggle-retain on
    const commandHandler = pi.commands.get("hindsight") as
      | { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
      | undefined;
    expect(commandHandler).toBeDefined();

    const ctxToggle = createMockContext({
      _retained: false,
      _sessionId: BOOTSTRAP_SESSION,
      sessionManager: {
        ...createMockContext({ _retained: false, _sessionId: BOOTSTRAP_SESSION }).sessionManager,
        getEntries: mock(() => [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ]),
      },
      ui: {
        ...createMockContext().ui,
        confirm: mock(() => Promise.resolve(false)), // decline immediate upsert
      },
    });
    await commandHandler!.handler("toggle-retain", ctxToggle);

    // Verify tool was restored
    expect(pi.getActiveTools()).toContain("hindsight_retain");
  });

  // ============================================
  // requireExtraContextBeforeFlush integration tests
  // ============================================

  it("requireExtraContextBeforeFlush: session_before_switch blocks flush when extra context is not set", async () => {
    activeConfig = { ...testConfig, requireExtraContextBeforeFlush: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);
    expect(hasPendingFlag(sessionId)).toBe(true);

    const handler = pi.handlers.get("session_before_switch")!;
    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []),
      },
    });

    await handler({ type: "session_before_switch" }, ctx);

    // Queue should still be intact — flush was blocked
    expect(hasPendingFlag(sessionId)).toBe(true);
    removePendingFlag(sessionId);
  });

  it("requireExtraContextBeforeFlush: session_shutdown blocks flush when extra context is not set", async () => {
    activeConfig = {
      ...testConfig,
      requireExtraContextBeforeFlush: true,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "quit"],
      autoFlushPendingOn: [],
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);

    const handler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []),
      },
    });

    await handler({ type: "session_shutdown", reason: "quit" }, ctx);

    // Queue should still be intact — flush was blocked
    expect(hasPendingFlag(sessionId)).toBe(true);
    removePendingFlag(sessionId);
  });

  it("requireExtraContextBeforeFlush: flush proceeds when extra context is set", async () => {
    activeConfig = { ...testConfig, requireExtraContextBeforeFlush: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);

    const { writeSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");

    const handler = pi.handlers.get("session_before_switch")!;
    // Entries include extra context in metadata
    const baseCtx = createMockContext({
      _sessionId: sessionId,
      _extraContext: "Fiction session",
    });
    const ctx = {
      ...baseCtx,
      sessionManager: {
        ...baseCtx.sessionManager,
        getEntries: mock(() => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, extraContext: "Fiction session" },
          },
        ]),
      },
    } as unknown as ExtensionContext;

    // Write live state with extraContext set (session_start may have created extraContext=null)
    writeSessionState(sessionId, {
      retained: true,
      extraContext: "Fiction session",
      updatedAt: new Date().toISOString(),
    });

    await handler({ type: "session_before_switch" }, ctx);

    // Queue should be flushed — extra context was set
    expect(hasPendingFlag(sessionId)).toBe(false);
    removePendingFlag(sessionId);
  });

  it("requireExtraContextBeforeFlush: parse-and-upsert-session subcommand blocks when extra context is not set", async () => {
    activeConfig = { ...testConfig, requireExtraContextBeforeFlush: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const { writeSessionFile, withTempDir } = await import("./fixtures");
    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId);
      const ctx = createMockContext({
        _sessionId: sessionId,
        sessionManager: {
          ...createMockContext({ _sessionId: sessionId }).sessionManager,
          getSessionFile: mock(() => sessionPath),
          getEntries: mock(() => []),
        },
      });

      await commandHandler("parse-and-upsert-session", ctx);

      const notification = (ctx as unknown as { ui: { notify: ReturnType<typeof mock> } }).ui.notify
        .mock.calls;
      const lastCall = notification[notification.length - 1]!;
      expect(lastCall[0]).toContain("extra context not set");
      expect(lastCall[1]).toBe("warning");
    });

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("requireExtraContextBeforeFlush: parse-and-upsert-session subcommand proceeds when extra context is set", async () => {
    activeConfig = { ...testConfig, requireExtraContextBeforeFlush: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const { writeSessionFile, withTempDir } = await import("./fixtures");
    const { writeSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");
    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId, { extraContext: "Fiction session" });
      // Write live state with extraContext set (session_start may have created extraContext=null)
      writeSessionState(sessionId, {
        retained: true,
        extraContext: "Fiction session",
        updatedAt: new Date().toISOString(),
      });
      const ctx = createMockContext({
        _sessionId: sessionId,
        _extraContext: "Fiction session",
        sessionManager: {
          ...createMockContext({ _sessionId: sessionId }).sessionManager,
          getSessionFile: mock(() => sessionPath),
          getEntries: mock(() => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, extraContext: "Fiction session" },
            },
          ]),
        },
      });

      await commandHandler("parse-and-upsert-session", ctx);

      const notification = (ctx as unknown as { ui: { notify: ReturnType<typeof mock> } }).ui.notify
        .mock.calls;
      const lastCall = notification[notification.length - 1]!;
      expect(lastCall[0]).toContain("Parsed and upserted");
    });

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("requireExtraContextBeforeFlush: flush subcommand blocks when extra context is not set", async () => {
    activeConfig = { ...testConfig, requireExtraContextBeforeFlush: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    await touchPendingFlag(sessionId);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []),
      },
    });

    await commandHandler("flush", ctx);

    const notification = (ctx as unknown as { ui: { notify: ReturnType<typeof mock> } }).ui.notify
      .mock.calls;
    const lastCall = notification[notification.length - 1]!;
    expect(lastCall[0]).toContain("extra context not set");
    expect(lastCall[1]).toBe("warning");
    // Queue should still be intact
    expect(hasPendingFlag(sessionId)).toBe(true);

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("requireExtraContextBeforeFlush: flush subcommand proceeds when extra context is set", async () => {
    activeConfig = { ...testConfig, requireExtraContextBeforeFlush: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    await touchPendingFlag(sessionId);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const { writeSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");

    // Write live state with extraContext set (session_start may have created extraContext=null)
    writeSessionState(sessionId, {
      retained: true,
      extraContext: "Fiction session",
      updatedAt: new Date().toISOString(),
    });

    const baseCtx = createMockContext({
      _sessionId: sessionId,
      _extraContext: "Fiction session",
    });
    const ctx = {
      ...baseCtx,
      sessionManager: {
        ...baseCtx.sessionManager,
        getEntries: mock(() => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, extraContext: "Fiction session" },
          },
        ]),
      },
    } as unknown as ExtensionContext;
    await commandHandler("flush", ctx);

    const notification = (ctx as unknown as { ui: { notify: ReturnType<typeof mock> } }).ui.notify
      .mock.calls;
    const lastCall = notification[notification.length - 1]!;
    expect(lastCall[0]).toContain("Parsed and upserted");
    // Queue should be flushed
    expect(hasPendingFlag(sessionId)).toBe(false);

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("requireExtraContextBeforeFlush: flush proceeds when extra context is explicitly set to empty string", async () => {
    activeConfig = { ...testConfig, requireExtraContextBeforeFlush: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);

    const { writeSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");

    // Write live state with extraContext="" (session_start may have created extraContext=null)
    writeSessionState(sessionId, {
      retained: true,
      extraContext: "",
      updatedAt: new Date().toISOString(),
    });

    const handler = pi.handlers.get("session_before_switch")!;
    // Entries include extraContext set to empty string ("I don't need extra context")
    const baseCtx = createMockContext({
      _sessionId: sessionId,
      _extraContext: "",
    });
    const ctx = {
      ...baseCtx,
      sessionManager: {
        ...baseCtx.sessionManager,
        getEntries: mock(() => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, extraContext: "" },
          },
        ]),
      },
    } as unknown as ExtensionContext;

    await handler({ type: "session_before_switch" }, ctx);

    // Queue should be flushed — explicit empty string satisfies the guard
    expect(hasPendingFlag(sessionId)).toBe(false);
    removePendingFlag(sessionId);
  });

  it("requireExtraContextBeforeFlush: session_before_fork blocks flush when extra context is not set", async () => {
    activeConfig = { ...testConfig, requireExtraContextBeforeFlush: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);

    const handler = pi.handlers.get("session_before_fork")!;
    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []),
      },
    });

    await handler({ type: "session_before_fork" }, ctx);

    // Queue should still be intact — flush was blocked
    expect(hasPendingFlag(sessionId)).toBe(true);
    removePendingFlag(sessionId);
  });

  it("requireExtraContextBeforeFlush: session_compact blocks flush when extra context is not set and compact is in autoFlushSessionOn", async () => {
    activeConfig = {
      ...testConfig,
      requireExtraContextBeforeFlush: true,
      autoFlushSessionOn: [...testConfig.autoFlushSessionOn, "compact"],
    };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []),
      },
    });

    try {
      await handler({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);
      // Drain the deferred notify replay scheduled by the compact handler
      await new Promise<void>((resolve) => setTimeout(resolve, 1));

      // Queue should still be intact — flush was blocked
      expect(hasPendingFlag(sessionId)).toBe(true);
    } finally {
      removePendingFlag(sessionId);
    }
  });
});
