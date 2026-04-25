/**
 * Unit tests for retention logic.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import type { HindsightClientWrapper } from "../src/client";
import type { HindsightConfig } from "../src/config";
import {
  deleteAutoQueue,
  deleteToolQueue,
  enqueueAutoMessage,
  enqueueToolMessage,
  readAutoQueue,
  readToolQueue,
} from "../src/queue";
import {
  flushAutoQueue,
  flushQueues,
  flushToolQueue,
  getQueueCount,
  queueToolRetain,
} from "../src/retention";

const TEST_SESSION_ID = "test-session-retention";

// Type for mock client wrapper
interface MockClientWrapper {
  retain: (
    options: {
      content: string;
      documentId?: string;
      tags?: string[];
      context?: string;
      timestamp?: string;
      updateMode?: string;
      entities?: { text: string; type?: string }[];
    },
    signal?: AbortSignal
  ) => Promise<{ success: boolean; error?: string }>;
  retainBatch: (
    entries: MemoryItemInput[],
    signal?: AbortSignal
  ) => Promise<{ success: boolean; error?: string }>;
}

// Create a mock wrapper that matches HindsightClientWrapper interface
function createMockWrapper(
  options: {
    retainSuccess?: boolean;
    retainError?: string;
    retainBatchSuccess?: boolean;
    retainBatchError?: string;
  } = {}
): MockClientWrapper & { retainCalls: unknown[]; retainBatchCalls: unknown[] } {
  const retainCalls: unknown[] = [];
  const retainBatchCalls: unknown[] = [];

  return {
    retainCalls,
    retainBatchCalls,
    async retain(
      opts: {
        content: string;
        documentId?: string;
        tags?: string[];
        context?: string;
        timestamp?: string;
        updateMode?: string;
      },
      _signal?: AbortSignal
    ) {
      retainCalls.push(opts);
      if (options.retainSuccess === false) {
        return { success: false, error: options.retainError ?? "retain failed" };
      }
      return { success: true };
    },
    async retainBatch(entries: MemoryItemInput[], _signal?: AbortSignal) {
      retainBatchCalls.push(entries);
      if (options.retainBatchSuccess === false) {
        return { success: false, error: options.retainBatchError ?? "retainBatch failed" };
      }
      return { success: true };
    },
  };
}

import { testConfig as sharedTestConfig } from "./fixtures";

// Extend shared config with retention-test-specific overrides
const defaultConfig: HindsightConfig = {
  ...sharedTestConfig,
  recallPromptPreamble: "Test preamble",
  constantTags: ["harness:pi"],
  retainContent: {
    assistant: ["text"],
    user: ["text"],
    toolResult: [],
  },
  strip: {
    topLevel: [],
    message: [],
  },
};

beforeEach(() => {
  // Clean up any existing queues
  deleteAutoQueue(TEST_SESSION_ID);
  deleteToolQueue(TEST_SESSION_ID);
});

afterEach(() => {
  deleteAutoQueue(TEST_SESSION_ID);
  deleteToolQueue(TEST_SESSION_ID);
});

describe("getQueueCount", () => {
  it("returns 0 when both queues are empty", () => {
    expect(getQueueCount(TEST_SESSION_ID)).toBe(0);
  });

  it("returns count of auto queue entries", () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "test" } },
      store_method: "auto",
    });
    expect(getQueueCount(TEST_SESSION_ID)).toBe(1);
  });

  it("returns count of tool queue entries", () => {
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "test",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    });
    expect(getQueueCount(TEST_SESSION_ID)).toBe(1);
  });

  it("returns combined count of both queues", () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "test" } },
      store_method: "auto",
    });
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "assistant", content: "response" } },
      store_method: "auto",
    });
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "tool content",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    });
    expect(getQueueCount(TEST_SESSION_ID)).toBe(3);
  });
});

describe("queueToolRetain", () => {
  it("queues a tool entry with correct tags", () => {
    const success = queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      ["topic:test"],
      { source: "manual" },
      "/home/user/project",
      "parent-123",
      defaultConfig
    );

    expect(success).toBe(true);

    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe("Remember this");
    expect(entries[0]?.tags).toContain("harness:pi");
    expect(entries[0]?.tags).toContain(`session:${TEST_SESSION_ID}`);
    expect(entries[0]?.tags).toContain("cwd:/home/user/project");
    expect(entries[0]?.tags).toContain("store_method:tool");
    expect(entries[0]?.tags).toContain("parent:parent-123");
    expect(entries[0]?.tags).toContain("topic:test");
    expect(entries[0]?.metadata).toEqual({ source: "manual" });
  });

  it("uses session ID as parent when no parent session", () => {
    queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      defaultConfig
    );

    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries[0]?.tags).toContain(`parent:${TEST_SESSION_ID}`);
  });
});

describe("flushAutoQueue", () => {
  it("returns success with count 0 when queue is empty", async () => {
    const mockWrapper = createMockWrapper();
    const result = await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(mockWrapper.retainCalls).toHaveLength(0);
  });

  it("flushes entries and deletes queue on success", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "assistant", content: "Hi" } },
      store_method: "auto",
    });

    const mockWrapper = createMockWrapper();
    const result = await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(mockWrapper.retainCalls).toHaveLength(1);
    expect(readAutoQueue(TEST_SESSION_ID)).toHaveLength(0);
  });

  it("leaves queue intact on failure", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const mockWrapper = createMockWrapper({ retainSuccess: false, retainError: "API error" });
    const result = await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("API error");
    expect(readAutoQueue(TEST_SESSION_ID)).toHaveLength(1);
  });
});

describe("flushToolQueue", () => {
  it("returns success with count 0 when queue is empty", async () => {
    const mockWrapper = createMockWrapper();
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(mockWrapper.retainBatchCalls).toHaveLength(0);
  });

  it("flushes entries and deletes queue on success", async () => {
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "Fact 1",
      tags: ["topic:test"],
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    });
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "Fact 2",
      tags: ["topic:other"],
      timestamp: "2024-01-01T00:01:00Z",
      store_method: "tool",
    });

    const mockWrapper = createMockWrapper();
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(mockWrapper.retainBatchCalls).toHaveLength(1);
    expect(mockWrapper.retainBatchCalls[0]).toHaveLength(2);
    expect(readToolQueue(TEST_SESSION_ID)).toHaveLength(0);
  });

  it("leaves queue intact on failure", async () => {
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "Fact",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    });

    const mockWrapper = createMockWrapper({
      retainBatchSuccess: false,
      retainBatchError: "Batch failed",
    });
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Batch failed");
    expect(readToolQueue(TEST_SESSION_ID)).toHaveLength(1);
  });
});

describe("flushQueues", () => {
  it("returns success with zero counts when both queues empty", async () => {
    const mockWrapper = createMockWrapper();
    const result = await flushQueues(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(true);
    expect(result.autoCount).toBe(0);
    expect(result.toolCount).toBe(0);
  });

  it("flushes only tool queue when auto queue is empty (regression: autoRetainEnabled=false)", async () => {
    // This is the regression test: even with no auto entries (e.g., autoRetainEnabled=false),
    // tool entries should still be flushed
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "Manual retain",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    });

    const mockWrapper = createMockWrapper();
    const result = await flushQueues(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(true);
    expect(result.autoCount).toBe(0);
    expect(result.toolCount).toBe(1);
    expect(mockWrapper.retainCalls).toHaveLength(0); // No auto retain
    expect(mockWrapper.retainBatchCalls).toHaveLength(1); // Tool batch retain
    expect(readToolQueue(TEST_SESSION_ID)).toHaveLength(0); // Queue deleted
  });

  it("flushes only auto queue when tool queue is empty", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const mockWrapper = createMockWrapper();
    const result = await flushQueues(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(true);
    expect(result.autoCount).toBe(1);
    expect(result.toolCount).toBe(0);
    expect(mockWrapper.retainCalls).toHaveLength(1);
    expect(mockWrapper.retainBatchCalls).toHaveLength(0);
    expect(readAutoQueue(TEST_SESSION_ID)).toHaveLength(0);
  });

  it("flushes both queues when both have entries", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "Manual retain",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    });

    const mockWrapper = createMockWrapper();
    const result = await flushQueues(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(true);
    expect(result.autoCount).toBe(1);
    expect(result.toolCount).toBe(1);
    expect(mockWrapper.retainCalls).toHaveLength(1);
    expect(mockWrapper.retainBatchCalls).toHaveLength(1);
    expect(readAutoQueue(TEST_SESSION_ID)).toHaveLength(0);
    expect(readToolQueue(TEST_SESSION_ID)).toHaveLength(0);
  });

  it("returns error when auto flush fails but still attempts tool flush", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "Manual retain",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    });

    const mockWrapper = createMockWrapper({ retainSuccess: false, retainError: "Auto failed" });
    const result = await flushQueues(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    // Tool flush should still happen
    expect(result.success).toBe(false);
    expect(result.error).toBe("Auto failed");
    expect(result.autoCount).toBe(0);
    expect(result.toolCount).toBe(1); // Tool flush succeeded
    expect(mockWrapper.retainBatchCalls).toHaveLength(1);
    expect(readAutoQueue(TEST_SESSION_ID)).toHaveLength(1); // Auto queue intact
    expect(readToolQueue(TEST_SESSION_ID)).toHaveLength(0); // Tool queue deleted
  });

  it("returns error when tool flush fails but auto flush succeeded", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });
    enqueueToolMessage(TEST_SESSION_ID, {
      content: "Manual retain",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    });

    const mockWrapper = createMockWrapper({
      retainBatchSuccess: false,
      retainBatchError: "Tool failed",
    });
    const result = await flushQueues(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool failed");
    expect(result.autoCount).toBe(1); // Auto flush succeeded
    expect(result.toolCount).toBe(0); // Tool flush failed
    expect(readAutoQueue(TEST_SESSION_ID)).toHaveLength(0); // Auto queue deleted
    expect(readToolQueue(TEST_SESSION_ID)).toHaveLength(1); // Tool queue intact
  });
});

describe("entities", () => {
  it("passes entities to retain in flushAutoQueue", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const configWithEntities: HindsightConfig = {
      ...defaultConfig,
      entities: [
        { text: "John", type: "PERSON" },
        { text: "Acme Corp", type: "ORG" },
      ],
    };

    const mockWrapper = createMockWrapper();
    await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      configWithEntities,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(mockWrapper.retainCalls).toHaveLength(1);
    const retainCall = mockWrapper.retainCalls[0] as {
      entities?: { text: string; type?: string }[];
    };
    expect(retainCall.entities).toHaveLength(2);
    expect(retainCall.entities?.[0]).toEqual({ text: "John", type: "PERSON" });
    expect(retainCall.entities?.[1]).toEqual({ text: "Acme Corp", type: "ORG" });
  });

  it("does not include entities when config.entities is empty", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const mockWrapper = createMockWrapper();
    await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig, // entities: []
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(mockWrapper.retainCalls).toHaveLength(1);
    const retainCall = mockWrapper.retainCalls[0] as {
      entities?: { text: string; type?: string }[];
    };
    expect(retainCall.entities).toBeUndefined();
  });
});

describe("retention check", () => {
  it("includes session tags in auto flush tags", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const mockWrapper = createMockWrapper();
    const entries = [
      { type: "custom", customType: "hindsight-meta", data: { tags: ["topic:ai", "project:x"] } },
    ];

    await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper,
      undefined,
      entries as any
    );

    expect(mockWrapper.retainCalls).toHaveLength(1);
    const retainCall = mockWrapper.retainCalls[0] as { tags?: string[] };
    expect(retainCall.tags).toContain("topic:ai");
    expect(retainCall.tags).toContain("project:x");
    // Still includes base tags
    expect(retainCall.tags).toContain("harness:pi");
  });

  it("flushes normally when entries parameter is not provided", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const mockWrapper = createMockWrapper();
    const result = await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper
      // No entries parameter - should flush normally
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it("includes session tags in auto flush tags even with retained:false", async () => {
    // Even when meta says retained:false, if messages are in the queue,
    // they get flushed (queue is deleted on toggle-on, not checked on flush)
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const mockWrapper = createMockWrapper();
    const entries = [
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: false, tags: ["topic:ai"] },
      },
    ];

    const result = await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      defaultConfig,
      mockWrapper as unknown as HindsightClientWrapper,
      undefined,
      entries as any
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    const retainCall = mockWrapper.retainCalls[0] as { tags?: string[] };
    expect(retainCall.tags).toContain("topic:ai");
  });
});

describe("queueToolRetain with session tags", () => {
  it("includes session tags in tool queue tags", () => {
    const success = queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      ["topic:test"],
      { source: "manual" },
      "/home/user/project",
      "parent-123",
      defaultConfig,
      ["session-tag1", "session-tag2"]
    );

    expect(success).toBe(true);

    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tags).toContain("harness:pi");
    expect(entries[0]?.tags).toContain("topic:test");
    expect(entries[0]?.tags).toContain("session-tag1");
    expect(entries[0]?.tags).toContain("session-tag2");
  });

  it("works without session tags (backward compatible)", () => {
    const success = queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      defaultConfig
    );

    expect(success).toBe(true);

    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries[0]?.tags).toContain("harness:pi");
    expect(entries[0]?.tags).not.toContain("session-tag1");
  });
});

describe("observationScopes", () => {
  it("includes observation_scopes in tool queue entry when config is set", () => {
    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["session:abc"]],
    };
    const success = queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      configWithScopes
    );

    expect(success).toBe(true);
    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.observation_scopes).toEqual([["session:abc"]]);
  });

  it("does not include observation_scopes when config is null", () => {
    const success = queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      defaultConfig
    );

    expect(success).toBe(true);
    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.observation_scopes).toBeUndefined();
  });

  it("expands placeholders in observation_scopes at queue time", () => {
    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["{session}", "{parent}"], ["user:alice"]],
    };
    const success = queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      "parent-456",
      configWithScopes
    );

    expect(success).toBe(true);
    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries[0]?.observation_scopes).toEqual([
      [`session:${TEST_SESSION_ID}`, "parent:parent-456"],
      ["user:alice"],
    ]);
  });

  it("passes observation_scopes through flushToolQueue via retainBatch", async () => {
    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["session:abc"]],
    };
    queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      configWithScopes
    );

    const mockWrapper = createMockWrapper();
    await flushToolQueue(TEST_SESSION_ID, mockWrapper as unknown as HindsightClientWrapper);

    expect(mockWrapper.retainBatchCalls).toHaveLength(1);
    const batchItems = mockWrapper.retainBatchCalls[0] as MemoryItemInput[];
    expect(batchItems[0]?.observation_scopes).toEqual([["session:abc"]]);
  });

  it("passes observationScopes through flushAutoQueue via retain", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["session:abc", "user:alice"]],
    };

    const mockWrapper = createMockWrapper();
    await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      undefined,
      configWithScopes,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(mockWrapper.retainCalls).toHaveLength(1);
    const retainCall = mockWrapper.retainCalls[0] as { observationScopes?: unknown };
    // No placeholders present, so no expansion needed
    expect(retainCall.observationScopes).toEqual([["session:abc", "user:alice"]]);
  });

  it("expands placeholders in observationScopes during flushAutoQueue", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["{session}", "{parent}"], ["user:alice"]],
    };

    const mockWrapper = createMockWrapper();
    await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user",
      "parent-789",
      configWithScopes,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(mockWrapper.retainCalls).toHaveLength(1);
    const retainCall = mockWrapper.retainCalls[0] as { observationScopes?: unknown };
    expect(retainCall.observationScopes).toEqual([
      [`session:${TEST_SESSION_ID}`, "parent:parent-789"],
      ["user:alice"],
    ]);
  });

  it("expands {cwd} placeholder in observation_scopes at queue time", () => {
    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["{cwd}"], ["{session}", "{cwd}"]],
    };
    const success = queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      configWithScopes
    );

    expect(success).toBe(true);
    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries[0]?.observation_scopes).toEqual([
      ["cwd:/home/user/project"],
      [`session:${TEST_SESSION_ID}`, "cwd:/home/user/project"],
    ]);
  });

  it("expands {cwd} placeholder during flushAutoQueue", async () => {
    enqueueAutoMessage(TEST_SESSION_ID, {
      entry: { message: { role: "user", content: "Hello" } },
      store_method: "auto",
    });

    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["{cwd}"], ["user:alice"]],
    };

    const mockWrapper = createMockWrapper();
    await flushAutoQueue(
      TEST_SESSION_ID,
      "Test Session",
      "2024-01-01T00:00:00Z",
      "/home/user/project",
      undefined,
      configWithScopes,
      mockWrapper as unknown as HindsightClientWrapper
    );

    expect(mockWrapper.retainCalls).toHaveLength(1);
    const retainCall = mockWrapper.retainCalls[0] as { observationScopes?: unknown };
    expect(retainCall.observationScopes).toEqual([["cwd:/home/user/project"], ["user:alice"]]);
  });
});
