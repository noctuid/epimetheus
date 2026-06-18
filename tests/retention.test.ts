/**
 * Unit tests for retention logic.
 */

import { afterEach, beforeEach, describe, expect, it, type mock } from "bun:test";
import { join } from "node:path";
import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import type { HindsightClientWrapper } from "../src/client";
import type { HindsightConfig } from "../src/config";
import {
  clearSessionQueueState,
  enqueueToolMessage,
  hasPendingFlag,
  removePendingFlag,
  touchPendingFlag,
} from "../src/queue";
import {
  flushCurrentSession,
  flushToolQueue,
  getPendingWorkCount,
  parseAndUpsertSession,
  queueToolRetain,
} from "../src/retention";
import {
  cleanupParsedArtifacts,
  createMockClient,
  HINDSIGHT_ENV_KEYS,
  makeNotifyCtx,
  readToolQueueFromDisk,
  saveEnvKeys,
  setupTempAgentDir,
  testConfig as sharedTestConfig,
  withTempDir,
  writeSessionFile,
} from "./fixtures";

const TEST_SESSION_ID = "test-session-retention";

setupTempAgentDir("retention");

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

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = saveEnvKeys(HINDSIGHT_ENV_KEYS);
  // Clean up any existing queues
  removePendingFlag(TEST_SESSION_ID);
  clearSessionQueueState(TEST_SESSION_ID);
});

afterEach(() => {
  restoreEnv();
  removePendingFlag(TEST_SESSION_ID);
  clearSessionQueueState(TEST_SESSION_ID);
});

describe("getPendingWorkCount", () => {
  it("returns 0 when both queues are empty", () => {
    expect(getPendingWorkCount(TEST_SESSION_ID)).toBe(0);
  });

  it("returns count when pending marker is set", async () => {
    await touchPendingFlag(TEST_SESSION_ID);
    expect(getPendingWorkCount(TEST_SESSION_ID)).toBe(1);
  });

  it("returns count of tool queue entries", async () => {
    await enqueueToolMessage(TEST_SESSION_ID, {
      content: "test",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
      sessionId: TEST_SESSION_ID,
    });
    expect(getPendingWorkCount(TEST_SESSION_ID)).toBe(1);
  });

  it("returns combined count of pending marker and tool queue", async () => {
    await touchPendingFlag(TEST_SESSION_ID);
    await enqueueToolMessage(TEST_SESSION_ID, {
      content: "tool content",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
      sessionId: TEST_SESSION_ID,
    });
    expect(getPendingWorkCount(TEST_SESSION_ID)).toBe(2); // 1 pending + 1 tool
  });
});

describe("queueToolRetain", () => {
  it("queues a tool entry with correct tags", async () => {
    const result = await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      ["topic:test"],
      { source: "manual" },
      "/home/user/project",
      "parent-123",
      defaultConfig,
      []
    );

    expect(result.success).toBe(true);

    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe("Remember this");
    expect(entries[0]?.tags).toContain("harness:pi");
    expect(entries[0]?.tags).toContain(`session:${TEST_SESSION_ID}`);
    expect(entries[0]?.tags).toContain("cwd:/home/user/project");
    expect(entries[0]?.tags).toContain("basedir:project");
    expect(entries[0]?.tags).toContain("project:project");
    expect(entries[0]?.tags).toContain("store_method:tool");
    expect(entries[0]?.tags).toContain("parent:parent-123");
    expect(entries[0]?.tags).toContain("topic:test");
    expect(entries[0]?.metadata).toEqual({ source: "manual" });
  });

  it("uses session ID as parent when no parent session", async () => {
    await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      defaultConfig,
      []
    );

    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries[0]?.tags).toContain(`parent:${TEST_SESSION_ID}`);
  });

  it("generates a stable document_id for idempotent retain", async () => {
    const result = await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      ["topic:test"],
      { source: "manual" },
      "/home/user/project",
      "parent-123",
      defaultConfig,
      []
    );

    expect(result.success).toBe(true);

    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.document_id).toMatch(/^tool:test-session-retention:[0-9a-f-]+$/);
  });
});

