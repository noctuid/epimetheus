/**
 * Unit tests for hindsight_retain, hindsight_recall, and hindsight_reflect tools.
 * Tests the execute paths using mocked pi API, client, and context.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RecallResponse, ReflectResponse } from "@vectorize-io/hindsight-client";
import type { HindsightClientWrapper } from "../src/client";
import type { HindsightConfig } from "../src/config";
import { clearSessionQueueState, removePendingFlag } from "../src/queue";
import {
  markStartupReady,
  resetActiveSessionProjectReady,
  resetRegisteredHindsightTools,
  resetStartupReady,
  setActiveSessionProjectReady,
} from "../src/runtime-state";
import { isToolEnabled, refreshToolVisibility, registerTools } from "../src/tools";
import {
  readToolQueueFromDisk,
  setupTempAgentDir,
  testConfig as sharedTestConfig,
  withTempDir,
} from "./fixtures";

setupTempAgentDir("tools");

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
  appendedEntries: { customType: string; data?: unknown }[];
} {
  const tools: ToolDef[] = [];
  const appendedEntries: { customType: string; data?: unknown }[] = [];
  // Use a mutable object so the closure-based getActiveTools/setActiveTools share state
  const state = { activeToolNames: null as string[] | null, setActiveToolsCalls: [] as string[][] };
  return {
    tools,
    appendedEntries,
    get activeToolNames() {
      return state.activeToolNames;
    },
    get setActiveToolsCalls() {
      return state.setActiveToolsCalls;
    },
    registerTool: mock((tool: ToolDef) => {
      tools.push(tool);
    }),
    appendEntry: mock((customType: string, data?: unknown) => {
      appendedEntries.push({ customType, data });
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
    appendedEntries: { customType: string; data?: unknown }[];
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
  removePendingFlag(TEST_SESSION_ID);
  clearSessionQueueState(TEST_SESSION_ID);
  // Reset runtime-state latches so tests start/leave operational state clean.
  resetStartupReady();
  resetActiveSessionProjectReady();
  resetRegisteredHindsightTools();
});

// ============================================
// Registration tests
// ============================================

// Note: hindsight_retain is queue-based (synchronous file append) with no
// long-running async operation to abort, so abort/signal handling is not
// tested for it. In contrast, hindsight_recall and hindsight_reflect make
// network requests and properly forward AbortSignal to the client.

describe("registerTools", () => {
  it("registers no tools when toolsEnabled is false", () => {
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
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_set_extra_context")).toBe(false);
    expect(pi.tools).toHaveLength(2); // retain + recall
  });

  it("registers only hindsight_retain when toolsEnabled is ['retain', 'recall'] and client is null", () => {
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

  it("registers only hindsight_recall when toolsEnabled is ['recall'] with client", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: ["recall"] as ["recall"] };
    registerTools(pi, config, createMockClient());
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_retain")).toBe(false);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_recall")).toBe(true);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_reflect")).toBe(false);
    expect(pi.tools).toHaveLength(1);
  });

  it("registers hindsight_set_extra_context when toolsEnabled is true", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_set_extra_context")).toBe(true);
  });

  it("registers hindsight_set_extra_context when 'set_extra_context' is in toolsEnabled array", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: ["set_extra_context"] as ["set_extra_context"] };
    registerTools(pi, config, null);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_set_extra_context")).toBe(true);
    expect(pi.tools).toHaveLength(1);
  });

  it("does not register hindsight_set_extra_context when not in toolsEnabled array", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: ["retain"] as ["retain"] };
    registerTools(pi, config, null);
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_set_extra_context")).toBe(false);
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
    const queueEntries = readToolQueueFromDisk(TEST_SESSION_ID);
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

    const queueEntries = readToolQueueFromDisk(TEST_SESSION_ID);
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

  it("returns error when project-local config is invalid (fix-config)", async () => {
    // The retain tool re-resolves the project name before queueing (so a
    // memory is never tagged with the wrong project name). A marked session
    // whose cwd-local config is invalid fails closed: no queue entry, and the
    // tool surfaces the specific reason + fix-config recovery advice.
    await withTempDir(async (tmpCwd) => {
      mkdirSync(join(tmpCwd, ".pi", "epimetheus"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".pi", "epimetheus", "config.jsonc"),
        JSON.stringify({ notProjectName: "x" }),
        "utf-8"
      );

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
              data: { retained: true, usesProjectConfig: true },
            },
          ]),
          getHeader: mock(() => ({ id: TEST_SESSION_ID, cwd: tmpCwd })),
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
      expect(result.details.error).toContain("project config");
      expect(result.details.error).toContain("invalid");
      expect(result.content[0]!.text).toContain("Failed to store memory");
      expect(result.content[0]!.text).toContain("Fix the config at");
      expect(result.content[0]!.text).toContain(tmpCwd);
      // Nothing was queued.
      expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    });
  });

  it("returns error when project-local config is missing (detach-or-fix)", async () => {
    // Marked session whose cwd has no project config file: fail closed with
    // the detach-or-fix recovery advice (suggests /hindsight detach-project-name).
    await withTempDir(async (tmpCwd) => {
      // No .pi/epimetheus/config.jsonc at tmpCwd.
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
              data: { retained: true, usesProjectConfig: true },
            },
          ]),
          getHeader: mock(() => ({ id: TEST_SESSION_ID, cwd: tmpCwd })),
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
      expect(result.details.error).toContain("no project config file is present");
      expect(result.content[0]!.text).toContain("Failed to store memory");
      expect(result.content[0]!.text).toContain("detach-project-name");
      expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    });
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

    // Should have been called with config defaults (autoRecallTypes: ["observation"])
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
    // testConfig.autoRecallTypes = ["observation"]
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

    const queueEntries = readToolQueueFromDisk(TEST_SESSION_ID);
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

    const queueEntries = readToolQueueFromDisk(TEST_SESSION_ID);
    const tags = queueEntries[0]?.tags ?? [];
    expect(tags).toContain("topic:ai");
    expect(tags).toContain("project:x");
  });
});

// ============================================
// refreshToolVisibility tests
// ============================================

describe("refreshToolVisibility", () => {
  /** Make the extension operational so tools can be shown. */
  function beOperational(): void {
    markStartupReady();
    setActiveSessionProjectReady(true);
  }

  it("hides ALL hindsight tools when degraded (not operational)", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    beOperational();
    // Start operational+retained: all hindsight tools active.
    refreshToolVisibility(pi, true);
    expect(pi.getActiveTools()).toContain("hindsight_retain");
    expect(pi.getActiveTools()).toContain("hindsight_recall");
    expect(pi.getActiveTools()).toContain("hindsight_reflect");

    // Flip to degraded: ALL hindsight tools hidden (not just retain).
    setActiveSessionProjectReady(false);
    refreshToolVisibility(pi, true);
    const active = pi.getActiveTools();
    expect(active).not.toContain("hindsight_retain");
    expect(active).not.toContain("hindsight_recall");
    expect(active).not.toContain("hindsight_reflect");
    expect(active).not.toContain("hindsight_set_extra_context");
    expect(active).not.toContain("hindsight_get_extra_context");
  });

  it("when operational + retained, shows all registered hindsight tools incl retain", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    beOperational();

    refreshToolVisibility(pi, true);

    const active = pi.getActiveTools();
    expect(active).toContain("hindsight_retain");
    expect(active).toContain("hindsight_recall");
    expect(active).toContain("hindsight_reflect");
  });

  it("when operational + not retained, hides only hindsight_retain", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    beOperational();

    refreshToolVisibility(pi, false);

    const active = pi.getActiveTools();
    expect(active).not.toContain("hindsight_retain");
    // Read-only tools remain available when operational.
    expect(active).toContain("hindsight_recall");
    expect(active).toContain("hindsight_reflect");
  });

  it("restores hindsight_retain when transitioning not-retained -> retained while operational", () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    beOperational();

    refreshToolVisibility(pi, false);
    expect(pi.getActiveTools()).not.toContain("hindsight_retain");

    refreshToolVisibility(pi, true);
    expect(pi.getActiveTools()).toContain("hindsight_retain");
  });

  it("preserves non-hindsight tools across visibility changes", () => {
    const pi = createMockPi();
    // Register an unrelated tool to simulate other extensions/built-ins.
    (pi as unknown as { registerTool: (t: unknown) => void }).registerTool({
      name: "other_tool",
      execute: () => ({}),
      parameters: {},
    });
    registerTools(pi, testConfig, createMockClient());
    beOperational();

    refreshToolVisibility(pi, false); // hide retain
    expect(pi.getActiveTools()).toContain("other_tool");

    setActiveSessionProjectReady(false); // degraded
    refreshToolVisibility(pi, true);
    expect(pi.getActiveTools()).toContain("other_tool");
    expect(pi.getActiveTools()).not.toContain("hindsight_retain");
  });
});

