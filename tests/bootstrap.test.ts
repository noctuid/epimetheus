/**
 * Tests for the real entrypoint bootstrap.
 *
 * Uses a mutable state pattern for mock.module() to avoid re-mocking
 * between tests (which is fragile in Bun's module system). The mock
 * reads from `activeConfig`, `activeClientFactory`, etc., and each test
 * sets those variables before importing/exercising the extension.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    clientMocks = activeClientFactory();
    healthCheck = this.clientMocks.healthCheck;
    getServerVersion =
      this.clientMocks.getServerVersion ??
      mock(() => Promise.resolve({ success: true, version: "0.9.0" }));
    retain = this.clientMocks.retain;
    retainBatch = this.clientMocks.retainBatch;
    recall = this.clientMocks.recall;
    reflect = this.clientMocks.reflect;
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
  /**
   * Run a healthy `session_start` so the extension's `startupReady` flag becomes
   * true for subsequent operational handler/command invocations in a test. Uses
   * the default (healthy) client + a default ctx whose entries already contain
   * hindsight-meta (so session_start does not append a new meta entry here).
   *
   * `startupReady` defaults to false (health check not yet passed); tests that
   * exercise operational handlers/commands must establish readiness first.
   */
  async function runHealthySessionStart(pi: ReturnType<typeof createMockPi>): Promise<void> {
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, createMockContext());
  }

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

  it("defers hindsight tool registration to the first healthy session_start", async () => {
    // Tools are registered lazily in the session_start success path (after
    // health + version checks pass), not at extension init. Before any healthy
    // startup, no hindsight_* tool is registered.
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // No tools registered immediately after init.
    expect(pi.tools).toHaveLength(0);

    // After a healthy session_start, the configured hindsight tools are
    // registered (and auto-activate via refreshTools).
    const ctx = createMockContext();
    await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);

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

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🧠");
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

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🧠");
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

  it("session_start auto-marks usesProjectConfig:true when cwd has a valid project config (new session)", async () => {
    // New session, no existing metadata, but cwd has a valid cwd-local flush
    // config: session_start should mint both retained:true AND
    // usesProjectConfig:true in the new hindsight-meta entry.
    const { withTempDir } = await import("./fixtures");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await withTempDir(async (tmpCwd) => {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ projectName: "marked-project" }),
        "utf-8"
      );

      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const baseCtx = createMockContext();
      const ctx = {
        ...baseCtx,
        cwd: tmpCwd,
        sessionManager: {
          ...baseCtx.sessionManager,
          getHeader: mock(() => ({
            id: "auto-mark-sess",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => []),
        },
      } as unknown as ExtensionContext;
      const handler = pi.handlers.get("session_start")!;
      await handler({ type: "session_start" }, ctx);

      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries).toHaveLength(1);
      const data = metaEntries[0]?.data as {
        retained?: boolean;
        usesProjectConfig?: boolean;
      };
      expect(data.retained).toBe(true);
      expect(data.usesProjectConfig).toBe(true);
    });
  });

  it("session_start preserves an explicit usesProjectConfig:false detach on resume (latest-wins; no auto-remark)", async () => {
    // Resumed session with an explicit usesProjectConfig:false (after a
    // /hindsight detach-project-name). cwd still has a valid project config.
    // session_start must NOT append a new true entry that would override the
    // detach (latest-wins means we leave an explicit value alone).
    const { withTempDir } = await import("./fixtures");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await withTempDir(async (tmpCwd) => {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ projectName: "marked-project" }),
        "utf-8"
      );

      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const baseCtx = createMockContext();
      const ctx = {
        ...baseCtx,
        cwd: tmpCwd,
        sessionManager: {
          ...baseCtx.sessionManager,
          getHeader: mock(() => ({
            id: "detach-resume-sess",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectConfig: false },
            },
          ]),
        },
      } as unknown as ExtensionContext;
      const handler = pi.handlers.get("session_start")!;
      await handler({ type: "session_start" }, ctx);

      // Existing meta already has usesProjectConfig:false explicit. No new
      // hindsight-meta entry should be appended auto-marking true.
      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries).toHaveLength(0);
    });
  });

  it("session_start enters failed/unhealthy mode when the cwd-local project config is invalid (unmarked active session)", async () => {
    // Single degraded mode: an invalid cwd-local project config at the active
    // session's cwd hard-fails the active session: unhealthy status, ALL
    // Hindsight tools hidden (not just retain), no auto-retain, no metadata
    // auto-mark, no startup flush. Diagnostic commands + detach-project-name
    // remain available.
    const { withTempDir } = await import("./fixtures");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await withTempDir(async (tmpCwd) => {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      // Invalid: missing required projectName.
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ notProjectName: "x" }),
        "utf-8"
      );

      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const baseCtx = createMockContext();
      const ctx = {
        ...baseCtx,
        cwd: tmpCwd,
        sessionManager: {
          ...baseCtx.sessionManager,
          getHeader: mock(() => ({
            id: "invalid-flush-sess",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => []), // unmarked (no existing meta)
        },
      } as unknown as ExtensionContext;
      const handler = pi.handlers.get("session_start")!;
      await handler({ type: "session_start" }, ctx);

      // Failed mode: unhealthy status, no metadata appended.
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries).toHaveLength(0);
      // ALL Hindsight tools were hidden (degraded hides every hindsight_* tool):
      // the last setActiveTools call must contain no hindsight_* tool names.
      const lastSetActive = pi.setActiveToolsCalls[pi.setActiveToolsCalls.length - 1] ?? [];
      expect(lastSetActive.filter((n) => n.startsWith("hindsight_"))).toHaveLength(0);
      // The active-session flush latch is false → the extension is not operational.
      const { isActiveSessionProjectReady, isOperationalReady } =
        require("../src/runtime-state") as typeof import("../src/runtime-state");
      expect(isActiveSessionProjectReady()).toBe(false);
      expect(isOperationalReady()).toBe(false);
      // A clear warning was surfaced pointing at the invalid config, without
      // suggesting detach for an invalid config file.
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) =>
        String(c[0])
      );
      expect(
        notifyCalls.some((m) => m.includes("Project config unavailable") && m.includes("Fix "))
      ).toBe(true);
      expect(notifyCalls.some((m) => m.includes("detach-project-name"))).toBe(false);
    });
  });

  it("message_end auto-retain is blocked when the active session is in failed project-name mode", async () => {
    const { withTempDir } = await import("./fixtures");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await withTempDir(async (tmpCwd) => {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ notProjectName: "x" }),
        "utf-8"
      );

      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const sessionId = BOOTSTRAP_SESSION;
      const { removePendingFlag, hasPendingFlag } =
        require("../src/queue") as typeof import("../src/queue");
      removePendingFlag(sessionId);

      const baseCtx = createMockContext();
      const ctx = {
        ...baseCtx,
        cwd: tmpCwd,
        sessionManager: {
          ...baseCtx.sessionManager,
          getSessionId: mock(() => sessionId),
          getHeader: mock(() => ({
            id: sessionId,
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => []),
        },
      } as unknown as ExtensionContext;

      // session_start: failed mode (invalid project config).
      const startHandler = pi.handlers.get("session_start")!;
      await startHandler({ type: "session_start" }, ctx);
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");

      // message_end must NOT queue (active session failed project-name state).
      const messageEndHandler = pi.handlers.get("message_end")!;
      await messageEndHandler(
        { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
        ctx
      );
      expect(hasPendingFlag(sessionId)).toBe(false);

      removePendingFlag(sessionId);
    });
  });

  it("session_start preserves a valid active session (usesProjectConfig:false detached) even when cwd has an invalid project config", async () => {
    // Detached wins: when the session has an explicit usesProjectConfig:false,
    // an invalid cwd-local project config must NOT fail the active session.
    const { withTempDir } = await import("./fixtures");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await withTempDir(async (tmpCwd) => {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ notProjectName: "x" }),
        "utf-8"
      );

      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);
      await runHealthySessionStart(pi); // latch startupReady on a healthy (no-project-config) session first

      const baseCtx = createMockContext();
      const ctx = {
        ...baseCtx,
        cwd: tmpCwd,
        sessionManager: {
          ...baseCtx.sessionManager,
          getHeader: mock(() => ({
            id: "detached-despite-invalid",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectConfig: false },
            },
          ]),
        },
      } as unknown as ExtensionContext;
      const handler = pi.handlers.get("session_start")!;
      await handler({ type: "session_start" }, ctx);

      // Detached wins: NOT unhealthy (server probe succeeds → healthy; flush state ready).
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🧠");
      const { isActiveSessionProjectReady } =
        require("../src/runtime-state") as typeof import("../src/runtime-state");
      expect(isActiveSessionProjectReady()).toBe(true);
      // No new hindsight-meta appended (existing meta already present; detach preserved).
      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries).toHaveLength(0);
    });
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

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
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

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
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

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
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

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
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

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
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

  it("startup readiness: health check failure performs no operational side effects", async () => {
    // Regression: when the server is unreachable, session_start must NOT
    // auto-create hindsight-meta, write session-state, touch the pending queue,
    // update retain-tool visibility, or run flush-pending — only set unhealthy.
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "Connection refused" })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });
    activeConfig = { ...testConfig, autoFlushPendingOn: ["startup"] };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { readSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");
    const { removePendingFlag, clearSessionQueueState, touchPendingFlag, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    cleanupParsedArtifacts(sessionId);
    // Pre-existing pending marker: flush-pending (if it ran) would drain it.
    await touchPendingFlag(sessionId);
    expect(hasPendingFlag(sessionId)).toBe(true);

    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []), // no existing meta → old code would auto-create
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
    // No session metadata appended.
    expect(pi.appendedEntries).toHaveLength(0);
    // No live session-state file written.
    expect(readSessionState(sessionId)).toBeNull();
    // No tool registration (tools register lazily only on a healthy startup),
    // so no hindsight_* tool is registered/active and no setActiveTools call
    // was made.
    expect(pi.tools).toHaveLength(0);
    expect(pi.setActiveToolsCalls).toHaveLength(0);
    // flush-pending did not run: the pre-existing marker survives, and no
    // notifications were emitted.
    expect(hasPendingFlag(sessionId)).toBe(true);
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    expect(notifyCalls.length).toBe(0);

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    cleanupParsedArtifacts(sessionId);
  });

  it("startup readiness: version incompatibility performs no operational side effects", async () => {
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

    const sessionId = BOOTSTRAP_SESSION;
    const { readSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");
    const { removePendingFlag, clearSessionQueueState } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    cleanupParsedArtifacts(sessionId);

    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
    expect(pi.appendedEntries).toHaveLength(0);
    expect(readSessionState(sessionId)).toBeNull();
    // No tools registered/active and no setActiveTools call (lazy registration
    // only happens on a healthy startup).
    expect(pi.tools).toHaveLength(0);
    expect(pi.setActiveToolsCalls).toHaveLength(0);

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    cleanupParsedArtifacts(sessionId);
  });

  it("startup readiness gates auto-retain on unhealthy startup (health check fails)", async () => {
    // After a failed session_start (unreachable server), the message_end
    // auto-retain handler must skip — no pending marker is touched.
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "Connection refused" })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);

    const ctx = createMockContext({ _sessionId: sessionId });

    // Failed startup leaves startupReady=false.
    const startHandler = pi.handlers.get("session_start")!;
    await startHandler({ type: "session_start" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");

    // message_end should NOT touch the pending marker (gated by startupReady).
    const messageEndHandler = pi.handlers.get("message_end")!;
    await messageEndHandler(
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      ctx
    );
    expect(hasPendingFlag(sessionId)).toBe(false);

    removePendingFlag(sessionId);
  });

  it("startup readiness gates auto-recall and auto-flush on unhealthy startup", async () => {
    const recall = mock(() => Promise.resolve({ success: true, response: { results: [] } }));
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "Connection refused" })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall,
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);
    expect(hasPendingFlag(sessionId)).toBe(true);

    const ctx = createMockContext({ _sessionId: sessionId });

    // Failed startup leaves startupReady=false.
    const startHandler = pi.handlers.get("session_start")!;
    await startHandler({ type: "session_start" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");

    // Recall client should NOT be called (auto-recall gated by startupReady).
    const basHandler = pi.handlers.get("before_agent_start")!;
    await basHandler({ type: "before_agent_start", prompt: "What do I prefer?" }, ctx);
    expect(recall).not.toHaveBeenCalled();

    // Auto-flush on session_shutdown (reload) should skip — pending marker stays.
    const shutdownHandler = pi.handlers.get("session_shutdown")!;
    await shutdownHandler({ type: "session_shutdown", reason: "reload" }, ctx);
    expect(hasPendingFlag(sessionId)).toBe(true);

    removePendingFlag(sessionId);
  });

  it("startup readiness recovers after a healthy session_start re-enables operational handlers", async () => {
    // Before the first healthy startup, readiness is false (initial health check
    // failed), so auto-retain skips. A subsequent healthy session_start latches
    // readiness on (one-way), so auto-retain resumes.
    let healthSuccess = false;
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: healthSuccess })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);

    const ctx = createMockContext({ _sessionId: sessionId });
    const startHandler = pi.handlers.get("session_start")!;

    // First start: unhealthy → auto-retain skipped.
    await startHandler({ type: "session_start" }, ctx);
    const messageEndHandler = pi.handlers.get("message_end")!;
    await messageEndHandler(
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
      ctx
    );
    expect(hasPendingFlag(sessionId)).toBe(false);

    // Second start: healthy → auto-retain resumes.
    healthSuccess = true;
    await startHandler({ type: "session_start" }, ctx);
    await messageEndHandler(
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
      ctx
    );
    expect(hasPendingFlag(sessionId)).toBe(true);

    removePendingFlag(sessionId);
  });

  it("tool queue flushes on shutdown when autoRetainEnabled=false and session retained=true", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
      expect(warnCalls.some((m) => m.startsWith("epimetheus:"))).toBe(true);
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
    await runHealthySessionStart(pi);

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

  it("operational subcommands are blocked on the unified getter when the active session's project config is invalid", async () => {
    // Point 3: operational commands gate on the unified operational-ready getter
    // (startupReady && activeSessionProjectReady), not just startupReady. When the
    // active session fails the project-name check, operational commands are
    // blocked even though the server is healthy (startupReady latched).
    const { withTempDir } = await import("./fixtures");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await withTempDir(async (tmpCwd) => {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ notProjectName: "x" }),
        "utf-8"
      );

      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const sessionId = BOOTSTRAP_SESSION;
      const { removePendingFlag, hasPendingFlag, touchPendingFlag, clearSessionQueueState } =
        require("../src/queue") as typeof import("../src/queue");
      removePendingFlag(sessionId);

      const baseCtx = createMockContext({ _sessionId: sessionId });
      const ctx = {
        ...baseCtx,
        cwd: tmpCwd,
        sessionManager: {
          ...baseCtx.sessionManager,
          getSessionId: mock(() => sessionId),
          getHeader: mock(() => ({
            id: sessionId,
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => []), // unmarked + invalid config → failed
        },
      } as unknown as ExtensionContext;

      // session_start: server healthy (latches startupReady) but project config
      // invalid → activeSessionProjectReady=false → not operational.
      const startHandler = pi.handlers.get("session_start")!;
      await startHandler({ type: "session_start" }, ctx);
      const { isStartupReady, isOperationalReady } =
        require("../src/runtime-state") as typeof import("../src/runtime-state");
      expect(isStartupReady()).toBe(true);
      expect(isOperationalReady()).toBe(false);

      // An operational subcommand (/hindsight flush) must be blocked by the
      // unified getter → blocked message, no side effects.
      await touchPendingFlag(sessionId);
      const commandHandler = (
        pi.commands.get("hindsight") as {
          handler: (a: string, ctx: ExtensionContext) => Promise<void>;
        }
      ).handler;
      const ctxCmd = createMockContext({ _sessionId: sessionId });
      await commandHandler("flush", ctxCmd);
      const msgs = (ctxCmd.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) =>
        String(c[0])
      );
      expect(msgs.some((m) => m.includes("epimetheus: operational commands"))).toBe(true);
      // The SPECIFIC project-name cause is surfaced, not the generic
      // "not ready" catch-all.
      expect(msgs.some((m) => m.includes("project config") && m.includes("invalid"))).toBe(true);
      // No flush ran: the pending marker survives.
      expect(hasPendingFlag(sessionId)).toBe(true);

      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    });
  });

  it("session_before_switch handler flushes queued messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);
    await runHealthySessionStart(pi);

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

  it("invalid config fails fast while keeping diagnostic commands", async () => {
    // Invalid config (apiUrl and apiKey empty) → validation fails → fail-fast
    // mode. No tools, client, or flush/retain handlers are registered; only the
    // recall filter/renderer, unhealthy session_start indicator, and read-only
    // /hindsight diagnostics remain available.
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "" };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handlerNames = [...pi.handlers.keys()];
    expect(handlerNames).toContain("session_start");
    expect(handlerNames).toContain("context");
    // No flush/retain/switch/shutdown/compact handlers in fail-fast disabled mode.
    expect(pi.handlers.has("session_shutdown")).toBe(false);
    expect(pi.handlers.has("session_before_switch")).toBe(false);
    expect(pi.handlers.has("session_before_fork")).toBe(false);
    expect(pi.handlers.has("session_before_tree")).toBe(false);
    expect(pi.handlers.has("session_compact")).toBe(false);
    expect(pi.handlers.has("before_agent_start")).toBe(false);
    expect(pi.handlers.has("message_end")).toBe(false);

    // No tools are registered, but /hindsight remains available for status/config.
    expect(pi.tools).toHaveLength(0);
    expect(pi.commands.has("hindsight")).toBe(true);
    expect(pi.setActiveToolsCalls).toHaveLength(0);

    // Recall renderer still registered so persisted recall messages display/filter.
    expect(pi.renderers.has("hindsight-recall")).toBe(true);
  });

  it("invalid config: manual /hindsight flush surfaces the specific invalid-config reason and does NOT suggest detach", async () => {
    // Invalid global config → fail-fast path. Manual operational commands must
    // surface the SPECIFIC invalid-config reason (the validation errors) on
    // every attempt, must NOT mention detach-project-name, and must NOT emit
    // the old all-encompassing "not ready" catch-all.
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "" };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);

    const ctx = createMockContext({ _sessionId: sessionId });
    await commandHandler("flush", ctx);
    const msgs = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("blocked while in degraded mode"))).toBe(true);
    expect(msgs.some((m) => m.includes("global config is invalid"))).toBe(true);
    // Validation errors render as a bulleted list (one per error), with the
    // redundant `epimetheus: ` per-error log prefix stripped at render.
    expect(msgs.some((m) => m.includes("  - apiUrl is required"))).toBe(true);
    expect(msgs.some((m) => m.includes("  - apiKey is required"))).toBe(true);
    expect(msgs.some((m) => m.includes("epimetheus: apiUrl"))).toBe(false);
    // Points to /hindsight config (not detach/status).
    expect(msgs.some((m) => m.includes("/hindsight config"))).toBe(true);
    // NO detach-project-name advice for an invalid-config cause.
    expect(msgs.some((m) => m.includes("detach-project-name"))).toBe(false);
    // NO old generic catch-all.
    expect(msgs.some((m) => m.includes("not ready"))).toBe(false);
    // No flush ran: the pending marker survives.
    expect(hasPendingFlag(sessionId)).toBe(true);

    removePendingFlag(sessionId);
  });

  it("invalid config: session_start sets unhealthy status with no metadata/state/queue side effects", async () => {
    // Regression: previously session_start would auto-create hindsight-meta
    // (appending an entry + writing session-state) before the hasUsableConfig
    // check. In fail-fast mode it must only set the unhealthy status.
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "" };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { readSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    cleanupParsedArtifacts(sessionId);

    // No existing hindsight-meta entries: the old code would auto-create
    // {retained: ...} metadata here before bailing on invalid config.
    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext({ _sessionId: sessionId }).sessionManager,
        getEntries: mock(() => []),
      },
    });
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");

    // No session metadata appended.
    expect(pi.appendedEntries).toHaveLength(0);
    // No live session-state file written.
    expect(readSessionState(sessionId)).toBeNull();
    // No pending marker / queue writes, and no tool-visibility mutation.
    expect(hasPendingFlag(sessionId)).toBe(false);
    expect(pi.setActiveToolsCalls).toHaveLength(0);

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    cleanupParsedArtifacts(sessionId);
  });

  it("invalid config: diagnostic commands explain missing observationScopes", async () => {
    activeConfig = { ...testConfig, observationScopes: null };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const statusCtx = createMockContext();
    await commandHandler("status", statusCtx);
    const statusMessages = (statusCtx.ui.notify as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => String(c[0])
    );
    expect(statusMessages.some((m: string) => m.includes("== Connection =="))).toBe(true);
    expect(statusMessages.some((m: string) => m.includes("not checked: config invalid"))).toBe(
      true
    );

    const configCtx = createMockContext();
    await commandHandler("config", configCtx);
    const configMessages = (configCtx.ui.notify as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => String(c[0])
    );
    expect(configMessages.some((m: string) => m.includes("observationScopes is required"))).toBe(
      true
    );
  });

  it("invalid config: toggle-display updates persisted recall rendering", async () => {
    activeConfig = {
      ...testConfig,
      observationScopes: null,
      autoRecallPersist: true,
      autoRecallDisplay: false,
    };

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
    expect(component!.render(80)).toHaveLength(0);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;
    await commandHandler("toggle-display", createMockContext());

    const lines = component!.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("Hindsight recalled");
  });

  it("invalid config: pending markers survive lifecycle events (no flush handlers registered)", async () => {
    // Fail-fast disabled mode registers no flush handlers, so a pre-existing
    // pending marker is preserved across lifecycle events — data is not lost
    // and no flush is attempted with an invalid config.
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "" };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    // No session_shutdown / session_before_switch handlers exist to run.
    expect(pi.handlers.has("session_shutdown")).toBe(false);
    expect(pi.handlers.has("session_before_switch")).toBe(false);
    // Pending marker stays intact.
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);

    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("invalid config: logs validation errors to console", async () => {
    activeConfig = { ...testConfig, apiUrl: "", apiKey: "", bankId: "" };

    const pi = createMockPi();
    const extension = await import("../src/index");

    const errorCalls: string[] = [];
    const originalError = console.error;
    console.error = (msg: unknown) => {
      errorCalls.push(String(msg));
    };
    try {
      extension.default(pi);
    } finally {
      console.error = originalError;
    }

    // Validation errors for each missing required field are reported so the
    // user knows why the extension is disabled.
    expect(errorCalls.some((m) => m.includes("apiUrl is required"))).toBe(true);
    expect(errorCalls.some((m) => m.includes("apiKey is required"))).toBe(true);
    expect(errorCalls.some((m) => m.includes("bankId is required"))).toBe(true);
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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
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
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
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
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🧠");
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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    const recall = mock(() =>
      Promise.resolve({
        success: true,
        response: { results: [{ id: "1", text: "First message memory" }] },
      })
    );
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall,
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);
    await runHealthySessionStart(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []), // First message — no entries yet
      },
    });

    // event.prompt is available even though entries are empty
    await basHandler({ type: "before_agent_start", prompt: "Hello from first message" }, ctxBas);

    expect(recall).toHaveBeenCalledTimes(1);
    const recallCalls = recall.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(recallCalls[0]?.[0]).toMatchObject({ query: "Hello from first message" });

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
  // first-turn readiness ordering regression (integration)
  // ============================================
  //
  // The before_agent_start readiness gate used to hard-block on isStartupReady(),
  // which skipped auto-recall on the first message whenever the first healthy
  // session_start hadn't latched readiness yet at the time before_agent_start
  // fired (e.g. the startup probe was still pending, or it failed transiently
  // and the server has since recovered). The handler now verifies health on
  // demand when readiness isn't latched — latching + recalling on a healthy
  // server, skipping cleanly on a genuinely-down/incompatible one. These tests
  // deliberately do NOT call runHealthySessionStart() first, so they exercise
  // the real first-turn ordering rather than masking it with a pre-latched
  // readiness.

  it("before_agent_start skips recall and does NOT probe/mutate readiness when not operational", async () => {
    // New contract: session_start is awaited before the first prompt, so
    // before_agent_start only checks the unified operational state and returns
    // if degraded. It must NOT call ensureStartupReady() or mutate readiness
    // (no on-demand health/version probe, no status mutation). Here no healthy
    // session_start has latched readiness, so recall is skipped for this turn.
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "should not be used" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const { isStartupReady, isActiveSessionProjectReady } =
      require("../src/runtime-state") as typeof import("../src/runtime-state");
    expect(isStartupReady()).toBe(false);
    expect(isActiveSessionProjectReady()).toBe(true); // default, but startup not latched

    const basHandler = pi.handlers.get("before_agent_start")!;
    const ctx = createMockContext();
    await basHandler({ type: "before_agent_start", prompt: "Hello" }, ctx);

    // before_agent_start did NOT probe or mutate readiness: startup stays
    // unlatched, and NO status call was made (session_start owns status).
    expect(isStartupReady()).toBe(false);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    // No operational side effects: no metadata, no tools registered, no recall.
    expect(pi.appendedEntries.filter((e) => e.customType === "hindsight-meta")).toHaveLength(0);
    expect(pi.tools.filter((t) => t.name.startsWith("hindsight_"))).toHaveLength(0);

    // Recall was skipped: the context handler has no cached memory to inject.
    const contextHandler = pi.handlers.get("context")!;
    const contextResult = (await contextHandler(
      {
        type: "context",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }], customType: undefined },
        ],
      },
      createMockContext()
    )) as Record<string, unknown> | undefined;
    const messages = (contextResult?.messages ?? []) as Array<{ content?: unknown }>;
    const leaked = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("should not be used")
    );
    expect(leaked).toBeUndefined();
  });

  it("before_agent_start recalls when operational (after a healthy session_start)", async () => {
    // Once a healthy session_start has latched startup readiness and validated
    // the active session's project config, the extension is operational and
    // before_agent_start recalls from event.prompt.
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: true })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "First-turn memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // Latch readiness + validate the active session via a healthy session_start.
    await runHealthySessionStart(pi);

    const basHandler = pi.handlers.get("before_agent_start")!;
    const ctxBas = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []),
      },
    });
    await basHandler({ type: "before_agent_start", prompt: "Hello from first turn" }, ctxBas);

    // Recall ran (query from event.prompt): the context handler re-injects
    // the cached memory.
    const contextHandler = pi.handlers.get("context")!;
    const contextResult = (await contextHandler(
      {
        type: "context",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello from first turn" }],
            customType: undefined,
          },
        ],
      },
      createMockContext()
    )) as Record<string, unknown> | undefined;
    expect(contextResult).toBeDefined();
    const messages = contextResult?.messages as Array<{ role?: string; content?: unknown }>;
    const recallMsg = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("First-turn memory")
    );
    expect(recallMsg).toBeDefined();
    expect(recallMsg?.content).toContain("First-turn memory");
  });

  it("ensureStartupReady is single-flight across overlapping session_starts; before_agent_start does not probe at all", async () => {
    // New contract: before_agent_start no longer calls ensureStartupReady() — it
    // only reads isOperationalReady() and returns if degraded, so it must NOT
    // trigger or join any health/version probe. ensureStartupReady remains
    // single-flight for overlapping session_starts (they share one probe pass).
    let probeCount = 0;
    let resolveHealth: (v: { success: boolean }) => void = () => {};
    activeClientFactory = () => ({
      healthCheck: mock(() => {
        probeCount += 1;
        return new Promise<{ success: boolean }>((resolve) => {
          resolveHealth = resolve;
        });
      }),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "single-flight memory" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const startHandler = pi.handlers.get("session_start")!;
    const basHandler = pi.handlers.get("before_agent_start")!;

    const ctxNoMeta = () =>
      createMockContext({
        sessionManager: {
          ...createMockContext().sessionManager,
          getEntries: mock(() => []),
        },
      });

    // Fire a before_agent_start while no session_start has run (not ready).
    // It must NOT call ensureStartupReady: no probe is triggered, and recall is
    // skipped (degraded). So probeCount stays 0.
    await basHandler({ type: "before_agent_start", prompt: "overlap" }, ctxNoMeta());
    expect(probeCount).toBe(0);
    const { isStartupReady, isOperationalReady } =
      require("../src/runtime-state") as typeof import("../src/runtime-state");
    expect(isStartupReady()).toBe(false);
    expect(isOperationalReady()).toBe(false);

    // Now kick off two overlapping session_starts. They must share ONE probe.
    const startPromise1 = startHandler({ type: "session_start" }, ctxNoMeta());
    const startPromise2 = startHandler({ type: "session_start" }, ctxNoMeta());
    await Promise.resolve();
    await Promise.resolve();
    // A before_agent_start fired while the probe is in flight must also not
    // trigger a second probe (it only reads operational state, still false).
    const basInFlight = basHandler(
      { type: "before_agent_start", prompt: "in-flight" },
      ctxNoMeta()
    );
    expect(probeCount).toBe(1); // only the single shared session_start probe

    resolveHealth({ success: true });
    await Promise.all([startPromise1, startPromise2, basInFlight]);

    expect(isStartupReady()).toBe(true);
    expect(isOperationalReady()).toBe(true);
    // Both session_starts ran session init (tools registered once; one meta each).
    expect(pi.tools.filter((t) => t.name === "hindsight_retain").length).toBe(1);
    // No additional probes ran from before_agent_start.
    expect(probeCount).toBe(1);
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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    const parentDir = join(tmpdir(), "epimetheus-parent-test");
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
      await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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

  it("before_agent_start expands {project} from project-local config", async () => {
    activeConfig = {
      ...testConfig,
      autoRecallPersist: false,
      autoRecallTags: ["{project}"],
      autoRecallTagsMatch: "any_strict",
      autoRecallTagGroups: [{ tags: ["{project}"], match: "any_strict" }],
    };

    const tmpCwd = mkdtempSync(join(tmpdir(), "epimetheus-autorecall-project-"));
    try {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ projectName: "stable-project" }),
        "utf-8"
      );

      let receivedTags: string[] | undefined;
      let receivedTagGroups: unknown;
      activeClientFactory = () => ({
        healthCheck: mock(() => Promise.resolve({ success: true })),
        retain: mock(() => Promise.resolve({ success: true })),
        retainBatch: mock(() => Promise.resolve({ success: true })),
        recall: mock((opts: { tags?: string[]; tagGroups?: unknown }) => {
          receivedTags = opts.tags;
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

      const ctx = createMockContext({
        cwd: tmpCwd,
        sessionManager: {
          ...createMockContext().sessionManager,
          getEntries: mock(() => []),
          getHeader: mock(() => ({
            id: "test-session-123",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
        },
      });

      const startHandler = pi.handlers.get("session_start")!;
      await startHandler({ type: "session_start" }, ctx);

      const recallHandler = pi.handlers.get("before_agent_start")!;
      await recallHandler({ type: "before_agent_start", prompt: "Hello" }, ctx);

      expect(receivedTags).toEqual(["project:stable-project"]);
      expect(receivedTagGroups).toEqual([
        { tags: ["project:stable-project"], match: "any_strict" },
      ]);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
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

    // Tools are registered lazily on the healthy startup; hindsight_retain is
    // then removed from active tools because the session is not retained.
    expect(pi.getActiveTools()).not.toContain("hindsight_retain");
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

    // Lazy registration auto-activates the tool, and retention is true so it
    // is not removed. hindsight_retain is present in the active tools.
    expect(pi.getActiveTools()).toContain("hindsight_retain");
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

    // hindsight_retain is registered lazily then removed because retained=false.
    expect(pi.getActiveTools()).not.toContain("hindsight_retain");
    const lastCall = pi.setActiveToolsCalls[pi.setActiveToolsCalls.length - 1]!;
    expect(lastCall).not.toContain("hindsight_retain");
  });

  it("session_start does not touch hindsight_retain visibility when retain tool is not in toolsEnabled array", async () => {
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

    // The retain tool was never registered (toolsEnabled=["recall"]), so it
    // can never be active and updateRetainToolVisibility was never called for it.
    expect(pi.getActiveTools()).not.toContain("hindsight_retain");
    const allTouchedNames = pi.setActiveToolsCalls.flat();
    expect(allTouchedNames).not.toContain("hindsight_retain");
  });

  it("session_start still updates retain visibility for a later session after readiness is already latched", async () => {
    // readiness is a global latch, but session work (metadata creation + retain
    // visibility) is owned by session_start and must run on EVERY session_start,
    // not just the first. A second session_start (e.g. /new) after readiness is
    // already true must still auto-create hindsight-meta for that session if
    // absent and set hindsight_retain visibility per that session's retain state.
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const { isStartupReady } =
      require("../src/runtime-state") as typeof import("../src/runtime-state");
    const handler = pi.handlers.get("session_start")!;

    // First session_start, retained=true → readiness latches, meta created,
    // hindsight_retain active.
    const firstCtx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []),
      },
    });
    await handler({ type: "session_start" }, firstCtx);
    expect(isStartupReady()).toBe(true);
    const appendedAfterFirst = pi.appendedEntries.filter(
      (e) => e.customType === "hindsight-meta"
    ).length;
    expect(appendedAfterFirst).toBe(1);
    expect(pi.getActiveTools()).toContain("hindsight_retain");

    // Later session_start whose session already has retained=false metadata.
    // Readiness is already latched, but the per-session retain-visibility work
    // must still run: hindsight_retain is hidden for this (non-retained) session.
    // config.retainSessionsByDefault stays true (captured at default() time), so
    // we exercise visibility via EXISTING retained=false meta rather than a new
    // auto-created one — proving the visibility update is per-session.
    const laterCtx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ]),
      },
    });
    await handler({ type: "session_start" }, laterCtx);
    // Readiness unchanged (still latched).
    expect(isStartupReady()).toBe(true);
    // Existing retained=false meta was respected → no new meta appended.
    expect(pi.appendedEntries.filter((e) => e.customType === "hindsight-meta").length).toBe(
      appendedAfterFirst
    );
    // retain visibility updated for this session (hidden because retained=false).
    expect(pi.getActiveTools()).not.toContain("hindsight_retain");
  });

  it("session_start still auto-creates metadata for a later session after readiness is already latched", async () => {
    // Companion to the above: when a later session_start (readiness already
    // latched) has NO existing metadata, the per-session affordance still runs —
    // a new hindsight-meta is auto-created (using retainSessionsByDefault, here
    // true). This is the case readiness-as-latch risked skipping before the fix.
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const { isStartupReady } =
      require("../src/runtime-state") as typeof import("../src/runtime-state");
    const handler = pi.handlers.get("session_start")!;

    // First session_start → readiness latches, first meta created.
    const firstCtx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []),
      },
    });
    await handler({ type: "session_start" }, firstCtx);
    expect(isStartupReady()).toBe(true);
    const appendedAfterFirst = pi.appendedEntries.filter(
      (e) => e.customType === "hindsight-meta"
    ).length;
    expect(appendedAfterFirst).toBe(1);

    // Later session_start with no existing meta → still creates one for this session.
    const laterCtx = createMockContext({
      sessionManager: {
        ...createMockContext().sessionManager,
        getEntries: mock(() => []),
      },
    });
    await handler({ type: "session_start" }, laterCtx);
    expect(isStartupReady()).toBe(true);
    expect(pi.appendedEntries.filter((e) => e.customType === "hindsight-meta").length).toBe(
      appendedAfterFirst + 1
    );
    expect(pi.appendedEntries[pi.appendedEntries.length - 1]).toEqual({
      customType: "hindsight-meta",
      data: { retained: true },
    });
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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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
    await runHealthySessionStart(pi);

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

  // ============================================
  // Startup readiness: tools hidden until healthy startup, operational commands gated
  // ============================================

  it("startupReady is false before a healthy session_start (operational handlers skip)", async () => {
    // With a failing health check, session_start leaves startupReady=false.
    const { isStartupReady } =
      require("../src/runtime-state") as typeof import("../src/runtime-state");
    // _resetState (called in afterEach) sets startupReady=false; confirm the
    // default before any session_start.
    expect(isStartupReady()).toBe(false);

    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "down" })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // Before any session_start, readiness is false.
    expect(isStartupReady()).toBe(false);
    // A failed session_start keeps it false.
    const startHandler = pi.handlers.get("session_start")!;
    await startHandler({ type: "session_start" }, createMockContext());
    expect(isStartupReady()).toBe(false);
  });

  it("no hindsight tools are registered before the first healthy session_start; tools register and activate after healthy startup", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // Tools are not registered at extension init — none exist before a healthy
    // session_start, so none can be active.
    expect(pi.tools).toHaveLength(0);
    expect(pi.getActiveTools().filter((n) => n.startsWith("hindsight_"))).toEqual([]);

    // After a healthy session_start, the configured hindsight tools are
    // registered and auto-activate via refreshTools.
    await runHealthySessionStart(pi);
    const activeHindsight = pi.getActiveTools().filter((n) => n.startsWith("hindsight_"));
    // Default toolsEnabled=true → retain, recall, reflect (+ set/get_extra_context) registered.
    expect(activeHindsight).toContain("hindsight_retain");
    expect(activeHindsight).toContain("hindsight_recall");
  });

  it("a failed (unhealthy) session_start registers no hindsight tools and performs no side effects", async () => {
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "down" })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // Capture pre-handler state to prove the handler performs no writes.
    const sessionId = BOOTSTRAP_SESSION;
    const { readSessionState } =
      require("../src/session-state") as typeof import("../src/session-state");
    const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    cleanupParsedArtifacts(sessionId);
    await touchPendingFlag(sessionId);
    expect(hasPendingFlag(sessionId)).toBe(true);

    const ctx = createMockContext({ _sessionId: sessionId });
    const startHandler = pi.handlers.get("session_start")!;
    await startHandler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
    // No hindsight tools registered, none active.
    expect(pi.tools).toHaveLength(0);
    expect(pi.getActiveTools().filter((n) => n.startsWith("hindsight_"))).toEqual([]);
    // No operational side effects: no metadata appended, no session-state
    // written, no tool-visibility mutation, no flush-pending drain.
    expect(pi.appendedEntries).toHaveLength(0);
    expect(readSessionState(sessionId)).toBeNull();
    expect(pi.setActiveToolsCalls).toHaveLength(0);
    expect(hasPendingFlag(sessionId)).toBe(true);

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    cleanupParsedArtifacts(sessionId);
  });

  it("a later failed session_start after a healthy one re-enters degraded mode and re-hides all tools", async () => {
    // Re-enterable readiness: once the first healthy session_start completes,
    // a later session_start observing an unreachable/incompatible server must
    // flip startupReady back to false → unified degraded mode (isOperationalReady
    // false, ALL hindsight tools hidden, auto-retain skipped, operational
    // commands blocked). Status is unhealthy.
    const { isStartupReady, isOperationalReady } =
      require("../src/runtime-state") as typeof import("../src/runtime-state");
    let healthSuccess = true;
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: healthSuccess })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const startHandler = pi.handlers.get("session_start")!;
    const healthyCtx = createMockContext();
    await startHandler({ type: "session_start" }, healthyCtx);
    expect(isStartupReady()).toBe(true);
    expect(isOperationalReady()).toBe(true);
    const activeAfterHealthy = pi.getActiveTools().filter((n) => n.startsWith("hindsight_"));
    expect(activeAfterHealthy).toContain("hindsight_retain");
    expect(healthyCtx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🧠");

    // A later session_start fails (server became unreachable).
    healthSuccess = false;
    const failingCtx = createMockContext();
    await startHandler({ type: "session_start" }, failingCtx);

    // Re-entered degraded mode.
    expect(isStartupReady()).toBe(false);
    expect(isOperationalReady()).toBe(false);
    expect(failingCtx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
    // ALL hindsight tools are now hidden.
    const activeAfterFailure = pi.getActiveTools().filter((n) => n.startsWith("hindsight_"));
    expect(activeAfterFailure).toHaveLength(0);

    // Auto-retain is now skipped (degraded).
    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    const messageEndHandler = pi.handlers.get("message_end")!;
    const retainCtx = createMockContext({ _sessionId: sessionId });
    await messageEndHandler(
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
      retainCtx
    );
    expect(hasPendingFlag(sessionId)).toBe(false);

    removePendingFlag(sessionId);
  });

  it("a subsequent healthy session_start after a server failure restores operational readiness and re-shows tools", async () => {
    // Recovery: after re-entering degraded mode due to a server failure, a
    // subsequent healthy session_start (project name OK) must make the
    // extension operational again and re-show tools per retention.
    const { isStartupReady, isOperationalReady } =
      require("../src/runtime-state") as typeof import("../src/runtime-state");
    let healthSuccess = false;
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: healthSuccess })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const startHandler = pi.handlers.get("session_start")!;
    // First start: server unreachable → degraded.
    await startHandler({ type: "session_start" }, createMockContext());
    expect(isStartupReady()).toBe(false);
    expect(isOperationalReady()).toBe(false);
    expect(pi.getActiveTools().filter((n) => n.startsWith("hindsight_"))).toHaveLength(0);

    // Recovery: server is healthy again → operational, tools re-shown.
    healthSuccess = true;
    const recoveredCtx = createMockContext();
    await startHandler({ type: "session_start" }, recoveredCtx);
    expect(isStartupReady()).toBe(true);
    expect(isOperationalReady()).toBe(true);
    expect(recoveredCtx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🧠");
    const activeAfterRecovery = pi.getActiveTools().filter((n) => n.startsWith("hindsight_"));
    // Session is retained by default in createMockContext → retain visible too.
    expect(activeAfterRecovery).toContain("hindsight_retain");
    expect(activeAfterRecovery).toContain("hindsight_recall");
  });

  it("startup auto-flush skips when a latched session_start refresh probe fails", async () => {
    // Readiness is re-enterable, so a later failed probe re-enters degraded
    // mode (returning before any startup auto-flush). Startup auto-flush is
    // automatic network work, so skip it when this same session_start just
    // observed the server as unhealthy.
    activeConfig = { ...testConfig, autoFlushPendingOn: ["startup"] };
    let healthSuccess = true;
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: healthSuccess })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const startHandler = pi.handlers.get("session_start")!;
    await startHandler({ type: "session_start", reason: "startup" }, createMockContext());

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, clearSessionQueueState, touchPendingFlag, hasPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
    await touchPendingFlag(sessionId);
    expect(hasPendingFlag(sessionId)).toBe(true);

    healthSuccess = false;
    const failingCtx = createMockContext({ _sessionId: sessionId });
    await startHandler({ type: "session_start", reason: "startup" }, failingCtx);

    expect(failingCtx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
    const notifyMessages = (failingCtx.ui.notify as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => String(c[0])
    );
    expect(notifyMessages.some((m: string) => m.includes("session file not found"))).toBe(false);
    expect(hasPendingFlag(sessionId)).toBe(true);

    removePendingFlag(sessionId);
    clearSessionQueueState(sessionId);
  });

  it("manual operational command surfaces the specific server-degraded reason on every attempt", async () => {
    // When degraded because the startup probe failed (server unreachable), the
    // manual operational-command block message must surface the SPECIFIC reason
    // (not the generic catch-all) and REPEAT on every attempt (no dedup).
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "conn refused" })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // A failed session_start → degraded with the server-unreachable reason.
    await pi.handlers.get("session_start")!({ type: "session_start" }, createMockContext());

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    // First attempt: surfaces the SPECIFIC server reason.
    const ctx1 = createMockContext();
    await commandHandler("flush", ctx1);
    const msg1 = (ctx1.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
    expect(msg1.some((m) => m.includes("epimetheus: operational commands"))).toBe(true);
    expect(msg1.some((m) => m.includes("server is unreachable"))).toBe(true);
    // The generic catch-all phrase must NOT appear when a specific reason is set.
    expect(msg1.some((m) => m.includes("not ready"))).toBe(false);
    // Server cause → NO detach-project-name advice (recovery advice must match
    // the cause); instead it points to /hindsight status / server config.
    expect(msg1.some((m) => m.includes("detach-project-name"))).toBe(false);
    expect(msg1.some((m) => m.includes("server"))).toBe(true);

    // Repeated attempt: the message is NOT deduped (surfaces again).
    const ctx2 = createMockContext();
    await commandHandler("flush", ctx2);
    const msg2 = (ctx2.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
    expect(msg2.some((m) => m.includes("server is unreachable"))).toBe(true);
    expect(msg2.some((m) => m.includes("detach-project-name"))).toBe(false);
  });

  it("operational subcommand is blocked with a specific message and no side effects when not ready", async () => {
    // No healthy session_start → not ready → operational subcommands blocked.
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const sessionId = BOOTSTRAP_SESSION;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(sessionId);
    await touchPendingFlag(sessionId);
    expect(hasPendingFlag(sessionId)).toBe(true);

    const ctx = createMockContext({ _sessionId: sessionId });
    await commandHandler("flush", ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
    const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
    // No generic catch-all: this is a fresh extension with no session_start
    // yet AND no classified degraded reason, so the block surfaces the specific
    // internal "startup readiness has not completed yet" reason instead of the
    // old all-encompassing list.
    expect(messages.some((m: string) => m.includes("epimetheus: operational commands"))).toBe(true);
    expect(messages.some((m: string) => m.includes("\nReason: "))).toBe(true);
    expect(
      messages.some((m: string) => m.includes("startup readiness has not completed yet"))
    ).toBe(true);
    expect(messages.some((m: string) => m.includes("not ready"))).toBe(false);
    // No detach advice for a non-project-name cause.
    expect(messages.some((m: string) => m.includes("detach-project-name"))).toBe(false);
    // No flush ran — the pending marker survives.
    expect(hasPendingFlag(sessionId)).toBe(true);

    // Manual command blocking REPEATS on every attempt (no dedup) so the user
    // is reminded why the command is unavailable.
    const ctx2 = createMockContext({ _sessionId: sessionId });
    await commandHandler("flush", ctx2);
    const notifyCalls2 = (ctx2.ui.notify as ReturnType<typeof mock>).mock.calls;
    expect(notifyCalls2.length).toBe(1);
    expect(notifyCalls2[0]?.[1]).toBe("warning");
    expect(String(notifyCalls2[0]?.[0])).toContain("startup readiness has not completed yet");
    expect(hasPendingFlag(sessionId)).toBe(true);

    removePendingFlag(sessionId);
  });

  it("diagnostic subcommands (status, config) work even when not ready", async () => {
    // No healthy session_start → not ready, but status/config remain available.
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    const statusCtx = createMockContext();
    await commandHandler("status", statusCtx);
    const statusMessages = (statusCtx.ui.notify as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => String(c[0])
    );
    expect(statusMessages.some((m: string) => m.includes("== Connection =="))).toBe(true);
    expect(statusMessages.some((m: string) => m.includes("not ready"))).toBe(false);

    const configCtx = createMockContext();
    await commandHandler("config", configCtx);
    const configMessages = (configCtx.ui.notify as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => String(c[0])
    );
    expect(configMessages.some((m: string) => m.includes("== Config Source =="))).toBe(true);
    expect(configMessages.some((m: string) => m.includes("not ready"))).toBe(false);
  });

  it("degraded mode keeps diagnostic/display/recovery commands while blocking operational commands", async () => {
    activeConfig = { ...testConfig, autoRecallPersist: true, autoRecallDisplay: false };
    const { withTempDir } = await import("./fixtures");
    await withTempDir(async (tmpCwd) => {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ notProjectName: "x" }),
        "utf-8"
      );

      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const sessionId = BOOTSTRAP_SESSION;
      const baseCtx = createMockContext({ _sessionId: sessionId });
      const ctx = {
        ...baseCtx,
        cwd: tmpCwd,
        ui: {
          ...baseCtx.ui,
          confirm: mock(() => Promise.resolve(true)),
        },
        sessionManager: {
          ...baseCtx.sessionManager,
          getSessionId: mock(() => sessionId),
          getHeader: mock(() => ({
            id: sessionId,
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectConfig: true },
            },
          ]),
        },
      } as unknown as ExtensionContext;

      const startHandler = pi.handlers.get("session_start")!;
      await startHandler({ type: "session_start" }, ctx);

      const { isOperationalReady } =
        require("../src/runtime-state") as typeof import("../src/runtime-state");
      expect(isOperationalReady()).toBe(false);

      const commandHandler = (
        pi.commands.get("hindsight") as {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        }
      ).handler;

      // Diagnostic commands remain available.
      const statusCtx = createMockContext({ _sessionId: sessionId });
      await commandHandler("status", statusCtx);
      expect(
        (statusCtx.ui.notify as ReturnType<typeof mock>).mock.calls.some((c) =>
          String(c[0]).includes("== Connection ==")
        )
      ).toBe(true);

      const configCtx = createMockContext({ _sessionId: sessionId });
      await commandHandler("config", configCtx);
      expect(
        (configCtx.ui.notify as ReturnType<typeof mock>).mock.calls.some((c) =>
          String(c[0]).includes("== Config Source ==")
        )
      ).toBe(true);

      // Display command remains available and affects persisted recall rendering.
      const renderer = pi.renderers.get("hindsight-recall") as (
        message: Record<string, unknown>,
        options: { expanded: boolean },
        theme: Record<string, unknown>
      ) => { render: (width: number) => string[] } | undefined;
      const component = renderer(
        { details: { count: 1, snippet: "memory", memories: "memory" } },
        { expanded: false },
        { fg: (_color: unknown, text: string) => text, bg: (_color: unknown, text: string) => text }
      );
      expect(component?.render(80)).toHaveLength(0);
      await commandHandler("toggle-display", createMockContext({ _sessionId: sessionId }));
      expect(component?.render(80).join("\n")).toContain("Hindsight recalled");

      // Operational commands are blocked while degraded. The block message must
      // surface the SPECIFIC degraded cause (here: the active session's invalid
      // cwd-local project config), not the generic catch-all.
      const { hasPendingFlag, removePendingFlag, touchPendingFlag } =
        require("../src/queue") as typeof import("../src/queue");
      removePendingFlag(sessionId);
      await touchPendingFlag(sessionId);
      const flushCtx = createMockContext({ _sessionId: sessionId });
      await commandHandler("flush", flushCtx);
      expect(hasPendingFlag(sessionId)).toBe(true);
      const flushMsgs = (flushCtx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) =>
        String(c[0])
      );
      // Specific reason is surfaced (no generic "not ready" catch-all).
      expect(flushMsgs.some((m) => m.includes("epimetheus: operational commands"))).toBe(true);
      expect(flushMsgs.some((m) => m.includes("\nReason: "))).toBe(true);
      expect(flushMsgs.some((m) => m.includes("see `/hindsight config` for details"))).toBe(true);
      expect(flushMsgs.some((m) => m.includes("project config") && m.includes("invalid"))).toBe(
        true
      );
      // Invalid project config → fix-config advice only (concrete config path,
      // no detach suggestion).
      expect(flushMsgs.some((m) => m.includes(`Fix ${tmpCwd}/.pi/epimetheus/config.jsonc`))).toBe(
        true
      );
      expect(flushMsgs.some((m) => m.includes("detach-project-name"))).toBe(false);

      // Recovery command remains available and clears the active-session failure.
      await commandHandler("detach-project-name", ctx);
      expect(isOperationalReady()).toBe(true);
      expect(
        pi.appendedEntries.some(
          (e) =>
            e.customType === "hindsight-meta" &&
            (e.data as { usesProjectConfig?: boolean }).usesProjectConfig === false
        )
      ).toBe(true);
      removePendingFlag(sessionId);
    });
  });

  it("manual /hindsight flush surfaces the specific missing-config reason (detach-or-fix)", async () => {
    // Marked session whose cwd has no project config file: the block message
    // must surface the SPECIFIC "no project config file is present"
    // reason and suggest detach-project-name (detach-or-fix recovery advice).
    const { withTempDir } = await import("./fixtures");
    await withTempDir(async (tmpCwd) => {
      // No .pi/epimetheus/config.jsonc at tmpCwd.
      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const baseCtx = createMockContext();
      const startCtx = {
        ...baseCtx,
        cwd: tmpCwd,
        sessionManager: {
          ...baseCtx.sessionManager,
          getHeader: mock(() => ({
            id: BOOTSTRAP_SESSION,
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectConfig: true },
            },
          ]),
        },
      } as unknown as ExtensionContext;
      await pi.handlers.get("session_start")!({ type: "session_start" }, startCtx);

      const commandHandler = (
        pi.commands.get("hindsight") as {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        }
      ).handler;
      const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
        require("../src/queue") as typeof import("../src/queue");
      removePendingFlag(BOOTSTRAP_SESSION);
      await touchPendingFlag(BOOTSTRAP_SESSION);

      const flushCtx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });
      await commandHandler("flush", flushCtx);
      const flushMsgs = (flushCtx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) =>
        String(c[0])
      );
      expect(flushMsgs.some((m) => m.includes("epimetheus: operational commands"))).toBe(true);
      expect(flushMsgs.some((m) => m.includes("no project config file is present"))).toBe(true);
      // detach-or-fix advice suggests detach-project-name.
      expect(flushMsgs.some((m) => m.includes("detach-project-name"))).toBe(true);
      // No flush ran: the pending marker survives.
      expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
      removePendingFlag(BOOTSTRAP_SESSION);
    });
  });

  it("manual /hindsight flush surfaces the specific incompatible-version reason", async () => {
    // Server version incompatibility (distinct from unreachable) must surface
    // its own specific reason on the manual block message, with server recovery
    // advice (no detach-project-name).
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
    await pi.handlers.get("session_start")!({ type: "session_start" }, createMockContext());

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;
    const { removePendingFlag, hasPendingFlag, touchPendingFlag } =
      require("../src/queue") as typeof import("../src/queue");
    removePendingFlag(BOOTSTRAP_SESSION);
    await touchPendingFlag(BOOTSTRAP_SESSION);

    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });
    await commandHandler("flush", ctx);
    const msgs = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("server version is incompatible"))).toBe(true);
    expect(msgs.some((m) => m.includes("/hindsight status"))).toBe(true);
    expect(msgs.some((m) => m.includes("detach-project-name"))).toBe(false);
    expect(hasPendingFlag(BOOTSTRAP_SESSION)).toBe(true);
    removePendingFlag(BOOTSTRAP_SESSION);
  });

  it("session_start enters failed/unhealthy mode when a marked session's project config is missing", async () => {
    // Distinct from the invalid-config variant: a marked session whose cwd
    // has NO config file. The session_start warning must surface the specific
    // "no project config file is present" reason and suggest detach.
    const { withTempDir } = await import("./fixtures");
    await withTempDir(async (tmpCwd) => {
      // No .pi/epimetheus/config.jsonc at tmpCwd.
      const pi = createMockPi();
      const extension = await import("../src/index");
      extension.default(pi);

      const baseCtx = createMockContext();
      const ctx = {
        ...baseCtx,
        cwd: tmpCwd,
        sessionManager: {
          ...baseCtx.sessionManager,
          getHeader: mock(() => ({
            id: "missing-cfg-sess",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
          getEntries: mock(() => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectConfig: true },
            },
          ]),
        },
      } as unknown as ExtensionContext;
      const handler = pi.handlers.get("session_start")!;
      await handler({ type: "session_start" }, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
      const { isOperationalReady } =
        require("../src/runtime-state") as typeof import("../src/runtime-state");
      expect(isOperationalReady()).toBe(false);
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) =>
        String(c[0])
      );
      expect(notifyCalls.some((m) => m.includes("no project config file is present"))).toBe(true);
      // Missing config (detach-or-fix) suggests detach-project-name.
      expect(notifyCalls.some((m) => m.includes("detach-project-name"))).toBe(true);
    });
  });

  it("session_start enters failed/unhealthy mode when a marked session's cwd no longer exists", async () => {
    // Marked session whose recorded cwd is gone: fail closed with the
    // "cwd ... does not exist" reason and detach-or-fix recovery advice.
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const goneCwd = "/nonexistent/removed-project-xyz";
    const baseCtx = createMockContext();
    const ctx = {
      ...baseCtx,
      cwd: goneCwd,
      sessionManager: {
        ...baseCtx.sessionManager,
        getHeader: mock(() => ({
          id: "gone-cwd-sess",
          timestamp: "2026-01-01T00:00:00Z",
          cwd: goneCwd,
          parentSession: undefined,
        })),
        getEntries: mock(() => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, usesProjectConfig: true },
          },
        ]),
      },
    } as unknown as ExtensionContext;
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("epimetheus", "🤯");
    const { isOperationalReady } =
      require("../src/runtime-state") as typeof import("../src/runtime-state");
    expect(isOperationalReady()).toBe(false);
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) =>
      String(c[0])
    );
    expect(notifyCalls.some((m) => m.includes("does not exist"))).toBe(true);
    expect(notifyCalls.some((m) => m.includes(goneCwd))).toBe(true);
    expect(notifyCalls.some((m) => m.includes("detach-project-name"))).toBe(true);
  });

  it("before_agent_start skips recall with a project-name warning when the config breaks mid-session", async () => {
    // The before_agent_start handler re-resolves the project name fresh. If a
    // valid config was present at session_start (so the session is operational)
    // but becomes invalid before the next turn, recall is skipped with a
    // specific "auto-recall skipped: ..." warning and the recall client is
    // never called.
    const tmpCwd = mkdtempSync(join(tmpdir(), "epimetheus-autorecall-midsession-"));
    try {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ projectName: "stable-project" }),
        "utf-8"
      );

      let recallCalled = false;
      activeClientFactory = () => ({
        healthCheck: mock(() => Promise.resolve({ success: true })),
        getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
        retain: mock(() => Promise.resolve({ success: true })),
        retainBatch: mock(() => Promise.resolve({ success: true })),
        recall: mock(() => {
          recallCalled = true;
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

      const metaEntry = {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, usesProjectConfig: true },
      };
      const ctx = createMockContext({
        cwd: tmpCwd,
        sessionManager: {
          ...createMockContext().sessionManager,
          getEntries: mock(() => [metaEntry]),
          getHeader: mock(() => ({
            id: "midsession-sess",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: tmpCwd,
            parentSession: undefined,
          })),
        },
      });

      // Healthy session_start with a valid config -> operational (latch true).
      await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);

      // Config becomes invalid before the next turn.
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ notProjectName: "x" }),
        "utf-8"
      );

      await pi.handlers.get("before_agent_start")!(
        { type: "before_agent_start", prompt: "Hi" },
        ctx
      );

      expect(recallCalled).toBe(false);
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) =>
        String(c[0])
      );
      expect(notifyCalls.some((m) => m.includes("auto-recall skipped"))).toBe(true);
      expect(notifyCalls.some((m) => m.includes("project config"))).toBe(true);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it("/hindsight popup is unavailable in degraded mode (no recall to inspect) even if recall details are cached", async () => {
    // Degraded (server unreachable) → auto-recall is skipped, so there is no
    // current recall for the popup to inspect. It must surface the SPECIFIC
    // server-degraded reason (not the old generic "not ready" wording) with
    // cause-specific recovery advice (no detach-project-name for a server
    // cause), and NOT invoke the overlay, even when a cached recall from a
    // prior operational turn is present.
    activeClientFactory = () => ({
      healthCheck: mock(() => Promise.resolve({ success: false, error: "connection refused" })),
      getServerVersion: mock(() => Promise.resolve({ success: true, version: "0.9.0" })),
      retain: mock(() => Promise.resolve({ success: true })),
      retainBatch: mock(() => Promise.resolve({ success: true })),
      recall: mock(() =>
        Promise.resolve({
          success: true,
          response: { results: [{ id: "1", text: "cached recall" }] },
        })
      ),
      reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    });
    activeConfig = { ...testConfig, autoRecallPersist: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    // A failed (unhealthy) session_start → degraded (not operational) with the
    // server-unreachable reason classified.
    const startHandler = pi.handlers.get("session_start")!;
    await startHandler({ type: "session_start" }, createMockContext());

    const commandHandler = (
      pi.commands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    let overlayCalled = false;
    const ctx = {
      ...createMockContext(),
      ui: {
        ...createMockContext().ui,
        custom: mock(async () => {
          overlayCalled = true;
        }),
      },
    } as unknown as ExtensionContext;
    await commandHandler("popup", ctx);

    expect(overlayCalled).toBe(false);
    const msgs = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) =>
      String(c[0])
    );
    expect(msgs.some((m: string) => m.includes("auto-recall is skipped"))).toBe(true);
    // Specific server reason is surfaced.
    expect(msgs.some((m: string) => m.includes("server is unreachable"))).toBe(true);
    // NO old generic "not ready" wording.
    expect(msgs.some((m: string) => m.includes("not ready"))).toBe(false);
    // Server cause → NO detach-project-name advice.
    expect(msgs.some((m: string) => m.includes("detach-project-name"))).toBe(false);
  });
});