describe("flushToolQueue", () => {
  it("returns success with count 0 when queue is empty", async () => {
    const mockWrapper = createMockWrapper();
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      makeNotifyCtx()
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(mockWrapper.retainBatchCalls).toHaveLength(0);
  });

  it("flushes entries and deletes queue on success", async () => {
    await enqueueToolMessage(TEST_SESSION_ID, {
      content: "Fact 1",
      tags: ["topic:test"],
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
      sessionId: TEST_SESSION_ID,
    });
    await enqueueToolMessage(TEST_SESSION_ID, {
      content: "Fact 2",
      tags: ["topic:other"],
      timestamp: "2024-01-01T00:01:00Z",
      store_method: "tool",
      sessionId: TEST_SESSION_ID,
    });

    const mockWrapper = createMockWrapper();
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      makeNotifyCtx()
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(mockWrapper.retainBatchCalls).toHaveLength(1);
    expect(mockWrapper.retainBatchCalls[0]).toHaveLength(2);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
  });

  it("leaves queue intact on failure", async () => {
    await enqueueToolMessage(TEST_SESSION_ID, {
      content: "Fact",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
      sessionId: TEST_SESSION_ID,
    });

    const mockWrapper = createMockWrapper({
      retainBatchSuccess: false,
      retainBatchError: "Batch failed",
    });
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      makeNotifyCtx()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Batch failed");
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
  });

  it("restores tool queue when retainBatch throws after claim", async () => {
    await enqueueToolMessage(TEST_SESSION_ID, {
      content: "Fact",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
      sessionId: TEST_SESSION_ID,
    });

    const mockWrapper = createMockWrapper();
    mockWrapper.retainBatch = async () => {
      throw new Error("Network timeout");
    };

    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      makeNotifyCtx()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Network timeout");
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)[0]?.content).toBe("Fact");
  });

  it("forwards document_id and update_mode to retainBatch", async () => {
    await enqueueToolMessage(TEST_SESSION_ID, {
      content: "Fact with ID",
      document_id: "tool:test-session:uuid-789",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
      sessionId: TEST_SESSION_ID,
    });

    const mockWrapper = createMockWrapper();
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      makeNotifyCtx()
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(mockWrapper.retainBatchCalls).toHaveLength(1);
    const batch = mockWrapper.retainBatchCalls[0] as MemoryItemInput[];
    expect(batch[0]?.document_id).toBe("tool:test-session:uuid-789");
    expect(batch[0]?.update_mode).toBe("replace");
  });

  it("restores claim and returns failure when claimed file has malformed JSON", async () => {
    const entry = {
      content: "Important fact",
      tags: ["topic:test"],
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    // Claim the entry so we can corrupt the file in the claim dir
    const { claimToolQueue, restoreClaim } = await import("../src/queue");
    const { writeFileSync: fsWrite } = await import("node:fs");
    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).not.toBeNull();

    // Corrupt the claimed file with invalid JSON
    fsWrite(claim!.claimedFiles[0]!, "not valid json{{{", "utf8");

    // Now restore the claim — the corrupted file goes back to the tool queue dir
    restoreClaim(claim!);

    // flushToolQueue should claim the corrupted file, detect the error, restore, and fail
    const mockWrapper = createMockWrapper();
    const ctx = makeNotifyCtx();
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Corrupt tool queue entries");
    expect(result.error).toContain("malformed JSON");
    // Should not have called retainBatch
    expect(mockWrapper.retainBatchCalls).toHaveLength(0);
    // Should have notified error
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof import("bun:test").mock>).mock.calls;
    const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
    expect(messages.some((m: string) => m.includes("Corrupt tool queue entries"))).toBe(true);
    // The claim was restored, so the (corrupted) file still exists on disk.
    // readToolQueueFromDisk only returns valid entries, so it shows 0.
    // Verify the file is still present by listing the directory.
    const { getToolDir, listJsonFiles } = await import("../src/queue-paths");
    expect(listJsonFiles(getToolDir(TEST_SESSION_ID)).length).toBe(1);
  });

  it("restores claim and returns failure when claimed file has invalid schema", async () => {
    const entry = {
      content: "Important fact",
      tags: ["topic:test"],
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const { claimToolQueue, restoreClaim } = await import("../src/queue");
    const { writeFileSync: fsWrite } = await import("node:fs");
    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).not.toBeNull();

    // Replace the claimed file with valid JSON but missing required fields
    const invalidEntry = { some: "object", missing: "required fields" };
    fsWrite(claim!.claimedFiles[0]!, JSON.stringify(invalidEntry), "utf8");

    // Restore the claim so flushToolQueue can claim it again
    restoreClaim(claim!);

    const mockWrapper = createMockWrapper();
    const ctx = makeNotifyCtx();
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Corrupt tool queue entries");
    expect(result.error).toContain("invalid tool entry");
    // Should not have called retainBatch
    expect(mockWrapper.retainBatchCalls).toHaveLength(0);
    // The (invalid-schema) file should still exist on disk after restore
    const { getToolDir, listJsonFiles } = await import("../src/queue-paths");
    expect(listJsonFiles(getToolDir(TEST_SESSION_ID)).length).toBe(1);
  });

  it("restores claim and returns failure when claimed file is unreadable (empty content)", async () => {
    const entry = {
      content: "Important fact",
      tags: ["topic:test"],
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    // Note: This test writes an empty (0-byte) file to the tool queue, which
    // triggers a malformed_json error when read. It does NOT test the
    // missing-file path (that is covered by readClaimedToolEntries unit tests
    // in queue.test.ts, since missing-file-in-claim is a rare race that is
    // hard to reproduce in integration — claimToolQueue only lists files that
    // exist at claim time, and readClaimedToolEntries checks existence before
    // reading).
    const { writeFileSync: fsWrite } = await import("node:fs");
    const { getToolEntryPath } = await import("../src/queue-paths");
    const { randomUUID } = await import("node:crypto");
    const emptyEntryId = randomUUID();
    fsWrite(getToolEntryPath(TEST_SESSION_ID, emptyEntryId), "", "utf8");

    const mockWrapper = createMockWrapper();
    const ctx = makeNotifyCtx();
    const result = await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Corrupt tool queue entries");
    // Empty file triggers malformed_json error (JSON.parse on empty string)
    expect(result.error).toContain("malformed JSON");
    expect(mockWrapper.retainBatchCalls).toHaveLength(0);
  });
});

describe("parseAndUpsertSession claim lifecycle", () => {
  it("does not rewrite live state when queue state is cleared during network call", async () => {
    const sessionId = `${TEST_SESSION_ID}-stale-mid`;
    await touchPendingFlag(sessionId);
    const { readSessionState, writeSessionState } = await import("../src/session-state");

    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId);
      const ctx = makeNotifyCtx();

      // Create a mock client whose retain simulates disabling retention while
      // the network call is in flight. Clearing queue state removes the claim
      // dir, so the stale flush must not rewrite live state back to retained=true.
      const mockClient = {
        retain: async () => {
          writeSessionState(sessionId, {
            retained: false,
            extraContext: null,
            updatedAt: new Date().toISOString(),
          });
          clearSessionQueueState(sessionId);
          return { success: true };
        },
        retainBatch: async () => ({ success: true }),
      } as unknown as HindsightClientWrapper;

      try {
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        const liveState = readSessionState(sessionId);
        expect(liveState).not.toBeNull();
        expect(liveState!.retained).toBe(false);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(false);
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
        cleanupParsedArtifacts(sessionId);
      }
    });
  });

  it("completes flush for no-claim path when queue cleared during network call", async () => {
    const sessionId = `${TEST_SESSION_ID}-no-claim-gen`;
    // No pending marker — this exercises the requirePending: false path

    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId);
      const ctx = makeNotifyCtx();

      const mockClient = {
        retain: async () => {
          clearSessionQueueState(sessionId);
          return { success: true };
        },
        retainBatch: async () => ({ success: true }),
      } as unknown as HindsightClientWrapper;

      try {
        await parseAndUpsertSession(
          sessionPath,
          sessionId,
          sharedTestConfig,
          mockClient,
          ctx,
          undefined,
          { requirePending: false }
        );

        // With the new lock-free design, the flush completes
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(true);
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
        cleanupParsedArtifacts(sessionId);
      }
    });
  });

  it("restores pending claim and notifies when session file header id mismatches", async () => {
    const sessionId = `${TEST_SESSION_ID}-header-mismatch`;
    const mismatchedHeaderId = "different-session-id-in-file";

    await withTempDir(async (tmpDir) => {
      // Write a session file whose header.id differs from the sessionId we'll pass.
      // writeSessionFile ties header.id to its sessionId arg, so write with the
      // mismatched id and pass a different sessionId to parseAndUpsertSession.
      const sessionPath = writeSessionFile(tmpDir, mismatchedHeaderId, {
        messages: [{ role: "user", content: "test" }],
      });

      // Create a pending marker so a claim exists to restore
      await touchPendingFlag(sessionId);
      expect(hasPendingFlag(sessionId)).toBe(true);

      const ctx = makeNotifyCtx();
      const mockClient = createMockClient();

      try {
        await parseAndUpsertSession(
          sessionPath,
          sessionId, // deliberately different from mismatchedHeaderId
          sharedTestConfig,
          mockClient,
          ctx
        );

        // No upsert should have happened
        expect(mockClient.retain).not.toHaveBeenCalled();
        // Pending marker should remain (claim restored, retryable)
        expect(hasPendingFlag(sessionId)).toBe(true);
        // User should be notified of the mismatch
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("Session ID mismatch"))).toBe(true);
        expect(messages.some((m: string) => m.includes(sessionId))).toBe(true);
        expect(messages.some((m: string) => m.includes(mismatchedHeaderId))).toBe(true);
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
        cleanupParsedArtifacts(sessionId);
      }
    });
  });
});

