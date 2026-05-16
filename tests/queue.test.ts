/**
 * Unit tests for queue file management.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import {
  autoQueueExists,
  deleteAutoQueue,
  deleteToolQueue,
  enqueueAutoMessage,
  enqueueToolMessage,
  ensureQueueDir,
  getQueueDir,
  getQueuePath,
  getToolQueuePath,
  readAutoQueue,
  readToolQueue,
  toolQueueExists,
} from "../src/queue";
import { setupTempAgentDir } from "./fixtures";

// Use a unique session ID per test run to avoid collisions
const TEST_SESSION_ID = `test-session-${Date.now()}`;

// Redirect agent-dir filesystem operations to a temp directory instead of
// the real user's ~/.pi/agent/ directory. PI_CODING_AGENT_DIR is read by
// getAgentDir() in @mariozechner/pi-coding-agent.
setupTempAgentDir("queue");

afterEach(() => {
  // Clean up any queue files created during tests
  deleteAutoQueue(TEST_SESSION_ID);
  deleteToolQueue(TEST_SESSION_ID);
});

describe("getQueuePath", () => {
  it("returns path with session ID", () => {
    const path = getQueuePath("abc123");
    expect(path).toContain("abc123.queue.jsonl");
  });
});

describe("getToolQueuePath", () => {
  it("returns tool queue path with session ID", () => {
    const path = getToolQueuePath("abc123");
    expect(path).toContain("abc123.tool-queue.jsonl");
  });
});

describe("ensureQueueDir", () => {
  it("creates queue directory if it does not exist", () => {
    ensureQueueDir();
    const queueDir = getQueueDir();
    expect(existsSync(queueDir)).toBe(true);
  });
});

describe("enqueueAutoMessage and readAutoQueue", () => {
  it("appends auto entries to auto queue file", () => {
    const entry: import("../src/queue").AutoQueueEntry = {
      entry: { message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
      store_method: "auto",
    };

    const result = enqueueAutoMessage(TEST_SESSION_ID, entry);
    expect(result).toBe(true);

    const entries = readAutoQueue(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.store_method).toBe("auto");
  });

  it("returns empty array for non-existent auto queue", () => {
    const entries = readAutoQueue("nonexistent-session");
    expect(entries).toEqual([]);
  });

  it("skips invalid entries without store_method", () => {
    const validEntry: import("../src/queue").AutoQueueEntry = {
      entry: { message: { role: "user", content: [] } },
      store_method: "auto",
    };

    enqueueAutoMessage(TEST_SESSION_ID, validEntry);

    // Write invalid entries directly to the file
    const queuePath = getQueuePath(TEST_SESSION_ID);
    const invalidLines = [
      JSON.stringify({ content: "no store_method" }),
      JSON.stringify({ entry: {}, store_method: "auto" }), // valid
      "not json at all",
      JSON.stringify(null),
      JSON.stringify({ content: "bad method", store_method: "invalid" }),
    ];
    writeFileSync(queuePath, `${invalidLines.join("\n")}\n`, { flag: "a" });

    const entries = readAutoQueue(TEST_SESSION_ID);
    // Should have original valid + one valid from invalidLines
    expect(entries).toHaveLength(2);
  });
});

describe("enqueueToolMessage and readToolQueue", () => {
  it("appends tool entries to tool queue file", () => {
    const entry: import("../src/queue").ToolQueueEntry = {
      content: "Important fact to remember",
      tags: ["topic:important"],
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    };

    const result = enqueueToolMessage(TEST_SESSION_ID, entry);
    expect(result).toBe(true);

    const entries = readToolQueue(TEST_SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.store_method).toBe("tool");
    expect(entries[0]?.content).toBe("Important fact to remember");
    expect(entries[0]?.tags).toEqual(["topic:important"]);
    expect(entries[0]?.timestamp).toBe("2024-01-01T00:00:00Z");
  });

  it("returns empty array for non-existent tool queue", () => {
    const entries = readToolQueue("nonexistent-session");
    expect(entries).toEqual([]);
  });

  it("stores metadata when provided", () => {
    const entry: import("../src/queue").ToolQueueEntry = {
      content: "Fact with metadata",
      metadata: { source: "user", priority: "high" },
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    };

    enqueueToolMessage(TEST_SESSION_ID, entry);
    const entries = readToolQueue(TEST_SESSION_ID);

    expect(entries[0]?.metadata).toEqual({ source: "user", priority: "high" });
  });

  it("rejects entries without timestamp", () => {
    const validEntry: import("../src/queue").ToolQueueEntry = {
      content: "Valid entry",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    };
    enqueueToolMessage(TEST_SESSION_ID, validEntry);

    // Write an entry without a timestamp directly
    const queuePath = getToolQueuePath(TEST_SESSION_ID);
    const invalidLines = [JSON.stringify({ content: "no timestamp", store_method: "tool" })];
    writeFileSync(queuePath, `${invalidLines.join("\n")}\n`, { flag: "a" });

    const entries = readToolQueue(TEST_SESSION_ID);
    // Only the valid entry should be read; the one without timestamp should be skipped
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe("Valid entry");
  });
});

describe("deleteAutoQueue", () => {
  it("deletes existing auto queue file", () => {
    const entry: import("../src/queue").AutoQueueEntry = {
      entry: { message: { role: "user", content: [] } },
      store_method: "auto",
    };
    enqueueAutoMessage(TEST_SESSION_ID, entry);

    expect(autoQueueExists(TEST_SESSION_ID)).toBe(true);

    deleteAutoQueue(TEST_SESSION_ID);

    expect(autoQueueExists(TEST_SESSION_ID)).toBe(false);
  });

  it("does not throw for non-existent queue", () => {
    expect(() => deleteAutoQueue("nonexistent")).not.toThrow();
  });
});

describe("deleteToolQueue", () => {
  it("deletes existing tool queue file", () => {
    const entry: import("../src/queue").ToolQueueEntry = {
      content: "Test",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    };
    enqueueToolMessage(TEST_SESSION_ID, entry);

    expect(toolQueueExists(TEST_SESSION_ID)).toBe(true);

    deleteToolQueue(TEST_SESSION_ID);

    expect(toolQueueExists(TEST_SESSION_ID)).toBe(false);
  });

  it("does not throw for non-existent queue", () => {
    expect(() => deleteToolQueue("nonexistent")).not.toThrow();
  });
});

describe("autoQueueExists", () => {
  it("returns false when queue does not exist", () => {
    expect(autoQueueExists("nonexistent-session")).toBe(false);
  });

  it("returns true when queue exists", () => {
    const entry: import("../src/queue").AutoQueueEntry = {
      entry: { message: { role: "user", content: [] } },
      store_method: "auto",
    };
    enqueueAutoMessage(TEST_SESSION_ID, entry);
    expect(autoQueueExists(TEST_SESSION_ID)).toBe(true);
  });
});

describe("toolQueueExists", () => {
  it("returns false when queue does not exist", () => {
    expect(toolQueueExists("nonexistent-session")).toBe(false);
  });

  it("returns true when queue exists", () => {
    const entry: import("../src/queue").ToolQueueEntry = {
      content: "Test",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    };
    enqueueToolMessage(TEST_SESSION_ID, entry);
    expect(toolQueueExists(TEST_SESSION_ID)).toBe(true);
  });
});

describe("separate queues", () => {
  it("auto and tool queues are stored in separate files", () => {
    const autoEntry: import("../src/queue").AutoQueueEntry = {
      entry: { message: { role: "user", content: "Auto message" } },
      store_method: "auto",
    };
    const toolEntry: import("../src/queue").ToolQueueEntry = {
      content: "Tool content",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    };

    enqueueAutoMessage(TEST_SESSION_ID, autoEntry);
    enqueueToolMessage(TEST_SESSION_ID, toolEntry);

    // Verify separate storage
    const autoEntries = readAutoQueue(TEST_SESSION_ID);
    const toolEntries = readToolQueue(TEST_SESSION_ID);

    expect(autoEntries).toHaveLength(1);
    expect(toolEntries).toHaveLength(1);
    expect(autoQueueExists(TEST_SESSION_ID)).toBe(true);
    expect(toolQueueExists(TEST_SESSION_ID)).toBe(true);
  });

  it("deleteAutoQueue only deletes auto queue", () => {
    const autoEntry: import("../src/queue").AutoQueueEntry = {
      entry: { message: { role: "user", content: "Auto" } },
      store_method: "auto",
    };
    const toolEntry: import("../src/queue").ToolQueueEntry = {
      content: "Tool",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    };

    enqueueAutoMessage(TEST_SESSION_ID, autoEntry);
    enqueueToolMessage(TEST_SESSION_ID, toolEntry);

    deleteAutoQueue(TEST_SESSION_ID);

    expect(autoQueueExists(TEST_SESSION_ID)).toBe(false);
    expect(toolQueueExists(TEST_SESSION_ID)).toBe(true);
  });

  it("deleteToolQueue only deletes tool queue", () => {
    const autoEntry: import("../src/queue").AutoQueueEntry = {
      entry: { message: { role: "user", content: "Auto" } },
      store_method: "auto",
    };
    const toolEntry: import("../src/queue").ToolQueueEntry = {
      content: "Tool",
      timestamp: "2024-01-01T00:00:00Z",
      store_method: "tool",
    };

    enqueueAutoMessage(TEST_SESSION_ID, autoEntry);
    enqueueToolMessage(TEST_SESSION_ID, toolEntry);

    deleteToolQueue(TEST_SESSION_ID);

    expect(autoQueueExists(TEST_SESSION_ID)).toBe(true);
    expect(toolQueueExists(TEST_SESSION_ID)).toBe(false);
  });
});

// ============================================
// Filesystem failure tests
// ============================================

/**
 * Attempt to make a path unwritable.
 * - As root: uses chattr +i (immutable flag) — root bypasses unix permissions
 * - As non-root: uses chmod 0o444
 *
 * Returns a restore function on success, or null if the path cannot be
 * made unwritable (caller should skip the test).
 */
