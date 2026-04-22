/**
 * Unit tests for queue file management.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
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

// Use a unique session ID per test run to avoid collisions with real queues
const TEST_SESSION_ID = `test-session-${Date.now()}`;

beforeEach(() => {
  // Ensure the queue dir exists
  ensureQueueDir();
});

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

describe("filesystem failures", () => {
  it("enqueueAutoMessage returns false when queue dir is unwritable", () => {
    // Make the queue directory read-only to trigger write failure
    const queueDir = getQueueDir();

    // Ensure dir exists first
    ensureQueueDir();

    // Make dir read-only (no write permission)
    try {
      chmodSync(queueDir, 0o444);

      const result = enqueueAutoMessage("fs-fail-auto", {
        entry: { message: { role: "user", content: "fail" } },
        store_method: "auto",
      });

      expect(result).toBe(false);
    } finally {
      // Restore permissions
      chmodSync(queueDir, 0o755);
      // Clean up
      deleteAutoQueue("fs-fail-auto");
    }
  });

  it("enqueueToolMessage returns false when queue dir is unwritable", () => {
    const queueDir = getQueueDir();

    try {
      chmodSync(queueDir, 0o444);

      const result = enqueueToolMessage("fs-fail-tool", {
        content: "fail",
        timestamp: "2026-01-01T00:00:00Z",
        store_method: "tool",
      });

      expect(result).toBe(false);
    } finally {
      chmodSync(queueDir, 0o755);
      deleteToolQueue("fs-fail-tool");
    }
  });

  it("deleteAutoQueue does not throw on permission error", () => {
    const queueDir = getQueueDir();

    // Create a queue file
    const queuePath = getQueuePath("fs-fail-delete");
    writeFileSync(queuePath, '{"store_method":"auto","entry":{}}\n', "utf8");

    // Make the file read-only so unlink fails
    try {
      chmodSync(queuePath, 0o444);
      // Also make parent dir read-only to prevent deletion
      chmodSync(queueDir, 0o555);

      // Should not throw
      expect(() => deleteAutoQueue("fs-fail-delete")).not.toThrow();
    } finally {
      chmodSync(queueDir, 0o755);
      chmodSync(queuePath, 0o644);
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