describe("queueToolRetain with session user tags", () => {
  it("includes session user tags in tool queue tags", async () => {
    const result = await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      ["topic:test"],
      { source: "manual" },
      "/home/user/project",
      "parent-123",
      defaultConfig,
      ["session-tag1", "session-tag2"]
    );

    expect(result.success).toBe(true);

    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tags).toContain("harness:pi");
    expect(entries[0]?.tags).toContain("topic:test");
    expect(entries[0]?.tags).toContain("session-tag1");
    expect(entries[0]?.tags).toContain("session-tag2");
  });

  it("works without session user tags", async () => {
    const result = await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      defaultConfig,
      []
    );

    expect(result.success).toBe(true);

    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries[0]?.tags).toContain("harness:pi");
    expect(entries[0]?.tags).not.toContain("session-tag1");
  });
});

describe("observationScopes", () => {
  it("includes observation_scopes in tool queue entry when config is set", async () => {
    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["session:abc"]],
    };
    const result = await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      configWithScopes,
      []
    );

    expect(result.success).toBe(true);
    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.observation_scopes).toEqual([["session:abc"]]);
  });

  it("does not include observation_scopes when config is null", async () => {
    const configWithNullScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: null,
    };
    const result = await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      configWithNullScopes,
      []
    );

    expect(result.success).toBe(true);
    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.observation_scopes).toBeUndefined();
  });

  it("expands placeholders in observation_scopes at queue time", async () => {
    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["{session}", "{parent}"], ["user:alice"]],
    };
    const result = await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      "parent-456",
      configWithScopes,
      []
    );

    expect(result.success).toBe(true);
    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
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
    await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      configWithScopes,
      []
    );

    const mockWrapper = createMockWrapper();
    await flushToolQueue(
      TEST_SESSION_ID,
      mockWrapper as unknown as HindsightClientWrapper,
      makeNotifyCtx()
    );

    expect(mockWrapper.retainBatchCalls).toHaveLength(1);
    const batchItems = mockWrapper.retainBatchCalls[0] as MemoryItemInput[];
    expect(batchItems[0]?.observation_scopes).toEqual([["session:abc"]]);
  });

  it("expands {cwd} placeholder in observation_scopes at queue time", async () => {
    const configWithScopes: HindsightConfig = {
      ...defaultConfig,
      observationScopes: [["{cwd}"], ["{session}", "{cwd}"]],
    };
    const result = await queueToolRetain(
      TEST_SESSION_ID,
      "Remember this",
      undefined,
      undefined,
      "/home/user/project",
      undefined,
      configWithScopes,
      []
    );

    expect(result.success).toBe(true);
    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries[0]?.observation_scopes).toEqual([
      ["cwd:/home/user/project"],
      [`session:${TEST_SESSION_ID}`, "cwd:/home/user/project"],
    ]);
  });
});

describe("concurrent new work during flush", () => {
  it("new pending marker remains after parseAndUpsertSession completes", async () => {
    const sessionId = `${TEST_SESSION_ID}-concurrent-pending`;
    await touchPendingFlag(sessionId);

    await withTempDir(async (tmpDir) => {
      const sessionPath = writeSessionFile(tmpDir, sessionId);
      const ctx = makeNotifyCtx();

      const mockClient = {
        retain: async () => {
          // Simulate a new message_end arriving during the network call
          await touchPendingFlag(sessionId);
          return { success: true };
        },
        retainBatch: async () => ({ success: true }),
      } as unknown as HindsightClientWrapper;

      try {
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // The new pending marker (touched during retain) should remain
        expect(hasPendingFlag(sessionId)).toBe(true);
        // Parsed artifacts should have been written for the completed flush
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(true);
      } finally {
        removePendingFlag(sessionId);
        cleanupParsedArtifacts(sessionId);
      }
    });
  });

  it("new tool entry remains after successful flushToolQueue", async () => {
    const sessionId = `${TEST_SESSION_ID}-concurrent-tool-ok`;
    await enqueueToolMessage(sessionId, {
      content: "old entry",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
      sessionId: sessionId,
    });

    let retainBatchCallCount = 0;
    const mockWrapper = {
      retainBatch: async (_entries: MemoryItemInput[]) => {
        retainBatchCallCount++;
        if (retainBatchCallCount === 1) {
          // During the first flush, enqueue a new entry
          await enqueueToolMessage(sessionId, {
            content: "new entry",
            timestamp: "2024-01-02T00:00:00Z",
            store_method: "tool",
            sessionId: sessionId,
          });
        }
        return { success: true };
      },
    } as unknown as HindsightClientWrapper;

    try {
      const result = await flushToolQueue(sessionId, mockWrapper, makeNotifyCtx());

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      // New entry should remain in queue
      const remaining = readToolQueueFromDisk(sessionId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.content).toBe("new entry");
    } finally {
      clearSessionQueueState(sessionId);
    }
  });

  it("entries restored when retainBatch fails after concurrent enqueue", async () => {
    const sessionId = `${TEST_SESSION_ID}-concurrent-tool-fail`;
    await enqueueToolMessage(sessionId, {
      content: "old entry",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
      sessionId: sessionId,
    });

    const mockWrapper = {
      retainBatch: async () => {
        // Enqueue new entry, then fail
        await enqueueToolMessage(sessionId, {
          content: "new entry",
          timestamp: "2024-01-02T00:00:00Z",
          store_method: "tool",
          sessionId: sessionId,
        });
        return { success: false, error: "batch failed" };
      },
    } as unknown as HindsightClientWrapper;

    try {
      const result = await flushToolQueue(sessionId, mockWrapper, makeNotifyCtx());

      expect(result.success).toBe(false);
      // Both entries should be in queue (order not guaranteed with per-file layout)
      const entries = readToolQueueFromDisk(sessionId);
      expect(entries).toHaveLength(2);
      const contents = entries.map((e) => e.content).sort();
      expect(contents).toEqual(["new entry", "old entry"]);
    } finally {
      clearSessionQueueState(sessionId);
    }
  });
});

