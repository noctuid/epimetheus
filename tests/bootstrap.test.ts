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
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// Import the real config module BEFORE mocking to preserve exports
import * as realConfig from "../src/config";

import {
  createMockContext,
  createMockPi,
  HINDSIGHT_ENV_KEYS,
  saveEnvKeys,
  testConfig,
} from "./fixtures";

// ============================================
// Mutable state for mock.module() — tests set these before exercising handlers
// ============================================

/** Active config that the mocked loadConfig() returns. */
let activeConfig: realConfig.HindsightConfig = { ...testConfig };

/** Active loadConfig warning. */
let activeWarning: string | undefined;

/** Factory that creates the mock client class. Tests override to change healthCheck behavior. */
let activeClientFactory: () => {
  healthCheck: ReturnType<typeof mock>;
  retain: ReturnType<typeof mock>;
  retainBatch: ReturnType<typeof mock>;
  recall: ReturnType<typeof mock>;
  reflect: ReturnType<typeof mock>;
} = () => ({
  healthCheck: mock(() => Promise.resolve({ success: true })),
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

afterEach(() => {
  const { deleteAutoQueue, deleteToolQueue } =
    require("../src/queue") as typeof import("../src/queue");
  deleteAutoQueue(BOOTSTRAP_SESSION);
  deleteToolQueue(BOOTSTRAP_SESSION);

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

  it("tool queue flushes on shutdown when autoRetainEnabled=false and session retained=true", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { enqueueToolMessage, readToolQueue, deleteAutoQueue, deleteToolQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);

    // Simulate a tool retain (hindsight_retain tool queues to tool queue)
    enqueueToolMessage(sessionId, {
      content: "Important fact",
      tags: ["harness:pi", `session:${sessionId}`],
      timestamp: new Date().toISOString(),
      store_method: "tool",
    });
    expect(readToolQueue(sessionId)).toHaveLength(1);

    // Shutdown should flush the tool queue even though autoRetainEnabled=false
    const shutdownHandler = pi.handlers.get("session_shutdown")!;
    const ctx = createMockContext({ _sessionId: sessionId });
    await shutdownHandler({ type: "session_shutdown" }, ctx);

    expect(readToolQueue(sessionId)).toHaveLength(0);
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);
  });

  it("auto-queue stays empty on shutdown when autoRetainEnabled=false and session retained=true", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { readAutoQueue, deleteAutoQueue, deleteToolQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);

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

    expect(readAutoQueue(sessionId)).toHaveLength(0);
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);
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
    const { readAutoQueue, deleteAutoQueue, deleteToolQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);

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
    expect(readAutoQueue(sessionId)).toHaveLength(1);

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
      deleteAutoQueue(sessionId);
      deleteToolQueue(sessionId);

      const parseCtx = createMockContext({
        _sessionId: sessionId,
        sessionManager: {
          ...createMockContext().sessionManager,
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

    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);
  });

  it("autoRetainEnabled=true + retained=false: no auto-queue, tool blocked, parse-session blocked", async () => {
    // Default autoRetainEnabled=true, but retained=false
    activeConfig = { ...testConfig, retainSessionsByDefault: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { readAutoQueue, deleteAutoQueue, deleteToolQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);

    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext().sessionManager,
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
    expect(readAutoQueue(sessionId)).toHaveLength(0);

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
    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId);
      const parseCtx = createMockContext({
        _sessionId: sessionId,
        sessionManager: {
          ...createMockContext().sessionManager,
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

    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);
  });

  it("autoRetainEnabled=false + retained=true: no auto-queue, tool works, parse-and-upsert works", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { readAutoQueue, deleteAutoQueue, deleteToolQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);

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
    expect(readAutoQueue(sessionId)).toHaveLength(0);

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
      deleteAutoQueue(sessionId);
      deleteToolQueue(sessionId);

      const parseCtx = createMockContext({
        _sessionId: sessionId,
        sessionManager: {
          ...createMockContext().sessionManager,
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

    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);
  });

  it("autoRetainEnabled=false + retained=false: no auto-queue, tool blocked, parse-session blocked", async () => {
    activeConfig = { ...testConfig, autoRetainEnabled: false, retainSessionsByDefault: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const sessionId = BOOTSTRAP_SESSION;
    const { readAutoQueue, deleteAutoQueue, deleteToolQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);

    const ctx = createMockContext({
      _sessionId: sessionId,
      sessionManager: {
        ...createMockContext().sessionManager,
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
    expect(readAutoQueue(sessionId)).toHaveLength(0);

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
    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId);
      const parseCtx = createMockContext({
        _sessionId: sessionId,
        sessionManager: {
          ...createMockContext().sessionManager,
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

    deleteAutoQueue(sessionId);
    deleteToolQueue(sessionId);
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

    const { deleteAutoQueue, readAutoQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(BOOTSTRAP_SESSION);

    await handler(
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      ctx
    );

    const queued = readAutoQueue(BOOTSTRAP_SESSION);
    expect(queued.length).toBeGreaterThan(0);

    deleteAutoQueue(BOOTSTRAP_SESSION);
  });

  it("message_end handler does not queue system messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("message_end")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { deleteAutoQueue, readAutoQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(BOOTSTRAP_SESSION);

    await handler(
      { type: "message_end", message: { role: "system", content: "system prompt" } },
      ctx
    );

    expect(readAutoQueue(BOOTSTRAP_SESSION)).toHaveLength(0);
    deleteAutoQueue(BOOTSTRAP_SESSION);
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

    const { enqueueAutoMessage, deleteAutoQueue, readAutoQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(BOOTSTRAP_SESSION);
    enqueueAutoMessage(BOOTSTRAP_SESSION, {
      entry: { message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
      store_method: "auto",
    });
    expect(readAutoQueue(BOOTSTRAP_SESSION)).toHaveLength(1);

    await handler({ type: "session_shutdown" }, ctx);

    expect(readAutoQueue(BOOTSTRAP_SESSION)).toHaveLength(0);
    deleteAutoQueue(BOOTSTRAP_SESSION);
  });

  it("session_before_switch handler flushes queued messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_before_switch")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { enqueueAutoMessage, deleteAutoQueue, readAutoQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(BOOTSTRAP_SESSION);
    enqueueAutoMessage(BOOTSTRAP_SESSION, {
      entry: { message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
      store_method: "auto",
    });

    await handler({ type: "session_before_switch" }, ctx);

    expect(readAutoQueue(BOOTSTRAP_SESSION)).toHaveLength(0);
    deleteAutoQueue(BOOTSTRAP_SESSION);
  });

  it("session_before_fork handler flushes queued messages", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_before_fork")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { enqueueAutoMessage, deleteAutoQueue, readAutoQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(BOOTSTRAP_SESSION);
    enqueueAutoMessage(BOOTSTRAP_SESSION, {
      entry: { message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
      store_method: "auto",
    });

    await handler({ type: "session_before_fork" }, ctx);

    expect(readAutoQueue(BOOTSTRAP_SESSION)).toHaveLength(0);
    deleteAutoQueue(BOOTSTRAP_SESSION);
  });

  it("session_compact handler skips flush when flushOnCompact is false", async () => {
    activeConfig = { ...testConfig, flushOnCompact: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { enqueueAutoMessage, deleteAutoQueue, readAutoQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(BOOTSTRAP_SESSION);
    enqueueAutoMessage(BOOTSTRAP_SESSION, {
      entry: { message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
      store_method: "auto",
    });

    await handler({ type: "session_compact" }, ctx);

    // Queue should still be intact — flushOnCompact is false
    expect(readAutoQueue(BOOTSTRAP_SESSION)).toHaveLength(1);
    deleteAutoQueue(BOOTSTRAP_SESSION);
  });

  it("session_compact handler flushes when flushOnCompact is true", async () => {
    activeConfig = { ...testConfig, flushOnCompact: true };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_compact")!;
    const ctx = createMockContext({ _sessionId: BOOTSTRAP_SESSION });

    const { enqueueAutoMessage, deleteAutoQueue, readAutoQueue } =
      require("../src/queue") as typeof import("../src/queue");
    deleteAutoQueue(BOOTSTRAP_SESSION);
    enqueueAutoMessage(BOOTSTRAP_SESSION, {
      entry: { message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
      store_method: "auto",
    });

    await handler({ type: "session_compact" }, ctx);

    expect(readAutoQueue(BOOTSTRAP_SESSION)).toHaveLength(0);
    deleteAutoQueue(BOOTSTRAP_SESSION);
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
    const messages = contextResult?.messages as Array<{ customType?: string; content?: string }>;
    const recallMsg = messages.find((m) => m.customType === "hindsight-recall");
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
    const messages = contextResult?.messages as Array<{ customType?: string; content?: string }>;
    const recallMsg = messages.find((m) => m.customType === "hindsight-recall");
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
    const messages = contextResult?.messages as Array<{ customType?: string; content?: string }>;
    // Exactly 2 messages: user + one re-injected recall (stale persisted recall was filtered)
    expect(messages).toHaveLength(2);
    const recallMsgs = messages.filter((m) => m.customType === "hindsight-recall");
    expect(recallMsgs).toHaveLength(1); // no duplication
    expect(recallMsgs[0]?.content).toContain("Important memory");
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
    const messages = contextResult?.messages as Array<{ customType?: string; content?: string }>;
    const recallMsg = messages.find((m) => m.customType === "hindsight-recall");
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
});