function tryMakeUnwritable(path: string): (() => void) | null {
  if (process.getuid?.() === 0) {
    // Root bypasses unix permissions — try chattr +i
    try {
      execFileSync("chattr", ["+i", path], { stdio: "pipe" });
      return () => {
        try {
          execFileSync("chattr", ["-i", path], { stdio: "pipe" });
        } catch {
          // Best-effort: don't let cleanup failure mask test failures
        }
      };
    } catch {
      // Filesystem doesn't support chattr (overlayfs, FUSE, etc.)
      return null;
    }
  }
  // Non-root: chmod is sufficient. Save original mode for restore.
  // Directories get 0o555 (traversable but not writable) so that
  // existsSync still works and unlink actually fails with EACCES.
  // Files get 0o444 (read-only).
  const stats = statSync(path);
  const originalMode = stats.mode & 0o777;
  chmodSync(path, stats.isDirectory() ? 0o555 : 0o444);
  return () => {
    try {
      chmodSync(path, originalMode);
    } catch {
      // Best-effort: don't let cleanup failure mask test failures
    }
  };
}

describe("filesystem failures", () => {
  it("enqueueAutoMessage returns false when queue dir is unwritable", () => {
    const queueDir = getQueueDir();
    ensureQueueDir();

    const restore = tryMakeUnwritable(queueDir);
    expect(restore).not.toBeNull();
    // Type narrowing: restore is () => void after expect guard
    const restoreFn = restore!;

    try {
      const result = enqueueAutoMessage("fs-fail-auto", {
        entry: { message: { role: "user", content: "fail" } },
        store_method: "auto",
      });

      expect(result).toBe(false);
    } finally {
      restoreFn();
      deleteAutoQueue("fs-fail-auto");
    }
  });

  it("enqueueToolMessage returns false when queue dir is unwritable", () => {
    const queueDir = getQueueDir();
    ensureQueueDir();

    const restore = tryMakeUnwritable(queueDir);
    expect(restore).not.toBeNull();
    // Type narrowing: restore is () => void after expect guard
    const restoreFn = restore!;

    try {
      const result = enqueueToolMessage("fs-fail-tool", {
        content: "fail",
        timestamp: "2026-01-01T00:00:00Z",
        store_method: "tool",
      });

      expect(result).toBe(false);
    } finally {
      restoreFn();
      deleteToolQueue("fs-fail-tool");
    }
  });

  it("deleteAutoQueue does not throw on permission error", () => {
    const queueDir = getQueueDir();

    // Create a queue file
    const queuePath = getQueuePath("fs-fail-delete");
    writeFileSync(queuePath, '{"store_method":"auto","entry":{}}\n', "utf8");

    const restoreFile = tryMakeUnwritable(queuePath);
    const restoreDir = tryMakeUnwritable(queueDir);
    expect(restoreFile).not.toBeNull();
    expect(restoreDir).not.toBeNull();
    // Type narrowing: non-null after expect guards
    const restoreFileFn = restoreFile!;
    const restoreDirFn = restoreDir!;

    try {
      // Should not throw
      expect(() => deleteAutoQueue("fs-fail-delete")).not.toThrow();
    } finally {
      // Restore directory first, then file — directory must be writable
      // before we can chmod the file back (if using chmod path).
      restoreDirFn();
      restoreFileFn();
      deleteAutoQueue("fs-fail-delete");
    }
  });

  it("readAutoQueue returns empty array on corrupted queue file", () => {
    const queuePath = getQueuePath("fs-corrupt");
    // Write invalid JSON
    writeFileSync(queuePath, "not json at all\nalso garbage\n", "utf8");

    const entries = readAutoQueue("fs-corrupt");
    expect(entries).toEqual([]);

    deleteAutoQueue("fs-corrupt");
  });

  it("readToolQueue returns empty array on corrupted queue file", () => {
    const queuePath = getToolQueuePath("fs-corrupt-tool");
    writeFileSync(queuePath, "\0\0binary garbage\n", "utf8");

    const entries = readToolQueue("fs-corrupt-tool");
    expect(entries).toEqual([]);

    deleteToolQueue("fs-corrupt-tool");
  });
});