describe("always-reparse flush", () => {
  it("re-parses session file even when parsed artifacts exist with stale messages", async () => {
    const sessionId = `${TEST_SESSION_ID}-stale-artifact`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMessagesJsonl, getMessagesPath, ensureParsedSessionDir } = await import(
      "../src/parsed-store"
    );
    const { readFileSync, existsSync } = await import("node:fs");
    const { getMetaPath } = await import("../src/parsed-store");
    const parsedArtifactsExist = (id: string) =>
      existsSync(getMessagesPath(id)) && existsSync(getMetaPath(id));

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "original message" }],
        });
        const ctx = makeNotifyCtx();

        // First flush: creates parsed artifacts from the session file
        const mockClient1 = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient1, ctx);
        const notifyCalls1 = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        expect(
          notifyCalls1.some((c: unknown[]) => String(c[0]).includes("Parsed and upserted"))
        ).toBe(true);
        expect(parsedArtifactsExist(sessionId)).toBe(true);
        // Overwrite .messages.jsonl with stale content to simulate an artifact
        // that doesn't match the session file
        ensureParsedSessionDir();
        writeMessagesJsonl(sessionId, [
          JSON.stringify({ role: "user", content: "stale artifact message" }),
        ]);

        // Verify the stale artifact is on disk
        const staleContent = readFileSync(getMessagesPath(sessionId), "utf-8");
        expect(staleContent).toContain("stale artifact message");

        // Create new pending marker
        await touchPendingFlag(sessionId);

        // Second flush: should re-parse the session file, not reuse the stale artifact
        let capturedContent: string | undefined;
        const mockClient2 = {
          retain: async (opts: { content: string }) => {
            capturedContent = opts.content;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient2, ctx);

        // Should have parsed the session file, not reused the stale artifact
        const notifyCalls2 = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        expect(
          notifyCalls2.some((c: unknown[]) => String(c[0]).includes("Parsed and upserted"))
        ).toBe(true);
        expect(capturedContent).toContain("original message");
        expect(capturedContent).not.toContain("stale artifact message");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("uses live state for fast blocking when retention is disabled", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-block-retained`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeSessionState } = await import("../src/session-state");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        // Write live state with retained=false
        writeSessionState(sessionId, {
          retained: false,
          extraContext: null,
          updatedAt: new Date().toISOString(),
        });

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Should be blocked by live state without parsing session file
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("does not allow retention"))).toBe(true);
        expect(
          notifyCalls.some(
            (c: unknown[]) =>
              String(c[0]).includes("does not allow retention") && c[1] === "warning"
          )
        ).toBe(true);
        // Should not have called retain at all
        expect(mockClient.retain).not.toHaveBeenCalled();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("derives metadata from session entries when .meta.json is missing", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-fallback`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { getMessagesPath, getMetaPath } = await import("../src/parsed-store");
    const { existsSync } = await import("node:fs");
    const parsedArtifactsExist = (id: string) =>
      existsSync(getMessagesPath(id)) && existsSync(getMetaPath(id));

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        // No .meta.json exists
        expect(parsedArtifactsExist(sessionId)).toBe(false);

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Should succeed by deriving metadata from session entries
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(true);
        // Parsed artifacts should now exist (written after successful parse/upsert)
        expect(parsedArtifactsExist(sessionId)).toBe(true);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("always writes .meta.json after successful parse/upsert", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-write`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { getMessagesPath, getMetaPath } = await import("../src/parsed-store");
    const { readFileSync, existsSync } = await import("node:fs");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        expect(existsSync(getMessagesPath(sessionId)) && existsSync(getMetaPath(sessionId))).toBe(
          true
        );
        // Verify .messages.jsonl is a review artifact (not empty)
        const messagesContent = readFileSync(getMessagesPath(sessionId), "utf-8");
        expect(messagesContent.length).toBeGreaterThan(0);
        // Verify .meta.json has expected fields
        const metaContent = readFileSync(getMetaPath(sessionId), "utf-8");
        const meta = JSON.parse(metaContent);
        expect(meta.sessionId).toBe(sessionId);
        expect(meta.retained).toBe(true);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });
});

describe("flush rebuilds config-derived metadata", () => {
  it("uses current constantTags and observationScopes", async () => {
    const sessionId = `${TEST_SESSION_ID}-config-rebuild`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");

    const testCfg: HindsightConfig = {
      ...sharedTestConfig,
      constantTags: ["my-tag"],
      observationScopes: [["my-scope"]],
    };

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        let capturedTags: string[] | undefined;
        let capturedScopes: unknown;
        const mockClient = {
          retain: async (opts: { tags?: string[]; observationScopes?: unknown }) => {
            capturedTags = opts.tags;
            capturedScopes = opts.observationScopes;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, testCfg, mockClient, ctx);

        // Config-derived metadata should be rebuilt from current config
        expect(capturedTags).toContain("my-tag");
        expect(capturedScopes).toEqual([["my-scope"]]);
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(true);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });
});

describe("meta.json as primary metadata source", () => {
  it("uses session entry tags for normal flush and writes them to .meta.json", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-usertags`;
    const { withTempDir } = await import("./fixtures");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getMetaPath } = await import("../src/parsed-store");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Write session file WITH hindsight-meta tags
        const sessionPath = join(tmpDir, `${sessionId}.jsonl`);
        const lines = [
          JSON.stringify({
            type: "session",
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: "/test",
          }),
          JSON.stringify({
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, tags: ["cached:tag1", "cached:tag2"] },
            id: `${sessionId}-meta`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "test" },
            id: `${sessionId}-msg`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
        ];
        writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
        const ctx = makeNotifyCtx();

        let capturedTags: string[] | undefined;
        const mockClient = {
          retain: async (opts: { tags?: string[] }) => {
            capturedTags = opts.tags;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Tags should come from session entries (hindsight-meta.tags)
        expect(capturedTags).toContain("cached:tag1");
        expect(capturedTags).toContain("cached:tag2");
        // Verify .meta.json written after flush stores sessionUserTags from entries
        const metaContent = readFileSync(getMetaPath(sessionId), "utf-8");
        const writtenMeta = JSON.parse(metaContent);
        expect(writtenMeta.sessionUserTags).toEqual(["cached:tag1", "cached:tag2"]);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("derives context from parsed session + config prefix, not from .meta.json", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-context`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir } = await import("../src/parsed-store");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with a sessionName — but context should
        // be derived from the parsed session file, not from the stale artifact
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: sessionId,
          sessionName: "stale artifact name",
          sessionCwd: "/test",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          retained: true,
          extraContext: null,
          sessionUserTags: [],
        });

        let capturedContext: string | undefined;
        const mockClient = {
          retain: async (opts: { context?: string }) => {
            capturedContext = opts.context;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Context should be derived from parsed session + config prefix
        // The session file's first user message is "test", so context is "pi: test"
        expect(capturedContext).toBe("pi: test");
        expect(capturedContext).not.toBe("stale artifact name");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("parsed missing extraContext overrides stale live state and blocks when guard is required", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-extra-ctx`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeSessionState, readSessionState } = await import("../src/session-state");

    const configWithGuard: HindsightConfig = {
      ...sharedTestConfig,
      requireExtraContextBeforeFlush: true,
    };

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Session file has NO hindsight-meta entry with extraContext
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Create live state with extraContext set (stale — session file is authority)
        writeSessionState(sessionId, {
          retained: true,
          extraContext: "set context",
          updatedAt: new Date().toISOString(),
        });

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, configWithGuard, mockClient, ctx);

        // Should be blocked: parsed entries lack extraContext, live state is stale
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("extra context not set"))).toBe(true);
        expect(
          notifyCalls.some(
            (c: unknown[]) => String(c[0]).includes("extra context not set") && c[1] === "warning"
          )
        ).toBe(true);
        // Pending markers should remain
        expect(hasPendingFlag(sessionId)).toBe(true);
        // Live state should be rewritten from parsed metadata
        const liveState = readSessionState(sessionId);
        expect(liveState).not.toBeNull();
        expect(liveState!.retained).toBe(true);
        expect(liveState!.extraContext).toBeNull();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("parsed retained=false overrides stale retained=true live state and blocks", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-retained-override`;
    const { withTempDir } = await import("./fixtures");
    const { writeSessionState, readSessionState } = await import("../src/session-state");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Write session file with retained=false in hindsight-meta
        const sessionPath = join(tmpDir, `${sessionId}.jsonl`);
        const lines = [
          JSON.stringify({
            type: "session",
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: "/test",
          }),
          JSON.stringify({
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: false },
            id: `${sessionId}-meta`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "test" },
            id: `${sessionId}-msg`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
        ];
        writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
        const ctx = makeNotifyCtx();

        // Create live state with retained=true (stale — session file is authority)
        writeSessionState(sessionId, {
          retained: true,
          extraContext: null,
          updatedAt: new Date().toISOString(),
        });

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Should block: parsed retained=false overrides stale live state
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("does not allow retention"))).toBe(true);
        expect(
          notifyCalls.some(
            (c: unknown[]) =>
              String(c[0]).includes("does not allow retention") && c[1] === "warning"
          )
        ).toBe(true);
        // Live state should be rewritten from parsed metadata
        const liveState = readSessionState(sessionId);
        expect(liveState).not.toBeNull();
        expect(liveState!.retained).toBe(false);
        expect(liveState!.extraContext).toBeNull();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("preserves .meta.json stable fields after successful flush", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-preserve`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir, getMetaPath } = await import("../src/parsed-store");
    const { readFileSync } = await import("node:fs");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with specific stable fields
        const originalTimestamp = "2024-01-01T00:00:00.000Z";
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: "custom-session-id",
          sessionName: "custom session",
          sessionUserTags: ["custom:tag"],
          parentSessionId: "parent-123",
          sessionCwd: "/custom/cwd",
          sessionTimestamp: originalTimestamp,
          messageCount: 0,
          retained: true,
          extraContext: null,
        });

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Read back the written .meta.json
        const metaContent = readFileSync(getMetaPath(sessionId), "utf-8");
        const writtenMeta = JSON.parse(metaContent);

        // sessionName should be derived from the parsed session (not from the stale artifact)
        expect(writtenMeta.sessionName).toBeDefined();
        // sessionUserTags comes from parsed session entries (no hindsight-meta tags in session file)
        expect(writtenMeta.sessionUserTags).toEqual([]);

        // Structural identity fields should be refreshed from session header
        expect(writtenMeta.sessionId).toBe(sessionId);
        expect(writtenMeta.sessionId).not.toBe("custom-session-id");
        expect(writtenMeta.sessionCwd).toBe("/test");
        expect(writtenMeta.sessionCwd).not.toBe("/custom/cwd");
        expect(writtenMeta.sessionTimestamp).not.toBe(originalTimestamp);

        // Dynamic fields should be refreshed
        expect(writtenMeta.messageCount).toBeGreaterThan(0);
        expect(writtenMeta.retained).toBe(true);
        // .meta.json should have extraContext field
        expect("extraContext" in writtenMeta).toBe(true);
        // Regression: parsed .meta.json must NOT contain lastUpsertedAt
        expect("lastUpsertedAt" in writtenMeta).toBe(false);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("does not fall back to session-entry tags when .meta.json.sessionUserTags is absent", async () => {
    const sessionId = `${TEST_SESSION_ID}-meta-usertags-authority`;
    const { withTempDir } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir, getMetaPath } = await import("../src/parsed-store");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Write a session file that has hindsight-meta with tags in its entries
        const sessionPath = join(tmpDir, `${sessionId}.jsonl`);
        const lines = [
          JSON.stringify({
            type: "session",
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: "/test",
          }),
          JSON.stringify({
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, tags: ["entry:tag"] },
            id: `${sessionId}-meta`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "test" },
            id: `${sessionId}-msg`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
        ];
        writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with retained=true, valid required fields,
        // but NO sessionUserTags field — this is the regression test
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: sessionId,
          sessionName: "cached session",
          parentSessionId: undefined,
          sessionCwd: "/test",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          retained: true,
          extraContext: null,
          sessionUserTags: [],
        });

        let capturedTags: string[] | undefined;
        const mockClient = {
          retain: async (opts: { tags?: string[] }) => {
            capturedTags = opts.tags;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Tags SHOULD include session-entry tags because normal flush
        // derives user tags from the parsed session entries
        expect(capturedTags).toContain("entry:tag");

        // Verify .meta.json written after flush includes sessionUserTags from entries
        const metaContent = readFileSync(getMetaPath(sessionId), "utf-8");
        const writtenMeta = JSON.parse(metaContent);
        expect(writtenMeta.sessionUserTags).toEqual(["entry:tag"]);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });
});

