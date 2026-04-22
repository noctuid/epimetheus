/**
 * Tests for the real entrypoint bootstrap.
 *
 * Uses a mutable state pattern for mock.module() to avoid re-mocking
 * between tests (which is fragile in Bun's module system). The mock
 * reads from `activeConfig`, `activeClientFactory`, etc., and each test
 * sets those variables before importing/exercising the extension.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

// Import the real config module BEFORE mocking to preserve exports
import * as realConfig from "../src/config";

import { createMockContext, createMockPi, testConfig } from "./fixtures";

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

afterEach(() => {
  const { deleteAutoQueue, deleteToolQueue } =
    require("../src/queue") as typeof import("../src/queue");
  deleteAutoQueue(BOOTSTRAP_SESSION);
  deleteToolQueue(BOOTSTRAP_SESSION);

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

  it("session_start handler sets healthy status", async () => {
    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const ctx = createMockContext();
    const handler = pi.handlers.get("session_start")!;
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🧠");
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

  it("disabled extension only registers context handler", async () => {
    activeConfig = { ...testConfig, enabled: false };

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    expect(pi.handlers.has("context")).toBe(true);
    expect(pi.handlers.size).toBe(1);
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

  it("session_start handler sets unhealthy status when config has warnings", async () => {
    activeWarning = "Some load warning";

    const pi = createMockPi();
    const extension = await import("../src/index");
    extension.default(pi);

    const handler = pi.handlers.get("session_start")!;
    const ctx = createMockContext();
    await handler({ type: "session_start" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hindsight", "🤯");
  });

  it("before_agent_start handler returns recall message when recallPersist is true", async () => {
    activeConfig = { ...testConfig, recallPersist: true };
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

    const result = (await handler({ type: "before_agent_start" }, ctx)) as
      | Record<string, unknown>
      | undefined;

    expect(result).toBeDefined();
    expect(result?.message).toBeDefined();
    const msg = result?.message as Record<string, unknown>;
    expect(msg.customType).toBe("hindsight-recall");
  });

  it("before_agent_start handler returns nothing when recallPersist is false", async () => {
    // activeConfig already has recallPersist: false from afterEach reset

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

    const result = await handler({ type: "before_agent_start" }, ctx);
    expect(result).toBeUndefined();
  });
});