describe("isToolEnabled", () => {
  it("returns true when toolsEnabled is true", () => {
    expect(isToolEnabled({ ...testConfig, toolsEnabled: true }, "retain")).toBe(true);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: true }, "recall")).toBe(true);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: true }, "reflect")).toBe(true);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: true }, "set_extra_context")).toBe(true);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: true }, "get_extra_context")).toBe(true);
  });

  it("returns false when toolsEnabled is false", () => {
    expect(isToolEnabled({ ...testConfig, toolsEnabled: false }, "retain")).toBe(false);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: false }, "recall")).toBe(false);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: false }, "reflect")).toBe(false);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: false }, "set_extra_context")).toBe(false);
    expect(isToolEnabled({ ...testConfig, toolsEnabled: false }, "get_extra_context")).toBe(false);
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
    expect(isToolEnabled(config, "set_extra_context")).toBe(false);
  });

  it("returns true for set_extra_context when in array", () => {
    const config = { ...testConfig, toolsEnabled: ["set_extra_context"] as ["set_extra_context"] };
    expect(isToolEnabled(config, "set_extra_context")).toBe(true);
    expect(isToolEnabled(config, "retain")).toBe(false);
  });
});

// ============================================
// hindsight_set_extra_context tests
// ============================================

describe("hindsight_set_extra_context", () => {
  it("is not registered when toolsEnabled is false", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: false as const };
    registerTools(pi, config, createMockClient());
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_set_extra_context")).toBe(false);
  });

  it("sets extraContext in session metadata", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const tool = pi.tools.find((t: ToolDef) => t.name === "hindsight_set_extra_context");
    const ctx = createMockContext();

    const result = (await tool!.execute(
      "tc1",
      { text: "This session involves reading a fiction book" },
      undefined,
      undefined,
      ctx
    )) as { content: Array<{ type: string; text: string }>; details: { success: boolean } };

    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain("Extra context set");

    // Verify the metadata was appended
    const lastEntry = pi.appendedEntries[pi.appendedEntries.length - 1];
    expect(lastEntry?.customType).toBe("hindsight-meta");
    expect((lastEntry?.data as Record<string, unknown>)?.extraContext).toBe(
      "This session involves reading a fiction book"
    );
  });

  it("stores empty extraContext when text is empty (satisfies flush guard)", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const tool = pi.tools.find((t: ToolDef) => t.name === "hindsight_set_extra_context");
    const ctx = createMockContext();

    const result = (await tool!.execute("tc1", { text: "" }, undefined, undefined, ctx)) as {
      content: Array<{ type: string; text: string }>;
      details: { success: boolean };
    };

    expect(result.details.success).toBe(true);
    expect(result.content[0]?.text).toContain("No extra context needed");

    // Verify the metadata was appended with extraContext: "" (empty string signals "no extra context needed",
    // distinct from not having the key at all — this satisfies the flush guard)
    const lastEntry = pi.appendedEntries[pi.appendedEntries.length - 1];
    expect(lastEntry?.customType).toBe("hindsight-meta");
    expect((lastEntry?.data as Record<string, unknown>)?.extraContext).toBe("");
  });

  it("preserves existing retained state and tags when setting extraContext", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const tool = pi.tools.find((t: ToolDef) => t.name === "hindsight_set_extra_context");
    const ctx = createMockContext({
      sessionManager: {
        getSessionId: mock(() => TEST_SESSION_ID),
        getEntries: mock(() => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, tags: ["topic:ai"], extraContext: "old context" },
          },
        ]),
        getHeader: mock(() => ({ id: TEST_SESSION_ID })),
      },
    });

    await tool!.execute("tc1", { text: "new context" }, undefined, undefined, ctx);

    const lastEntry = pi.appendedEntries[pi.appendedEntries.length - 1];
    const data = lastEntry?.data as Record<string, unknown>;
    expect(data.retained).toBe(true);
    expect(data.tags).toEqual(["topic:ai"]);
    expect(data.extraContext).toBe("new context");
  });
});