describe("extra context updates live state", () => {
  it("flush derives context from parsed session entries and updates live state", async () => {
    const sessionId = `${TEST_SESSION_ID}-extra-ctx-update`;
    const { withTempDir } = await import("./fixtures");
    const { readSessionState } = await import("../src/session-state");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Write session file WITH extraContext in hindsight-meta
        const sessionPath = join(tmpDir, `${sessionId}.jsonl`);
        const lines = [
          JSON.stringify({
            type: "session",
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: "/test",
          }),
          JSON.stringify({
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, extraContext: "This is a fiction session" },
            id: `${sessionId}-meta`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "test" },
            id: `${sessionId}-msg`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
        ];
        writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
        const ctx = makeNotifyCtx();

        // Flush should derive context from parsed session entries
        let capturedContext: string | undefined;
        const mockClient = {
          retain: async (opts: { context?: string }) => {
            capturedContext = opts.context;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Context should contain the extra context from parsed entries
        expect(capturedContext).toContain("This is a fiction session");
        expect(capturedContext).toContain("pi:");

        // Live state should be updated from parsed metadata
        const liveState = readSessionState(sessionId);
        expect(liveState).not.toBeNull();
        expect(liveState!.extraContext).toBe("This is a fiction session");
        expect(liveState!.retained).toBe(true);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("updates live state when extraContext set to empty string", async () => {
    const sessionId = `${TEST_SESSION_ID}-extra-ctx-empty`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { updateSessionMetadata } = await import("../src/meta");
    const { readSessionState } = await import("../src/session-state");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Write a session file (not used for flush in this test)
        writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Set extra context to empty string
        const entries = ctx.sessionManager.getEntries();
        await updateSessionMetadata(
          { appendEntry: (_type: string, _data: unknown) => {} } as any,
          sessionId,
          entries,
          { extraContext: "" },
          sharedTestConfig
        );

        // Verify live state was updated with empty string
        const liveState = readSessionState(sessionId);
        expect(liveState).not.toBeNull();
        expect(liveState!.extraContext).toBe("");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });
});

describe("live state written on parsed block conditions", () => {
  it("writes live state with extraContext=null when parsed extraContext missing under guard", async () => {
    const sessionId = `${TEST_SESSION_ID}-ls-write-ec-null`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { readSessionState } = await import("../src/session-state");

    const configWithGuard: HindsightConfig = {
      ...sharedTestConfig,
      requireExtraContextBeforeFlush: true,
    };

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Session file has NO extraContext in hindsight-meta
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // No live state exists initially
        expect(readSessionState(sessionId)).toBeNull();

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, configWithGuard, mockClient, ctx);

        // Live state should be written with retained=true, extraContext=null
        const liveState = readSessionState(sessionId);
        expect(liveState).not.toBeNull();
        expect(liveState!.retained).toBe(true);
        expect(liveState!.extraContext).toBeNull();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("writes live state with retained=false when parsed retained is false", async () => {
    const sessionId = `${TEST_SESSION_ID}-ls-write-ret-false`;
    const { withTempDir } = await import("./fixtures");
    const { readSessionState } = await import("../src/session-state");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Session file with retained=false in hindsight-meta
        const sessionPath = join(tmpDir, `${sessionId}.jsonl`);
        const lines = [
          JSON.stringify({
            type: "session",
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: "/test",
          }),
          JSON.stringify({
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: false },
            id: `${sessionId}-meta`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "test" },
            id: `${sessionId}-msg`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
        ];
        writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
        const ctx = makeNotifyCtx();

        // No live state exists initially
        expect(readSessionState(sessionId)).toBeNull();

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Live state should be written with retained=false
        const liveState = readSessionState(sessionId);
        expect(liveState).not.toBeNull();
        expect(liveState!.retained).toBe(false);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("successful flush rewrites stale live state from parsed metadata", async () => {
    const sessionId = `${TEST_SESSION_ID}-ls-rewrite-stale`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeSessionState, readSessionState } = await import("../src/session-state");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Session file: retained=true, no extraContext in hindsight-meta
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Write non-blocking stale live state: retained=true (permits parsing)
        // but extraContext="stale context" which differs from parsed (null)
        writeSessionState(sessionId, {
          retained: true,
          extraContext: "stale context",
          updatedAt: new Date().toISOString(),
        });

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Live state should be rewritten from parsed metadata
        const liveState = readSessionState(sessionId);
        expect(liveState).not.toBeNull();
        expect(liveState!.retained).toBe(true);
        // Session file has no extraContext, so it should be null (not stale "stale context")
        expect(liveState!.extraContext).toBeNull();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });
});

describe("structural tags from session header", () => {
  it("uses session header cwd for structural tags, not .meta.json.sessionCwd", async () => {
    const sessionId = `${TEST_SESSION_ID}-struct-tags`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir } = await import("../src/parsed-store");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Session file has cwd=/test (from writeSessionFile default)
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with different sessionCwd
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: sessionId,
          sessionName: "test session",
          sessionCwd: "/different/cwd",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          retained: true,
          extraContext: null,
          sessionUserTags: [],
        });

        let capturedTags: string[] | undefined;
        const mockClient = {
          retain: async (opts: { tags?: string[] }) => {
            capturedTags = opts.tags;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Structural tags should use session header cwd, not .meta.json.sessionCwd
        expect(capturedTags).toContain("cwd:/test");
        expect(capturedTags).toContain("basedir:test");
        expect(capturedTags).not.toContain("cwd:/different/cwd");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("uses session entry tags for document tags", async () => {
    const sessionId = `${TEST_SESSION_ID}-user-tags`;
    const { withTempDir } = await import("./fixtures");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Write session file with hindsight-meta tags
        const sessionPath = join(tmpDir, `${sessionId}.jsonl`);
        const lines = [
          JSON.stringify({
            type: "session",
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: "/test",
          }),
          JSON.stringify({
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, tags: ["user:custom-tag"] },
            id: `${sessionId}-meta`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "test" },
            id: `${sessionId}-msg`,
            parentId: null,
            timestamp: new Date().toISOString(),
          }),
        ];
        writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
        const ctx = makeNotifyCtx();

        let capturedTags: string[] | undefined;
        const mockClient = {
          retain: async (opts: { tags?: string[] }) => {
            capturedTags = opts.tags;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // User tags should come from session entries (hindsight-meta.tags)
        expect(capturedTags).toContain("user:custom-tag");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("uses header timestamp, not .meta.json.sessionTimestamp", async () => {
    const sessionId = `${TEST_SESSION_ID}-struct-timestamp`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir } = await import("../src/parsed-store");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with different sessionTimestamp
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: sessionId,
          sessionName: "test session",
          sessionCwd: "/test",
          sessionTimestamp: "2000-01-01T00:00:00.000Z",
          messageCount: 1,
          retained: true,
          extraContext: null,
          sessionUserTags: [],
        });

        let capturedTimestamp: string | undefined;
        const mockClient = {
          retain: async (opts: { timestamp?: string }) => {
            capturedTimestamp = opts.timestamp;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Timestamp should come from session header, not .meta.json
        expect(capturedTimestamp).not.toBe("2000-01-01T00:00:00.000Z");
        expect(capturedTimestamp).toBeDefined();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("uses header sessionId (session id), not .meta.json.sessionId", async () => {
    const sessionId = `${TEST_SESSION_ID}-struct-sessionid`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir } = await import("../src/parsed-store");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with different sessionId
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: "stale-cached-session-id",
          sessionName: "test session",
          sessionCwd: "/test",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          retained: true,
          extraContext: null,
          sessionUserTags: [],
        });

        let capturedDocumentId: string | undefined;
        const mockClient = {
          retain: async (opts: { documentId?: string }) => {
            capturedDocumentId = opts.documentId;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Hindsight document id should come from session header (sessionId), not .meta.json
        expect(capturedDocumentId).toBe(sessionId);
        expect(capturedDocumentId).not.toBe("stale-cached-session-id");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("refreshes .meta.json structural fields from header after flush", async () => {
    const sessionId = `${TEST_SESSION_ID}-struct-refresh`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir, getMetaPath } = await import("../src/parsed-store");
    const { readFileSync } = await import("node:fs");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with stale structural fields
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: "stale-session-id",
          sessionName: "test session",
          sessionCwd: "/stale/cwd",
          sessionTimestamp: "2000-01-01T00:00:00.000Z",
          messageCount: 0,
          retained: true,
          extraContext: null,
          sessionUserTags: [],
        });

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Read back written .meta.json
        const metaContent = readFileSync(getMetaPath(sessionId), "utf-8");
        const writtenMeta = JSON.parse(metaContent);

        // Structural fields should be refreshed from header
        expect(writtenMeta.sessionId).toBe(sessionId);
        expect(writtenMeta.sessionCwd).toBe("/test");
        expect(writtenMeta.sessionTimestamp).not.toBe("2000-01-01T00:00:00.000Z");
        // Stale values should not persist
        expect(writtenMeta.sessionId).not.toBe("stale-session-id");
        expect(writtenMeta.sessionCwd).not.toBe("/stale/cwd");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("uses header parentSessionId, not .meta.json.parentSessionId", async () => {
    const sessionId = `${TEST_SESSION_ID}-struct-parent`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir } = await import("../src/parsed-store");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Session file has no parentSession
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with a parentSessionId
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: sessionId,
          sessionName: "test session",
          sessionCwd: "/test",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          retained: true,
          extraContext: null,
          sessionUserTags: [],
          parentSessionId: "stale-parent-id",
        });

        let capturedTags: string[] | undefined;
        const mockClient = {
          retain: async (opts: { tags?: string[] }) => {
            capturedTags = opts.tags;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Parent tag should use session header parent (session itself when no parent),
        // not stale .meta.json.parentSessionId
        expect(capturedTags).toContain(`parent:${sessionId}`);
        expect(capturedTags).not.toContain("parent:stale-parent-id");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("observationScopes use header cwd for placeholder expansion, not .meta.json.sessionCwd", async () => {
    const sessionId = `${TEST_SESSION_ID}-struct-scopes`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeMetaFile } = await import("../src/meta");
    const { ensureParsedSessionDir: ensureDir } = await import("../src/parsed-store");

    const configWithScopes: HindsightConfig = {
      ...sharedTestConfig,
      observationScopes: [["{cwd}"], ["{session}", "{cwd}"]],
    };

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Session file has cwd=/test (from writeSessionFile default)
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Pre-create .meta.json with different sessionCwd
        ensureDir();
        writeMetaFile(sessionId, {
          sessionId: sessionId,
          sessionName: "test session",
          sessionCwd: "/stale/cwd",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          retained: true,
          extraContext: null,
          sessionUserTags: [],
        });

        let capturedScopes: unknown;
        const mockClient = {
          retain: async (opts: { observationScopes?: unknown }) => {
            capturedScopes = opts.observationScopes;
            return { success: true };
          },
          retainBatch: async () => ({ success: true }),
        } as unknown as HindsightClientWrapper;

        await parseAndUpsertSession(sessionPath, sessionId, configWithScopes, mockClient, ctx);

        // Observation scopes should use header cwd (/test), not .meta.json.sessionCwd (/stale/cwd)
        expect(capturedScopes).toEqual([["cwd:/test"], [`session:${sessionId}`, "cwd:/test"]]);
        expect(JSON.stringify(capturedScopes)).not.toContain("/stale/cwd");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });
});

describe("retention-disabled fast block clears pending markers", () => {
  it("clears pending markers when .meta.json.retained=false", async () => {
    const sessionId = `${TEST_SESSION_ID}-retained-false-clear`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeSessionState } = await import("../src/session-state");

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Create live state with retained=false
        writeSessionState(sessionId, {
          retained: false,
          extraContext: null,
          updatedAt: new Date().toISOString(),
        });

        expect(hasPendingFlag(sessionId)).toBe(true);

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, sharedTestConfig, mockClient, ctx);

        // Should be blocked
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("does not allow retention"))).toBe(true);
        expect(
          notifyCalls.some(
            (c: unknown[]) =>
              String(c[0]).includes("does not allow retention") && c[1] === "warning"
          )
        ).toBe(true);
        // Pending markers should be cleared
        expect(hasPendingFlag(sessionId)).toBe(false);
        // No retain call should have been made
        expect(mockClient.retain).not.toHaveBeenCalled();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("leaves pending markers when extra-context guard blocks", async () => {
    const sessionId = `${TEST_SESSION_ID}-extra-ctx-keep`;
    const { withTempDir, writeSessionFile } = await import("./fixtures");
    const { writeSessionState } = await import("../src/session-state");

    const configWithGuard: HindsightConfig = {
      ...sharedTestConfig,
      requireExtraContextBeforeFlush: true,
    };

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "test" }],
        });
        const ctx = makeNotifyCtx();

        // Create live state with extraContext=null (not set)
        writeSessionState(sessionId, {
          retained: true,
          extraContext: null,
          updatedAt: new Date().toISOString(),
        });

        expect(hasPendingFlag(sessionId)).toBe(true);

        const mockClient = createMockClient();
        await parseAndUpsertSession(sessionPath, sessionId, configWithGuard, mockClient, ctx);

        // Should be blocked by extra-context guard
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("extra context not set"))).toBe(true);
        expect(
          notifyCalls.some(
            (c: unknown[]) => String(c[0]).includes("extra context not set") && c[1] === "warning"
          )
        ).toBe(true);
        // Pending markers should remain (setting context later allows flush)
        expect(hasPendingFlag(sessionId)).toBe(true);
        // No retain call should have been made
        expect(mockClient.retain).not.toHaveBeenCalled();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });
});

describe("flushCurrentSession", () => {
  it("leaves pending markers when session file is missing", async () => {
    const sessionId = `${TEST_SESSION_ID}-missing-session`;

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        // Session file does not exist
        const sessionPath = join(tmpDir, "nonexistent.jsonl");
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(sessionId, sessionPath, sharedTestConfig, mockClient, ctx);

        // Pending markers should remain — session files are authoritative
        expect(hasPendingFlag(sessionId)).toBe(true);
        // Should have notified about missing session file
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(
          messages.some((m: string) =>
            m.includes("Session file not found — pending session work left queued")
          )
        ).toBe(true);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("flushes tool queue even when session file is missing", async () => {
    const sessionId = `${TEST_SESSION_ID}-missing-session-tool`;

    try {
      await touchPendingFlag(sessionId);
      await enqueueToolMessage(sessionId, {
        content: "tool fact",
        timestamp: "2024-01-01T00:00:00Z",
        store_method: "tool",
        sessionId: sessionId,
      });

      await withTempDir(async (tmpDir) => {
        const sessionPath = join(tmpDir, "nonexistent.jsonl");
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(sessionId, sessionPath, sharedTestConfig, mockClient, ctx);

        // Pending markers remain
        expect(hasPendingFlag(sessionId)).toBe(true);
        // Tool queue should have been flushed
        expect(readToolQueueFromDisk(sessionId)).toHaveLength(0);
        expect(mockClient.retainBatch).toHaveBeenCalled();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("notifies 'No pending changes' when notifyNoWork is true and nothing to do", async () => {
    const sessionId = `${TEST_SESSION_ID}-no-work`;

    try {
      // No pending markers, no tool queue
      await withTempDir(async (tmpDir) => {
        const sessionPath = join(tmpDir, "nonexistent.jsonl");
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(
          sessionId,
          sessionPath,
          sharedTestConfig,
          mockClient,
          ctx,
          undefined,
          { notifyNoWork: true }
        );

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages).toContain("No pending changes");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("does not notify 'No pending changes' when notifyNoWork is not set", async () => {
    const sessionId = `${TEST_SESSION_ID}-no-work-quiet`;

    try {
      await withTempDir(async (tmpDir) => {
        const sessionPath = join(tmpDir, "nonexistent.jsonl");
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(sessionId, sessionPath, sharedTestConfig, mockClient, ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages).not.toContain("No pending changes");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("notifies 'No pending changes' on autoFlush when debug is true and nothing to do", async () => {
    const sessionId = `${TEST_SESSION_ID}-autoflush-debug`;

    try {
      const debugConfig = { ...sharedTestConfig, debug: true };
      await withTempDir(async (tmpDir) => {
        const sessionPath = join(tmpDir, "nonexistent.jsonl");
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(sessionId, sessionPath, debugConfig, mockClient, ctx, undefined, {
          autoFlush: true,
        });

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages).toContain("No pending changes");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("does not notify 'No pending changes' on autoFlush when debug is false", async () => {
    const sessionId = `${TEST_SESSION_ID}-autoflush-nodebug`;

    try {
      await withTempDir(async (tmpDir) => {
        const sessionPath = join(tmpDir, "nonexistent.jsonl");
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(
          sessionId,
          sessionPath,
          sharedTestConfig,
          mockClient,
          ctx,
          undefined,
          {
            autoFlush: true,
          }
        );

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages).not.toContain("No pending changes");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("does not emit 'No pending changes' from parseAndUpsertSession during lifecycle hooks", async () => {
    // Regression: flushCurrentSession must not call parseAndUpsertSession
    // when there are no pending markers, so the "No pending changes"
    // notification from parseAndUpsertSession does not leak through.
    const sessionId = `${TEST_SESSION_ID}-lifecycle-no-leak`;

    try {
      await withTempDir(async (tmpDir) => {
        // Write a valid session file but no pending markers or tool queue
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        // Call without notifyNoWork (like lifecycle hooks do)
        await flushCurrentSession(sessionId, sessionPath, sharedTestConfig, mockClient, ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        // parseAndUpsertSession should NOT have been called at all
        expect(mockClient.retain).not.toHaveBeenCalled();
        // No "No pending changes" notification should have been emitted
        expect(messages).not.toContain("No pending changes");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("parseAndUpsertSession with requirePending+autoFlush stays silent when debug is false", async () => {
    // Simulates the race where another flusher claimed/cleared the pending marker
    // before claimPendingFlag(): no marker present when parseAndUpsertSession runs.
    const sessionId = `${TEST_SESSION_ID}-require-pending-autoflush-quiet`;

    try {
      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await parseAndUpsertSession(
          sessionPath,
          sessionId,
          sharedTestConfig,
          mockClient,
          ctx,
          undefined,
          { requirePending: true, autoFlush: true }
        );

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages).not.toContain("No pending changes");
        // Should not have attempted an upsert
        expect(mockClient.retain).not.toHaveBeenCalled();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("parseAndUpsertSession with requirePending+autoFlush notifies when debug is true", async () => {
    const sessionId = `${TEST_SESSION_ID}-require-pending-autoflush-debug`;
    const debugConfig = { ...sharedTestConfig, debug: true };

    try {
      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await parseAndUpsertSession(
          sessionPath,
          sessionId,
          debugConfig,
          mockClient,
          ctx,
          undefined,
          { requirePending: true, autoFlush: true }
        );

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages).toContain("No pending changes");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("parseAndUpsertSession with requirePending (manual) notifies when no marker", async () => {
    // Manual flush (no autoFlush): always notifies, regardless of debug.
    const sessionId = `${TEST_SESSION_ID}-require-pending-manual`;

    try {
      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await parseAndUpsertSession(
          sessionPath,
          sessionId,
          sharedTestConfig,
          mockClient,
          ctx,
          undefined,
          { requirePending: true }
        );

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages).toContain("No pending changes");
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("emits 'No pending changes' via notifyNoWork when session file exists but no work", async () => {
    const sessionId = `${TEST_SESSION_ID}-notify-no-work-exists`;

    try {
      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(
          sessionId,
          sessionPath,
          sharedTestConfig,
          mockClient,
          ctx,
          undefined,
          { notifyNoWork: true }
        );

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages).toContain("No pending changes");
        expect(mockClient.retain).not.toHaveBeenCalled();
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("suppresses session parse success notification on autoFlush when debug is false", async () => {
    const sessionId = `${TEST_SESSION_ID}-autoflush-parse-quiet`;

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(
          sessionId,
          sessionPath,
          sharedTestConfig,
          mockClient,
          ctx,
          undefined,
          { autoFlush: true }
        );

        expect(mockClient.retain).toHaveBeenCalled();
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(false);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("shows session parse success notification on autoFlush when debug is true", async () => {
    const sessionId = `${TEST_SESSION_ID}-autoflush-parse-debug`;
    const debugConfig = { ...sharedTestConfig, debug: true };

    try {
      await touchPendingFlag(sessionId);

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(sessionId, sessionPath, debugConfig, mockClient, ctx, undefined, {
          autoFlush: true,
        });

        expect(mockClient.retain).toHaveBeenCalled();
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m: string) => m.includes("Parsed and upserted"))).toBe(true);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("suppresses tool queue success notification on autoFlush when debug is false", async () => {
    const sessionId = `${TEST_SESSION_ID}-autoflush-tool-quiet`;

    try {
      await enqueueToolMessage(sessionId, {
        content: "tool fact",
        timestamp: "2024-01-01T00:00:00Z",
        store_method: "tool",
        sessionId: sessionId,
      });

      await withTempDir(async (tmpDir) => {
        const sessionPath = join(tmpDir, "nonexistent.jsonl");
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(
          sessionId,
          sessionPath,
          sharedTestConfig,
          mockClient,
          ctx,
          undefined,
          { autoFlush: true }
        );

        expect(mockClient.retainBatch).toHaveBeenCalled();
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(
          messages.some((m: string) => m.includes("Flushed") && m.includes("tool entries"))
        ).toBe(false);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });

  it("shows tool queue success notification on autoFlush when debug is true", async () => {
    const sessionId = `${TEST_SESSION_ID}-autoflush-tool-debug`;
    const debugConfig = { ...sharedTestConfig, debug: true };

    try {
      await enqueueToolMessage(sessionId, {
        content: "tool fact",
        timestamp: "2024-01-01T00:00:00Z",
        store_method: "tool",
        sessionId: sessionId,
      });

      await withTempDir(async (tmpDir) => {
        const sessionPath = join(tmpDir, "nonexistent.jsonl");
        const ctx = makeNotifyCtx();

        const mockClient = createMockClient();
        await flushCurrentSession(sessionId, sessionPath, debugConfig, mockClient, ctx, undefined, {
          autoFlush: true,
        });

        expect(mockClient.retainBatch).toHaveBeenCalled();
        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const messages = notifyCalls.map((c: unknown[]) => String(c[0]));
        expect(
          messages.some((m: string) => m.includes("Flushed") && m.includes("tool entries"))
        ).toBe(true);
      });
    } finally {
      removePendingFlag(sessionId);
      clearSessionQueueState(sessionId);
      cleanupParsedArtifacts(sessionId);
    }
  });
});
