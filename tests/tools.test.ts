/**
 * Unit tests for hindsight_retain, hindsight_recall, and hindsight_reflect tools.
 * Tests the execute paths using mocked pi API, client, and context.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RecallResponse, ReflectResponse } from "@vectorize-io/hindsight-client";
import type { HindsightClientWrapper } from "../src/client";
import type { HindsightConfig } from "../src/config";
import { deleteAutoQueue, deleteToolQueue, readToolQueue } from "../src/queue";
import { isToolEnabled, registerTools, updateRetainToolVisibility } from "../src/tools";
import { testConfig as sharedTestConfig } from "./fixtures";

const TEST_SESSION_ID = "test-tools-session";

// Extend shared config with tool-test-specific overrides
const testConfig: HindsightConfig = {
  ...sharedTestConfig,
  apiUrl: "https://test.test",
  constantTags: ["harness:pi"],
  recallPromptPreamble: "Test preamble",
};

interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: Record<string, unknown>
  ) => Promise<unknown>;
}

// Track registered tools
function createMockPi(): ExtensionAPI & {
  tools: ToolDef[];
  activeToolNames: string[] | null;
  setActiveToolsCalls: string[][];
} {
  const tools: ToolDef[] = [];
  // Use a mutable object so the closure-based getActiveTools/setActiveTools share state
  const state = { activeToolNames: null as string[] | null, setActiveToolsCalls: [] as string[][] };
  return {
    tools,
    get activeToolNames() {
      return state.activeToolNames;
    },
    get setActiveToolsCalls() {
      return state.setActiveToolsCalls;
    },
    registerTool: mock((tool: ToolDef) => {
      tools.push(tool);
    }),
    getActiveTools: mock(() => {
      if (state.activeToolNames === null) {
        return tools.map((t) => t.name);
      }
      return tools.filter((t) => state.activeToolNames!.includes(t.name)).map((t) => t.name);
    }),
    setActiveTools: mock((names: string[]) => {
      state.activeToolNames = names;
      state.setActiveToolsCalls.push(names);
    }),
  } as unknown as ExtensionAPI & {
    tools: ToolDef[];
    activeToolNames: string[] | null;
    setActiveToolsCalls: string[][];
  };
}

// Create a mock session manager context
function createMockContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionManager: {
      getSessionId: mock(() => TEST_SESSION_ID),
      getEntries: mock(() => [
        { type: "custom", customType: "hindsight-meta", data: { retained: true } },
      ]),
      getHeader: mock(() => ({ id: TEST_SESSION_ID, parentSession: undefined })),
    },
    cwd: "/test/project",
    signal: undefined,
    ...overrides,
  };
}

// Create a mock client
function createMockClient(): HindsightClientWrapper {
  return {
    recall: mock(() => Promise.resolve({ success: true, response: { results: [] } })),
    reflect: mock(() => Promise.resolve({ success: true, response: { text: "" } })),
    healthCheck: mock(() => Promise.resolve({ success: true })),
    retain: mock(() => Promise.resolve({ success: true })),
    retainBatch: mock(() => Promise.resolve({ success: true })),
  } as unknown as HindsightClientWrapper;
}

afterEach(() => {
  // Clean up any queue files created during tests
  deleteAutoQueue(TEST_SESSION_ID);
  deleteToolQueue(TEST_SESSION_ID);
});

// ============================================
// Registration tests
// ============================================

// Note: hindsight_retain is queue-based (synchronous file append) with no
// long-running async operation to abort, so abort/signal handling is not
// tested for it. In contrast, hindsight_recall and hindsight_reflect make
// network requests and properly forward AbortSignal to the client.

describe("registerTools", () => {
  it("does not register any tools when toolsEnabled is false", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: false as const };
    registerTools(pi, config, createMockClient());
    expect(pi.tools).toHaveLength(0);
  });

  it("registers hindsight_retain when toolsEnabled is true", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_retain")).toBe(true);
  });

  it("registers hindsight_recall and hindsight_reflect when client is provided", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_recall")).toBe(true);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_reflect")).toBe(true);
  });

  it("does not register hindsight_recall or hindsight_reflect when client is null", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, null);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_recall")).toBe(false);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_reflect")).toBe(false);
  });

  it("registers only listed tools when toolsEnabled is an array", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: ["retain", "recall"] as ["retain", "recall"] };
    registerTools(pi, config, createMockClient());
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_retain")).toBe(true);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_recall")).toBe(true);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_reflect")).toBe(false);
    expect(pi.tools).toHaveLength(2);
  });

  it("registers only retain when toolsEnabled is ['retain', 'recall'] and client is null", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: ["retain", "recall"] as ["retain", "recall"] };
    registerTools(pi, config, null);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_retain")).toBe(true);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_recall")).toBe(false);
    expect(pi.tools).toHaveLength(1);
  });

  it("registers no tools when toolsEnabled is ['recall'] and client is null", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: ["recall"] as ["recall"] };
    registerTools(pi, config, null);
    expect(pi.tools).toHaveLength(0);
  });

  it("registers only recall when toolsEnabled is ['recall'] with client", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: ["recall"] as ["recall"] };
    registerTools(pi, config, createMockClient());
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_retain")).toBe(false);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_recall")).toBe(true);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_reflect")).toBe(false);
    expect(pi.tools).toHaveLength(1);
  });
});

// ============================================
// hindsight_retain execute tests
// ============================================

describe("hindsight_retain", () => {
  it("queues content to tool queue on success", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const retainTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_retain");
    const ctx = createMockContext();

    const result = (await retainTool!.execute(
      "tc1",
      { content: "Important fact" },
      undefined,
      undefined,
      ctx
    )) as { content: Array<{ type: string; text: string }>; details: { success: boolean } };

    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain("queued");

    // Verify the tool queue was actually written
    const queueEntries = readToolQueue(TEST_SESSION_ID);
    expect(queueEntries).toHaveLength(1);
    expect(queueEntries[0]?.content).toBe("Important fact");
  });

  it("passes tags and metadata to queue entry", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const retainTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_retain");
    const ctx = createMockContext();

    await retainTool!.execute(
      "tc1",
      { content: "Tagged fact", tags: ["topic:test"], metadata: { source: "user" } },
      undefined,
      undefined,
      ctx
    );

    const queueEntries = readToolQueue(TEST_SESSION_ID);
    expect(queueEntries[0]?.tags).toContain("topic:test");
    expect(queueEntries[0]?.metadata).toEqual({ source: "user" });
  });

  it("returns error when no active session", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const retainTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_retain");
    const ctx = createMockContext({
      sessionManager: {
        getSessionId: mock(() => null),
        getEntries: mock(() => []),
        getHeader: mock(() => ({})),
      },
    });

    const result = (await retainTool!.execute(
      "tc1",
      { content: "Fact" },
      undefined,
      undefined,
      ctx
    )) as {
      content: Array<{ type: string; text: string }>;
      details: { success: boolean; error: string };
    };
    expect(result.details.success).toBe(false);
    expect(result.details.error).toContain("no active session");
  });

  it("returns error when session does not allow retention", async () => {
    const pi = createMockPi();
    const config = { ...testConfig, retainSessionsByDefault: false };
    registerTools(pi, config, createMockClient());
    const retainTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_retain");
    const ctx = createMockContext({
      sessionManager: {
        getSessionId: mock(() => TEST_SESSION_ID),
        getEntries: mock(() => []), // no meta, falls back to retainSessionsByDefault: false
        getHeader: mock(() => ({ id: TEST_SESSION_ID })),
      },
    });

    const result = (await retainTool!.execute(
      "tc1",
      { content: "Fact" },
      undefined,
      undefined,
      ctx
    )) as {
      content: { type: string; text: string }[];
      details: { success: boolean; error: string };
    };
    expect(result.details.success).toBe(false);
    expect(result.details.error).toContain("does not allow retention");
    expect(result.content[0]!.text).toContain("Warning:");
  });
});

// ============================================
// hindsight_recall execute tests
// ============================================

describe("hindsight_recall", () => {
  it("returns formatted results on success", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    (client.recall as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      response: {
        results: [
          { id: "1", text: "User prefers dark mode" },
          { id: "2", text: "User uses VS Code" },
        ],
      } as RecallResponse,
    });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    const result = (await recallTool!.execute(
      "tc1",
      { query: "editor preferences" },
      undefined,
      undefined,
      ctx
    )) as { content: Array<{ type: string; text: string }>; details: { success: boolean } };
    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain("1. User prefers dark mode");
    expect(result.content[0]?.text).toContain("2. User uses VS Code");
  });

  it("returns no results message when empty", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    (client.recall as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      response: { results: [] },
    });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    const result = (await recallTool!.execute(
      "tc1",
      { query: "nothing" },
      undefined,
      undefined,
      ctx
    )) as { content: Array<{ type: string; text: string }>; details: { success: boolean } };
    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain("No relevant memories found");
  });

  it("returns error on client failure", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    (client.recall as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      error: "API error",
    });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    const result = (await recallTool!.execute(
      "tc1",
      { query: "test" },
      undefined,
      undefined,
      ctx
    )) as {
      content: Array<{ type: string; text: string }>;
      details: { success: boolean; error: string };
    };
    expect(result.details.success).toBe(false);
    expect(result.content[0]?.text).toContain("Failed to recall");
    expect(result.details.error).toBe("API error");
  });

  it("passes types from params or config defaults", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const recallMock = client.recall as unknown as ReturnType<typeof mock>;
    recallMock.mockResolvedValueOnce({
      success: true,
      response: { results: [] },
    });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    await recallTool!.execute("tc1", { query: "test" }, undefined, undefined, ctx);

    // Should have been called with config defaults (recallTypes: ["observation"])
    expect(recallMock).toHaveBeenCalled();
    const callArgs = recallMock.mock.calls[0]![0]!;
    expect(callArgs.types).toEqual(["observation"]);
  });
});

// ============================================
// hindsight_reflect execute tests
// ============================================

describe("hindsight_reflect", () => {
  it("returns response text on success", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    (client.reflect as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      response: {
        text: "The user prefers dark mode based on past interactions.",
      } as ReflectResponse,
    });
    registerTools(pi, testConfig, client);
    const reflectTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_reflect");
    const ctx = createMockContext();

    const result = (await reflectTool!.execute(
      "tc1",
      { query: "theme preference" },
      undefined,
      undefined,
      ctx
    )) as { content: Array<{ type: string; text: string }>; details: { success: boolean } };
    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toBe("The user prefers dark mode based on past interactions.");
  });

  it("returns no memories message when response has no text", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    (client.reflect as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      response: { text: "" } as ReflectResponse,
    });
    registerTools(pi, testConfig, client);
    const reflectTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_reflect");
    const ctx = createMockContext();

    const result = (await reflectTool!.execute(
      "tc1",
      { query: "nothing" },
      undefined,
      undefined,
      ctx
    )) as { content: Array<{ type: string; text: string }>; details: { success: boolean } };
    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain("No relevant memories found to reflect on");
  });

  it("returns error on client failure", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    (client.reflect as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      error: "timeout",
    });
    registerTools(pi, testConfig, client);
    const reflectTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_reflect");
    const ctx = createMockContext();

    const result = (await reflectTool!.execute(
      "tc1",
      { query: "test" },
      undefined,
      undefined,
      ctx
    )) as {
      content: Array<{ type: string; text: string }>;
      details: { success: boolean; error: string };
    };
    expect(result.details.success).toBe(false);
    expect(result.content[0]?.text).toContain("Failed to reflect");
    expect(result.details.error).toBe("timeout");
  });
});

// ============================================
// Parameter forwarding tests
// ============================================

describe("hindsight_recall parameter forwarding", () => {
  it("forwards tags to client.recall", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const recallMock = client.recall as unknown as ReturnType<typeof mock>;
    recallMock.mockResolvedValueOnce({ success: true, response: { results: [] } });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    await recallTool!.execute(
      "tc1",
      { query: "test", tags: ["topic:billing", "priority:high"] },
      undefined,
      undefined,
      ctx
    );

    const callArgs = recallMock.mock.calls[0]![0]!;
    expect(callArgs.tags).toEqual(["topic:billing", "priority:high"]);
  });

  it("forwards tagsMatch to client.recall", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const recallMock = client.recall as unknown as ReturnType<typeof mock>;
    recallMock.mockResolvedValueOnce({ success: true, response: { results: [] } });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    await recallTool!.execute(
      "tc1",
      { query: "test", tagsMatch: "all" },
      undefined,
      undefined,
      ctx
    );

    const callArgs = recallMock.mock.calls[0]![0]!;
    expect(callArgs.tagsMatch).toBe("all");
  });

  it("forwards budget to client.recall", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const recallMock = client.recall as unknown as ReturnType<typeof mock>;
    recallMock.mockResolvedValueOnce({ success: true, response: { results: [] } });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    await recallTool!.execute("tc1", { query: "test", budget: "high" }, undefined, undefined, ctx);

    const callArgs = recallMock.mock.calls[0]![0]!;
    expect(callArgs.budget).toBe("high");
  });

  it("passes signal to client.recall", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const recallMock = client.recall as unknown as ReturnType<typeof mock>;
    recallMock.mockResolvedValueOnce({ success: true, response: { results: [] } });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    const controller = new AbortController();
    await recallTool!.execute("tc1", { query: "test" }, controller.signal, undefined, ctx);

    const callArgs = recallMock.mock.calls[0]!;
    // Signal is the second argument to client.recall
    expect(callArgs[1]).toBe(controller.signal);
  });

  it("uses config defaults for types when not specified", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const recallMock = client.recall as unknown as ReturnType<typeof mock>;
    recallMock.mockResolvedValueOnce({ success: true, response: { results: [] } });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    await recallTool!.execute("tc1", { query: "test" }, undefined, undefined, ctx);

    const callArgs = recallMock.mock.calls[0]![0]!;
    // testConfig.recallTypes = ["observation"]
    expect(callArgs.types).toEqual(["observation"]);
  });

  it("overrides types when explicitly specified", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const recallMock = client.recall as unknown as ReturnType<typeof mock>;
    recallMock.mockResolvedValueOnce({ success: true, response: { results: [] } });
    registerTools(pi, testConfig, client);
    const recallTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_recall");
    const ctx = createMockContext();

    await recallTool!.execute(
      "tc1",
      { query: "test", types: ["world", "experience"] },
      undefined,
      undefined,
      ctx
    );

    const callArgs = recallMock.mock.calls[0]![0]!;
    expect(callArgs.types).toEqual(["world", "experience"]);
  });
});

describe("hindsight_reflect parameter forwarding", () => {
  it("forwards tags to client.reflect", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const reflectMock = client.reflect as unknown as ReturnType<typeof mock>;
    reflectMock.mockResolvedValueOnce({
      success: true,
      response: { text: "result" } as ReflectResponse,
    });
    registerTools(pi, testConfig, client);
    const reflectTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_reflect");
    const ctx = createMockContext();

    await reflectTool!.execute(
      "tc1",
      { query: "test", tags: ["project:acme"] },
      undefined,
      undefined,
      ctx
    );

    const callArgs = reflectMock.mock.calls[0]![0]!;
    expect(callArgs.tags).toEqual(["project:acme"]);
  });

  it("forwards tagsMatch to client.reflect", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const reflectMock = client.reflect as unknown as ReturnType<typeof mock>;
    reflectMock.mockResolvedValueOnce({
      success: true,
      response: { text: "result" } as ReflectResponse,
    });
    registerTools(pi, testConfig, client);
    const reflectTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_reflect");
    const ctx = createMockContext();

    await reflectTool!.execute(
      "tc1",
      { query: "test", tagsMatch: "any_strict" },
      undefined,
      undefined,
      ctx
    );

    const callArgs = reflectMock.mock.calls[0]![0]!;
    expect(callArgs.tagsMatch).toBe("any_strict");
  });

  it("forwards budget to client.reflect", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const reflectMock = client.reflect as unknown as ReturnType<typeof mock>;
    reflectMock.mockResolvedValueOnce({
      success: true,
      response: { text: "result" } as ReflectResponse,
    });
    registerTools(pi, testConfig, client);
    const reflectTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_reflect");
    const ctx = createMockContext();

    await reflectTool!.execute("tc1", { query: "test", budget: "low" }, undefined, undefined, ctx);

    const callArgs = reflectMock.mock.calls[0]![0]!;
    expect(callArgs.budget).toBe("low");
  });

  it("passes signal to client.reflect", async () => {
    const pi = createMockPi();
    const client = createMockClient();
    const reflectMock = client.reflect as unknown as ReturnType<typeof mock>;
    reflectMock.mockResolvedValueOnce({
      success: true,
      response: { text: "result" } as ReflectResponse,
    });
    registerTools(pi, testConfig, client);
    const reflectTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_reflect");
    const ctx = createMockContext();

    const controller = new AbortController();
    await reflectTool!.execute("tc1", { query: "test" }, controller.signal, undefined, ctx);

    const callArgs = reflectMock.mock.calls[0]!;
    expect(callArgs[1]).toBe(controller.signal);
  });
});

describe("hindsight_retain context forwarding", () => {
  it("queues entry with parent session metadata", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const retainTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_retain");
    const ctx = createMockContext({
      sessionManager: {
        getSessionId: mock(() => TEST_SESSION_ID),
        getEntries: mock(() => [
          { type: "custom", customType: "hindsight-meta", data: { retained: true } },
        ]),
        getHeader: mock(() => ({
          id: TEST_SESSION_ID,
          parentSession: "/some/path/parent-uuid.jsonl",
        })),
      },
    });

    await retainTool!.execute("tc1", { content: "Important fact" }, undefined, undefined, ctx);

    const queueEntries = readToolQueue(TEST_SESSION_ID);
    expect(queueEntries).toHaveLength(1);
    // Should include session and parent tags
    const tags = queueEntries[0]?.tags ?? [];
    expect(tags.some((t: string) => t.startsWith("session:"))).toBe(true);
    expect(tags.some((t: string) => t.startsWith("parent:"))).toBe(true);
  });

  it("queues entry with session tags from hindsight-meta", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const retainTool = pi.tools.find((t: ToolDef) => t.name === "hindsight_retain");
    const ctx = createMockContext({
      sessionManager: {
        getSessionId: mock(() => TEST_SESSION_ID),
        getEntries: mock(() => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, tags: ["topic:ai", "project:x"] },
          },
        ]),
        getHeader: mock(() => ({ id: TEST_SESSION_ID })),
      },
    });

    await retainTool!.execute("tc1", { content: "Important fact" }, undefined, undefined, ctx);

    const queueEntries = readToolQueue(TEST_SESSION_ID);
    const tags = queueEntries[0]?.tags ?? [];
    expect(tags).toContain("topic:ai");
    expect(tags).toContain("project:x");
  });
});

// ============================================
// updateRetainToolVisibility tests
// ============================================

describe("updateRetainToolVisibility", () => {
  it("removes hindsight_retain from active tools when not retained", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());

    // Initially all tools are active
    const activeBefore = pi.getActiveTools();
    expect(activeBefore).toContain("hindsight_retain");

    updateRetainToolVisibility(pi, false);

    const activeAfter = pi.getActiveTools();
    expect(activeAfter).not.toContain("hindsight_retain");
    // Other hindsight tools should remain
    expect(activeAfter).toContain("hindsight_recall");
    expect(activeAfter).toContain("hindsight_reflect");
  });

  it("adds hindsight_retain back when session becomes retained", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());

    // Remove first
    updateRetainToolVisibility(pi, false);
    const activeAfterRemove = pi.getActiveTools();
    expect(activeAfterRemove).not.toContain("hindsight_retain");

    // Add back
    updateRetainToolVisibility(pi, true);
    const activeAfterAdd = pi.getActiveTools();
    expect(activeAfterAdd).toContain("hindsight_retain");
  });

  it("is a no-op when retained=true and tool is already active", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());

    // Tool is active by default
    const callCountBefore = pi.setActiveToolsCalls.length;
    updateRetainToolVisibility(pi, true);

    // setActiveTools should not have been called
    expect(pi.setActiveToolsCalls.length).toBe(callCountBefore);
  });

  it("is a no-op when retained=false and tool is already inactive", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());

    // Remove first
    updateRetainToolVisibility(pi, false);
    const callCountAfterRemove = pi.setActiveToolsCalls.length;

    // Calling again should be a no-op
    updateRetainToolVisibility(pi, false);
    expect(pi.setActiveToolsCalls.length).toBe(callCountAfterRemove);
  });
});

describe("isToolEnabled", () => {
  it("returns true when toolsEnabled is true", () => {
    expect(isToolEnabled({ ...testConfig, toolsEnabled: true }, "retain")).toBe(true);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: true }, "recall")).toBe(true);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: true }, "reflect")).toBe(true);
  });

  it("returns false when toolsEnabled is false", () => {
    expect(isToolEnabled({ ...testConfig, toolsEnabled: false }, "retain")).toBe(false);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: false }, "recall")).toBe(false);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: false }, "reflect")).toBe(false);
  });

  it("returns true only for tools listed in the array", () => {
    const config = { ...testConfig, toolsEnabled: ["retain", "recall"] as ["retain", "recall"] };
    expect(isToolEnabled(config, "retain")).toBe(true);
    expect(isToolEnabled(config, "recall")).toBe(true);
    expect(isToolEnabled(config, "reflect")).toBe(false);
  });

  it("returns false for all tools when toolsEnabled is an empty array", () => {
    const config = { ...testConfig, toolsEnabled: [] as [] };
    expect(isToolEnabled(config, "retain")).toBe(false);
    expect(isToolEnabled(config, "recall")).toBe(false);
    expect(isToolEnabled(config, "reflect")).toBe(false);
  });

  it("returns false when the tool is not in the array", () => {
    const config = { ...testConfig, toolsEnabled: ["recall"] as ["recall"] };
    expect(isToolEnabled(config, "retain")).toBe(false);
    expect(isToolEnabled(config, "reflect")).toBe(false);
  });
});
