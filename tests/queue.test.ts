/**
 * Unit tests for queue file management.
 *
 * Tests the lock-free queue protocol using per-entry files and atomic rename claims.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claimPendingFlag,
  claimToolQueue,
  clearSessionQueueState,
  completeClaim,
  enqueueToolMessage,
  getQueueDir,
  getToolQueueEntryCount,
  hasPendingFlag,
  readClaimedToolEntries,
  recoverStaleInflightClaims,
  removePendingFlag,
  restoreClaim,
  toolQueueExists,
  touchPendingFlag,
} from "../src/queue";
import { getToolDir, getToolInflightDir } from "../src/queue-paths";
import { readToolQueueFromDisk, setupTempAgentDir } from "./fixtures";

// Use a unique session ID per test run to avoid collisions
const TEST_SESSION_ID = `test-session-${Date.now()}`;

setupTempAgentDir("queue");

afterEach(() => {
  // Clean up test session queue
  const sessionDir = join(getQueueDir(), TEST_SESSION_ID);
  if (existsSync(sessionDir)) {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

describe("Tool Queue", () => {
  it("should enqueue and read tool entries", async () => {
    const entry = {
      content: "test content",
      tags: ["tag1"],
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };

    const result = await enqueueToolMessage(TEST_SESSION_ID, entry);
    expect(result.success).toBe(true);

    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe("test content");
    expect(entries[0]?.tags).toEqual(["tag1"]);
  });

  it("should enqueue multiple entries", async () => {
    const entry1 = {
      content: "first",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    const entry2 = {
      content: "second",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };

    await enqueueToolMessage(TEST_SESSION_ID, entry1);
    await enqueueToolMessage(TEST_SESSION_ID, entry2);

    const entries = readToolQueueFromDisk(TEST_SESSION_ID);
    expect(entries).toHaveLength(2);
  });

  it("should clear tool queue via clearSessionQueueState", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };

    await enqueueToolMessage(TEST_SESSION_ID, entry);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);

    clearSessionQueueState(TEST_SESSION_ID);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
  });

  it("should check if tool queue exists", async () => {
    expect(toolQueueExists(TEST_SESSION_ID)).toBe(false);

    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    expect(toolQueueExists(TEST_SESSION_ID)).toBe(true);
  });
});

describe("Tool Queue Entry Count", () => {
  it("should return 0 for empty queue", () => {
    expect(getToolQueueEntryCount(TEST_SESSION_ID)).toBe(0);
  });

  it("should count tool entries", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);
    expect(getToolQueueEntryCount(TEST_SESSION_ID)).toBe(1);

    const entry2 = {
      content: "test2",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry2);
    expect(getToolQueueEntryCount(TEST_SESSION_ID)).toBe(2);
  });
});

describe("Pending Flag", () => {
  it("should create and check pending marker", () => {
    expect(hasPendingFlag(TEST_SESSION_ID)).toBe(false);

    const result = touchPendingFlag(TEST_SESSION_ID);
    expect(result.success).toBe(true);

    expect(hasPendingFlag(TEST_SESSION_ID)).toBe(true);
  });

  it("should return success result on successful creation", () => {
    const result = touchPendingFlag(TEST_SESSION_ID, "test_reason");
    expect(result.success).toBe(true);
  });

  it("should remove pending marker", () => {
    touchPendingFlag(TEST_SESSION_ID);
    expect(hasPendingFlag(TEST_SESSION_ID)).toBe(true);

    removePendingFlag(TEST_SESSION_ID);
    expect(hasPendingFlag(TEST_SESSION_ID)).toBe(false);
  });

  it("should create multiple pending markers", () => {
    touchPendingFlag(TEST_SESSION_ID, "message_end");
    touchPendingFlag(TEST_SESSION_ID, "session_switch");

    expect(hasPendingFlag(TEST_SESSION_ID)).toBe(true);
  });
});

describe("Claiming", () => {
  it("should claim tool queue entries", async () => {
    const entry1 = {
      content: "first",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    const entry2 = {
      content: "second",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };

    await enqueueToolMessage(TEST_SESSION_ID, entry1);
    await enqueueToolMessage(TEST_SESSION_ID, entry2);

    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).not.toBeNull();
    expect(claim?.claimedFiles?.length).toBe(2);

    // Queue should be empty after claim
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);

    // Should be able to read claimed entries
    const result = readClaimedToolEntries(claim!);
    expect(result.entries).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("should report malformed JSON errors from readClaimedToolEntries", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).not.toBeNull();

    // Corrupt the claimed file
    writeFileSync(claim!.claimedFiles[0]!, "not valid json{{{", "utf8");

    const result = readClaimedToolEntries(claim!);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.type).toBe("malformed_json");
    expect(result.errors[0]!.filePath).toBe(claim!.claimedFiles[0] as string);
  });

  it("should report invalid schema errors from readClaimedToolEntries", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).not.toBeNull();

    // Replace with valid JSON but invalid schema
    writeFileSync(claim!.claimedFiles[0]!, JSON.stringify({ some: "object" }), "utf8");

    const result = readClaimedToolEntries(claim!);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.type).toBe("invalid_schema");
    expect(result.errors[0]!.filePath).toBe(claim!.claimedFiles[0] as string);
    expect((result.errors[0] as { reason: string }).reason).toContain("store_method");
  });

  it("should report missing file errors from readClaimedToolEntries", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).not.toBeNull();

    // Delete the claimed file
    rmSync(claim!.claimedFiles[0]!, { force: true });

    const result = readClaimedToolEntries(claim!);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.type).toBe("missing");
    expect(result.errors[0]!.filePath).toBe(claim!.claimedFiles[0] as string);
  });

  it("should return null when claiming empty queue", () => {
    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).toBeNull();
  });

  it("should complete claim by deleting files", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).not.toBeNull();

    completeClaim(claim!);

    // Claim dir should be gone
    expect(existsSync(claim!.claimDir)).toBe(false);
  });

  it("should restore claim by moving files back", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const claim = claimToolQueue(TEST_SESSION_ID);
    expect(claim).not.toBeNull();
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);

    restoreClaim(claim!);

    // Entries should be back in the queue
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
  });

  it("should claim pending markers", () => {
    touchPendingFlag(TEST_SESSION_ID, "reason1");
    touchPendingFlag(TEST_SESSION_ID, "reason2");

    const claim = claimPendingFlag(TEST_SESSION_ID);
    expect(claim).not.toBeNull();
    expect(claim?.claimedFiles?.length).toBe(2);

    // Pending should be empty after claim
    expect(hasPendingFlag(TEST_SESSION_ID)).toBe(false);
  });
});

describe("Recovery", () => {
  it("should recover abandoned claims with dead PID on same host", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "dead-pid-claim");
    mkdirSync(claimDir, { recursive: true });

    // Same-host dead PID → abandoned immediately
    const { getCurrentHostname } = await import("../src/queue-paths");
    const claimMeta = {
      claimId: "dead-pid-claim",
      sessionId: TEST_SESSION_ID,
      queue: "tool",
      pid: 99999999,
      hostname: getCurrentHostname(),
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(claimDir, ".claim.json"), JSON.stringify(claimMeta), "utf8");

    // Move a file into the claim dir
    const toolDir = getToolDir(TEST_SESSION_ID);
    const files = readdirSync(toolDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0 && files[0]) {
      const file = files[0];
      writeFileSync(join(claimDir, file), readFileSync(join(toolDir, file), "utf8"));
      rmSync(join(toolDir, files[0]));
    }

    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
  });

  it("should not recover claims with live PID on same host", async () => {
    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "live-pid-claim");
    mkdirSync(claimDir, { recursive: true });

    // Same-host live PID (current process) → NOT abandoned
    const { getCurrentHostname } = await import("../src/queue-paths");
    const claimMeta = {
      claimId: "live-pid-claim",
      sessionId: TEST_SESSION_ID,
      queue: "tool",
      pid: process.pid,
      hostname: getCurrentHostname(),
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(claimDir, ".claim.json"), JSON.stringify(claimMeta), "utf8");
    writeFileSync(join(claimDir, "fake-entry.json"), JSON.stringify({ content: "test" }), "utf8");

    recoverStaleInflightClaims(TEST_SESSION_ID);
    // Claim should still exist
    expect(existsSync(claimDir)).toBe(true);
  });

  it("should not recover recent claims on different host", async () => {
    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "diff-host-recent");
    mkdirSync(claimDir, { recursive: true });

    // Different host, recent → NOT abandoned
    const claimMeta = {
      claimId: "diff-host-recent",
      sessionId: TEST_SESSION_ID,
      queue: "tool",
      pid: 99999999,
      hostname: "a-different-host",
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(claimDir, ".claim.json"), JSON.stringify(claimMeta), "utf8");
    writeFileSync(join(claimDir, "fake-entry.json"), JSON.stringify({ content: "test" }), "utf8");

    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(existsSync(claimDir)).toBe(true);
  });

  it("should recover old claims on different host", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "diff-host-old");
    mkdirSync(claimDir, { recursive: true });

    // Different host, old (> 30min) → abandoned
    const claimMeta = {
      claimId: "diff-host-old",
      sessionId: TEST_SESSION_ID,
      queue: "tool",
      pid: 99999999,
      hostname: "a-different-host",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(claimDir, ".claim.json"), JSON.stringify(claimMeta), "utf8");

    // Move a file into the claim dir
    const toolDir = getToolDir(TEST_SESSION_ID);
    const files = readdirSync(toolDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0 && files[0]) {
      const file = files[0];
      writeFileSync(join(claimDir, file), readFileSync(join(toolDir, file), "utf8"));
      rmSync(join(toolDir, files[0]));
    }

    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
  });

  it("should not recover recent claims with missing metadata", async () => {
    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "no-meta-recent");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "fake-entry.json"), JSON.stringify({ content: "test" }), "utf8");

    // Missing metadata, recent → NOT abandoned
    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(existsSync(claimDir)).toBe(true);
  });

  it("should recover old claims with missing metadata", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "no-meta-old");
    mkdirSync(claimDir, { recursive: true });

    // Move a real file into the claim dir
    const toolDir = getToolDir(TEST_SESSION_ID);
    const files = readdirSync(toolDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0 && files[0]) {
      const file = files[0];
      writeFileSync(join(claimDir, file), readFileSync(join(toolDir, file), "utf8"));
      rmSync(join(toolDir, files[0]));
    }

    // Missing metadata, old → abandoned (mtime fallback)
    // Set directory mtime to 1 hour ago
    const { utimesSync } = await import("node:fs");
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(claimDir, oldTime, oldTime);

    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
  });

  it("should not recover recent claims with invalid metadata", async () => {
    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "invalid-meta-recent");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, ".claim.json"), "not valid json{{{", "utf8");
    writeFileSync(join(claimDir, "fake-entry.json"), JSON.stringify({ content: "test" }), "utf8");

    // Invalid metadata, recent → NOT abandoned
    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(existsSync(claimDir)).toBe(true);
  });

  it("should recover old claims with invalid metadata", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "invalid-meta-old");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, ".claim.json"), "not valid json{{{", "utf8");

    // Move a real file into the claim dir
    const toolDir = getToolDir(TEST_SESSION_ID);
    const files = readdirSync(toolDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0 && files[0]) {
      const file = files[0];
      writeFileSync(join(claimDir, file), readFileSync(join(toolDir, file), "utf8"));
      rmSync(join(toolDir, files[0]));
    }

    // Invalid metadata, old → abandoned (mtime fallback)
    const { utimesSync } = await import("node:fs");
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(claimDir, oldTime, oldTime);

    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
  });

  it("should recover old claims with invalid startedAt via mtime fallback", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "invalid-startedAt");
    mkdirSync(claimDir, { recursive: true });

    // Different host so PID check is skipped; age-based recovery with
    // invalid startedAt should fall back to directory mtime.
    const claimMeta = {
      claimId: "invalid-startedAt",
      sessionId: TEST_SESSION_ID,
      queue: "tool",
      pid: 99999999,
      hostname: "a-different-host",
      startedAt: "not-a-valid-date",
    };
    writeFileSync(join(claimDir, ".claim.json"), JSON.stringify(claimMeta), "utf8");

    // Move a file into the claim dir
    const toolDir = getToolDir(TEST_SESSION_ID);
    const files = readdirSync(toolDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0 && files[0]) {
      const file = files[0];
      writeFileSync(join(claimDir, file), readFileSync(join(toolDir, file), "utf8"));
      rmSync(join(toolDir, files[0]));
    }

    // Set directory mtime to 1 hour ago so mtime-based age is old
    const { utimesSync } = await import("node:fs");
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(claimDir, oldTime, oldTime);

    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
  });

  it("should not recover recent claims with invalid startedAt via mtime fallback", async () => {
    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "invalid-startedAt-recent");
    mkdirSync(claimDir, { recursive: true });

    // Different host with invalid startedAt but recent mtime — should NOT be abandoned
    // (Different host skips PID check, uses age-based recovery only)
    const claimMeta = {
      claimId: "invalid-startedAt-recent",
      sessionId: TEST_SESSION_ID,
      queue: "tool",
      pid: 99999999,
      hostname: "a-different-host",
      startedAt: "not-a-valid-date",
    };
    writeFileSync(join(claimDir, ".claim.json"), JSON.stringify(claimMeta), "utf8");
    writeFileSync(join(claimDir, "fake-entry.json"), JSON.stringify({ content: "test" }), "utf8");

    recoverStaleInflightClaims(TEST_SESSION_ID);
    // Recent claim with invalid startedAt should NOT be abandoned (mtime fallback is recent)
    expect(existsSync(claimDir)).toBe(true);
  });

  it("should not treat invalid PID as dead PID on same host", async () => {
    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "invalid-pid");
    mkdirSync(claimDir, { recursive: true });

    // Invalid PID (not a positive integer) on same host — should NOT be treated as dead PID
    // Instead, should use age-based recovery
    const { getCurrentHostname } = await import("../src/queue-paths");
    const claimMeta = {
      claimId: "invalid-pid",
      sessionId: TEST_SESSION_ID,
      queue: "tool",
      pid: -1,
      hostname: getCurrentHostname(),
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(claimDir, ".claim.json"), JSON.stringify(claimMeta), "utf8");
    writeFileSync(join(claimDir, "fake-entry.json"), JSON.stringify({ content: "test" }), "utf8");

    recoverStaleInflightClaims(TEST_SESSION_ID);
    // Recent claim with invalid PID on same host should NOT be abandoned
    expect(existsSync(claimDir)).toBe(true);
  });

  it("should recover old claims with invalid PID on same host via age-based recovery", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);

    const inflightDir = getToolInflightDir(TEST_SESSION_ID);
    mkdirSync(inflightDir, { recursive: true });
    const claimDir = join(inflightDir, "invalid-pid-old");
    mkdirSync(claimDir, { recursive: true });

    // Invalid PID (0) on same host, old claim — should recover via age
    const { getCurrentHostname } = await import("../src/queue-paths");
    const claimMeta = {
      claimId: "invalid-pid-old",
      sessionId: TEST_SESSION_ID,
      queue: "tool",
      pid: 0,
      hostname: getCurrentHostname(),
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(claimDir, ".claim.json"), JSON.stringify(claimMeta), "utf8");

    // Move a file into the claim dir
    const toolDir = getToolDir(TEST_SESSION_ID);
    const files = readdirSync(toolDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0 && files[0]) {
      const file = files[0];
      writeFileSync(join(claimDir, file), readFileSync(join(toolDir, file), "utf8"));
      rmSync(join(toolDir, files[0]));
    }

    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    recoverStaleInflightClaims(TEST_SESSION_ID);
    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
  });
});

describe("Clear Session Queue State", () => {
  it("should clear all queue state", async () => {
    const entry = {
      content: "test",
      timestamp: new Date().toISOString(),
      store_method: "tool" as const,
      sessionId: TEST_SESSION_ID,
    };
    await enqueueToolMessage(TEST_SESSION_ID, entry);
    touchPendingFlag(TEST_SESSION_ID);

    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(1);
    expect(hasPendingFlag(TEST_SESSION_ID)).toBe(true);

    clearSessionQueueState(TEST_SESSION_ID);

    expect(readToolQueueFromDisk(TEST_SESSION_ID)).toHaveLength(0);
    expect(hasPendingFlag(TEST_SESSION_ID)).toBe(false);
  });
});