// ============================================
// hindsight_get_extra_context tests
// ============================================

describe("hindsight_get_extra_context", () => {
  it("is not registered when toolsEnabled is false", () => {
    const pi = createMockPi();
    const config = { ...testConfig, toolsEnabled: false as const };
    registerTools(pi, config, createMockClient());
    expect(pi.tools.some((t: ToolDef) => t.name === "hindsight_get_extra_context")).toBe(false);
  });

  it("returns extra context when set", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const tool = pi.tools.find((t: ToolDef) => t.name === "hindsight_get_extra_context");
    const ctx = createMockContext({
      sessionManager: {
        getSessionId: mock(() => TEST_SESSION_ID),
        getEntries: mock(() => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { extraContext: "This is fiction" },
          },
        ]),
        getHeader: mock(() => ({ id: TEST_SESSION_ID })),
      },
    });

    const result = (await tool!.execute("tc1", {}, undefined, undefined, ctx)) as {
      content: Array<{ type: string; text: string }>;
      details: { success: boolean; extraContext?: string };
    };

    expect(result.details.success).toBe(true);
    expect(result.details.extraContext).toBe("This is fiction");
    expect(result.content[0]?.text).toContain("This is fiction");
  });

  it("returns no extra context set when not set", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const tool = pi.tools.find((t: ToolDef) => t.name === "hindsight_get_extra_context");
    const ctx = createMockContext();

    const result = (await tool!.execute("tc1", {}, undefined, undefined, ctx)) as {
      content: Array<{ type: string; text: string }>;
      details: { success: boolean; extraContext?: string };
    };

    expect(result.details.success).toBe(true);
    expect(result.details.extraContext).toBeUndefined();
    expect(result.content[0]?.text).toContain("No extra context set");
  });

  it("returns empty string context with flush guard message", async () => {
    const pi = createMockPi();
    registerTools(pi, testConfig, createMockClient());
    const tool = pi.tools.find((t: ToolDef) => t.name === "hindsight_get_extra_context");
    const ctx = createMockContext({
      sessionManager: {
        getSessionId: mock(() => TEST_SESSION_ID),
        getEntries: mock(() => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { extraContext: "" },
          },
        ]),
        getHeader: mock(() => ({ id: TEST_SESSION_ID })),
      },
    });

    const result = (await tool!.execute("tc1", {}, undefined, undefined, ctx)) as {
      content: Array<{ type: string; text: string }>;
      details: { success: boolean; extraContext?: string };
    };

    expect(result.details.success).toBe(true);
    expect(result.details.extraContext).toBe("");
    expect(result.content[0]?.text).toContain("flush guard satisfied");
  });
});
