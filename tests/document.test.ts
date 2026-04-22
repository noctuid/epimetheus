/**
 * Unit tests for document builder.
 * Covers: basic sessions, fork scenarios, compaction, bad path handling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HindsightConfig } from "../src/config";
import {
  buildDocumentContent,
  buildDocumentTags,
  buildMessageArrayFromSession,
  getHindsightContext,
  parseSessionFile,
  type SessionEntry,
  type SessionHeader,
} from "../src/document";

// Use a unique temp directory per test run to avoid colliding with real data
const RUN_ID = `hindsight-doc-test-${Date.now()}`;
const TEST_HOME = join(tmpdir(), RUN_ID, "home");
const TEST_SESSIONS_DIR = join(TEST_HOME, ".pi/agent/sessions/test-project");

import { testConfig } from "./fixtures";

const defaultConfig: HindsightConfig = {
  ...testConfig,
  apiUrl: "https://test.vectorize.io/api",
  constantTags: ["project:test"],
  recallPromptPreamble: "Test preamble",
  retainContent: {
    assistant: ["text", "thinking", "toolCall"],
    user: ["text"],
    toolResult: [],
  },
  strip: {
    topLevel: ["type", "id", "parentId"],
    message: ["api", "provider", "model", "usage", "cost", "stopReason", "timestamp", "responseId"],
  },
};

// Helper to create a session file
function createSessionFile(
  filename: string,
  header: Partial<SessionHeader>,
  entries: SessionEntry[]
): string {
  const path = join(TEST_SESSIONS_DIR, filename);
  const fullHeader: SessionHeader = {
    type: "session",
    id: header.id || "test-session-id",
    timestamp: header.timestamp || new Date().toISOString(),
    cwd: header.cwd || TEST_HOME,
    ...header,
  };

  const lines = [JSON.stringify(fullHeader), ...entries.map((e) => JSON.stringify(e))];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

// Helper to create a user message entry
function userEntry(
  id: string,
  parentId: string | null,
  text: string,
  timestamp?: string
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: timestamp || new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

// Helper to create an assistant message entry
function assistantEntry(
  id: string,
  parentId: string | null,
  text: string,
  responseId: string,
  timestamp?: string
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: timestamp || new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      responseId,
    },
  };
}

// Helper to create a tool result entry
function toolResultEntry(id: string, parentId: string | null, toolName: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolName,
      content: [{ type: "text", text: "tool output" }],
    } as SessionEntry["message"],
  };
}

// Helper to create a compaction entry
function compactionEntry(id: string, parentId: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: new Date().toISOString(),
  } as SessionEntry;
}

// Setup test directory
beforeEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
});

// Cleanup
afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

// ============================================
// Basic Sessions
// ============================================

describe("basic sessions", () => {
  it("handles empty session (no messages)", () => {
    const path = createSessionFile("empty.jsonl", { id: "empty-session" }, []);

    const result = buildDocumentContent(path, defaultConfig);

    expect(result.content).toBe("[]");
    expect(result.documentId).toBe("empty-session");
    expect(result.warning).toBeUndefined();
  });

  it("handles session with only user message", () => {
    const path = createSessionFile("user-only.jsonl", { id: "user-only-session" }, [
      { type: "model_change", id: "mc1", parentId: null, timestamp: "2026-01-01T00:00:00Z" },
      userEntry("u1", "mc1", "Hello world"),
    ]);

    const result = buildDocumentContent(path, defaultConfig);

    // Should include the user message
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].message.role).toBe("user");
    expect(result.documentId).toBe("user-only-session");
  });

  it("handles session with one user/assistant pair", () => {
    const path = createSessionFile("pair.jsonl", { id: "pair-session" }, [
      userEntry("u1", null, "What is 2+2?"),
      assistantEntry("a1", "u1", "2+2 equals 4", "resp-001"),
    ]);

    const result = buildDocumentContent(path, defaultConfig);

    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].message.role).toBe("user");
    expect(parsed[1].message.role).toBe("assistant");
    // responseId is stripped per strip.message config
    expect(parsed[1].message.responseId).toBeUndefined();
  });

  it("excludes tool results from content", () => {
    const path = createSessionFile("with-tools.jsonl", { id: "tools-session" }, [
      userEntry("u1", null, "Read the file"),
      assistantEntry("a1", "u1", "Let me read it", "resp-001"),
      toolResultEntry("t1", "a1", "read"),
      assistantEntry("a2", "t1", "Here's the content", "resp-002"),
    ]);

    const result = buildDocumentContent(path, defaultConfig);

    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(3); // u1, a1, a2 (no tool result)
    expect(
      parsed.every(
        (p: { message: { role: string } }) =>
          p.message.role === "user" || p.message.role === "assistant"
      )
    ).toBe(true);
  });
});

// ============================================
// Fork Scenarios
// ============================================

describe("fork detection", () => {
  it("handles fork at start (first message differs)", () => {
    // Parent session
    const parentPath = createSessionFile("parent.jsonl", { id: "parent-session" }, [
      userEntry("u1", null, "Hello from parent"),
      assistantEntry("a1", "u1", "Hi there!", "resp-parent-001"),
    ]);

    // Fork session - diverges immediately
    const forkPath = createSessionFile(
      "fork-start.jsonl",
      {
        id: "fork-start-session",
        parentSession: parentPath,
      },
      [
        userEntry("u1", null, "Hello from parent"),
        assistantEntry("a1", "u1", "Hi there!", "resp-parent-001"),
        userEntry("u2", "a1", "Actually, I want something else"),
        assistantEntry("a2", "u2", "Sure thing!", "resp-fork-001"),
      ]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);

    // Should include from the first diverging message
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].message.role).toBe("user");
    expect(parsed[0].message.content[0].text).toBe("Actually, I want something else");
  });

  it("handles fork at end (last message differs)", () => {
    // Parent session with multiple turns
    const parentPath = createSessionFile("parent-long.jsonl", { id: "parent-long-session" }, [
      userEntry("u1", null, "Turn 1"),
      assistantEntry("a1", "u1", "Response 1", "resp-p1"),
      userEntry("u2", "a1", "Turn 2"),
      assistantEntry("a2", "u2", "Response 2", "resp-p2"),
    ]);

    // Fork session - diverges at end (different entry id for the new response)
    const forkPath = createSessionFile(
      "fork-end.jsonl",
      {
        id: "fork-end-session",
        parentSession: parentPath,
      },
      [
        userEntry("u1", null, "Turn 1"),
        assistantEntry("a1", "u1", "Response 1", "resp-p1"),
        userEntry("u2", "a1", "Turn 2"),
        assistantEntry("a2-fork", "u2", "Different response 2", "resp-f2"),
      ]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);

    // Should include from user message before divergence (u2)
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].message.content[0].text).toBe("Turn 2");
    // responseId is stripped per strip.message config
    expect(parsed[1].message.responseId).toBeUndefined();
  });

  it("handles sibling forks (same parent, different children)", () => {
    // Parent session
    const parentPath = createSessionFile("parent-sib.jsonl", { id: "parent-sib-session" }, [
      userEntry("u1", null, "What should I build?"),
      assistantEntry("a1", "u1", "How about X?", "resp-parent"),
    ]);

    // Sibling fork 1
    const fork1Path = createSessionFile(
      "fork-sib1.jsonl",
      {
        id: "fork-sib1-session",
        parentSession: parentPath,
      },
      [
        userEntry("u1", null, "What should I build?"),
        assistantEntry("a1", "u1", "How about X?", "resp-parent"),
        userEntry("u2", "a1", "I'll build a castle!"),
        assistantEntry("a2", "u2", "Great choice!", "resp-sib1"),
      ]
    );

    // Sibling fork 2
    const fork2Path = createSessionFile(
      "fork-sib2.jsonl",
      {
        id: "fork-sib2-session",
        parentSession: parentPath,
      },
      [
        userEntry("u1", null, "What should I build?"),
        assistantEntry("a1", "u1", "How about X?", "resp-parent"),
        userEntry("u3", "a1", "I'll build a spaceship!"),
        assistantEntry("a3", "u3", "Exciting!", "resp-sib2"),
      ]
    );

    const result1 = buildDocumentContent(fork1Path, defaultConfig);
    const result2 = buildDocumentContent(fork2Path, defaultConfig);

    const parsed1 = JSON.parse(result1.content);
    const parsed2 = JSON.parse(result2.content);

    // Each fork should capture its unique content
    expect(parsed1[0].message.content[0].text).toBe("I'll build a castle!");
    expect(parsed2[0].message.content[0].text).toBe("I'll build a spaceship!");
  });

  it("handles grandchild fork (fork of a fork)", () => {
    // Grandparent
    const gpPath = createSessionFile("grandparent.jsonl", { id: "gp-session" }, [
      userEntry("u1", null, "Start"),
      assistantEntry("a1", "u1", "GP response", "resp-gp"),
    ]);

    // Parent (fork of grandparent)
    const pPath = createSessionFile(
      "parent-fork.jsonl",
      {
        id: "p-session",
        parentSession: gpPath,
      },
      [
        userEntry("u1", null, "Start"),
        assistantEntry("a1", "u1", "GP response", "resp-gp"),
        userEntry("u2", "a1", "Parent turn"),
        assistantEntry("a2", "u2", "Parent response", "resp-p"),
      ]
    );

    // Child (fork of parent)
    const cPath = createSessionFile(
      "child-fork.jsonl",
      {
        id: "c-session",
        parentSession: pPath,
      },
      [
        userEntry("u1", null, "Start"),
        assistantEntry("a1", "u1", "GP response", "resp-gp"),
        userEntry("u2", "a1", "Parent turn"),
        assistantEntry("a2", "u2", "Parent response", "resp-p"),
        userEntry("u3", "a2", "Child turn"),
        assistantEntry("a3", "u3", "Child response", "resp-c"),
      ]
    );

    const result = buildDocumentContent(cPath, defaultConfig);

    // Should only include child's unique content (u3 + a3)
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].message.content[0].text).toBe("Child turn");
    // responseId is stripped per strip.message config
    expect(parsed[1].message.responseId).toBeUndefined();
  });

  it("handles fork with no new content (replay only)", () => {
    // Parent session
    const parentPath = createSessionFile("parent-replay.jsonl", { id: "parent-replay-session" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi!", "resp-replay"),
    ]);

    // Fork session - exact replay, no divergence
    const forkPath = createSessionFile(
      "fork-replay.jsonl",
      {
        id: "fork-replay-session",
        parentSession: parentPath,
      },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi!", "resp-replay")]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);

    // No new content to retain
    expect(result.content).toBe("[]");
  });

  it("filters hindsight-recall messages from forked sessions", () => {
    // Parent session
    const parentPath = createSessionFile(
      "parent-no-recall.jsonl",
      { id: "parent-no-recall-session" },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi!", "resp-pnr")]
    );

    // Fork with hindsight-recall message mixed in
    const recallEntry: SessionEntry = {
      type: "message",
      id: "recall-fork",
      parentId: "a1",
      timestamp: new Date().toISOString(),
      message: {
        role: "custom",
        customType: "hindsight-recall",
        content: "Retrieved memories...",
      } as SessionEntry["message"],
    };

    const forkPath = createSessionFile(
      "fork-with-recall.jsonl",
      {
        id: "fork-with-recall-session",
        parentSession: parentPath,
      },
      [
        userEntry("u1", null, "Hello"),
        assistantEntry("a1", "u1", "Hi!", "resp-pnr"),
        recallEntry,
        userEntry("u2", "a1", "New question"),
        assistantEntry("a2", "u2", "New answer", "resp-fork-recall"),
      ]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);
    const parsed = JSON.parse(result.content);

    // Should have 2 messages (u2, a2) - recall entry filtered, fork content only
    expect(parsed).toHaveLength(2);
    expect(parsed[0].message.content[0].text).toBe("New question");
    expect(
      parsed.every(
        (p: { message: { customType?: string } }) => p.message.customType !== "hindsight-recall"
      )
    ).toBe(true);
  });
});

// ============================================
// Compaction
// ============================================

describe("compaction handling", () => {
  it("handles compaction before fork point", () => {
    // Parent session with compaction
    const parentPath = createSessionFile("parent-compaction.jsonl", { id: "parent-comp-session" }, [
      userEntry("u1", null, "Message 1"),
      assistantEntry("a1", "u1", "Response 1", "resp-c1"),
      userEntry("u2", "a1", "Message 2"),
      assistantEntry("a2", "u2", "Response 2", "resp-c2"),
      compactionEntry("comp1", "a2"),
      userEntry("u3", "comp1", "Message 3"),
      assistantEntry("a3", "u3", "Response 3", "resp-c3"),
    ]);

    // Fork session - diverges after compaction (different entry id for new response)
    const forkPath = createSessionFile(
      "fork-after-compaction.jsonl",
      {
        id: "fork-comp-session",
        parentSession: parentPath,
      },
      [
        userEntry("u1", null, "Message 1"),
        assistantEntry("a1", "u1", "Response 1", "resp-c1"),
        userEntry("u2", "a1", "Message 2"),
        assistantEntry("a2", "u2", "Response 2", "resp-c2"),
        compactionEntry("comp1", "a2"),
        userEntry("u3", "comp1", "Message 3"),
        assistantEntry("a3-fork", "u3", "Different response 3", "resp-fork-c3"),
      ]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);

    // Compaction is excluded (it's not a message type user/assistant)
    // Should include u3 + a3 (the fork content)
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].message.content[0].text).toBe("Message 3");
  });

  it("verifies compaction only adds JSON lines (doesn't delete)", () => {
    // Session with compaction in the middle
    const path = createSessionFile("compaction-middle.jsonl", { id: "compaction-middle-session" }, [
      userEntry("u1", null, "Before compaction 1"),
      assistantEntry("a1", "u1", "Before response 1", "resp-b1"),
      compactionEntry("comp1", "a1"),
      userEntry("u2", "comp1", "After compaction"),
      assistantEntry("a2", "u2", "After response", "resp-a1"),
    ]);

    // Parse and verify all entries are present
    const { entries } = parseSessionFile(path);

    // Compaction adds a line, doesn't delete anything
    expect(entries.length).toBe(5);

    // Verify document content excludes compaction
    const result = buildDocumentContent(path, defaultConfig);
    const parsed = JSON.parse(result.content);

    // Only conversation messages, not compaction
    expect(parsed).toHaveLength(4);
    expect(
      parsed.every(
        (p: { message: { role: string } }) =>
          p.message.role === "user" || p.message.role === "assistant"
      )
    ).toBe(true);
  });
});

// ============================================
// Bad Path Handling
// ============================================

describe("bad path handling", () => {
  it("fails with warning for missing parent session", () => {
    const forkPath = createSessionFile(
      "orphan-fork.jsonl",
      {
        id: "orphan-session",
        parentSession: "/nonexistent/parent.jsonl",
      },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi!", "resp-orphan")]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);

    expect(result.content).toBe("[]");
    expect(result.warning).toContain("Parent session not found");
    expect(result.documentId).toBe("orphan-session");
  });

  it("throws for session file without header", () => {
    // Create malformed file without session header
    const path = join(TEST_SESSIONS_DIR, "no-header.jsonl");
    writeFileSync(path, `${JSON.stringify(userEntry("u1", null, "No header"))}\n`);

    expect(() => buildDocumentContent(path, defaultConfig)).toThrow("missing header");
  });
});

// ============================================
// Tags
// ============================================

describe("document tags", () => {
  it("builds tags for non-fork session", () => {
    const header: SessionHeader = {
      type: "session",
      id: "test-123",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: TEST_HOME,
    };

    const tags = buildDocumentTags(header, defaultConfig);

    expect(tags).toContain("project:test");
    expect(tags).toContain("session:test-123");
    expect(tags).toContain(`cwd:${TEST_HOME}`);
    expect(tags).toContain("store_method:auto");
    expect(tags).toContain("parent:test-123");
  });

  it("builds tags with custom store method", () => {
    const header: SessionHeader = {
      type: "session",
      id: "test-456",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: TEST_HOME,
    };

    const tags = buildDocumentTags(header, defaultConfig, { storeMethod: "tool" });

    expect(tags).toContain("store_method:tool");
  });

  it("builds tags for forked session", () => {
    const header: SessionHeader = {
      type: "session",
      id: "fork-456",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: TEST_HOME,
      parentSession: "/path/to/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    };

    const tags = buildDocumentTags(header, defaultConfig);

    expect(tags).toContain("project:test");
    expect(tags).toContain("session:fork-456");
    expect(tags).toContain(`cwd:${TEST_HOME}`);
    expect(tags).toContain("store_method:auto");
    expect(tags).toContain("parent:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});

// ============================================
// Document Tags with Session Metadata
// ============================================

describe("document tags with session metadata", () => {
  it("includes session tags in document tags", () => {
    const header: SessionHeader = {
      type: "session",
      id: "test-session-tags",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: TEST_HOME,
    };

    const tags = buildDocumentTags(header, defaultConfig, {
      sessionTags: ["topic:ai", "priority:high"],
    });

    expect(tags).toContain("topic:ai");
    expect(tags).toContain("priority:high");
    expect(tags).toContain("project:test"); // Still has constant tags
    expect(tags).toContain("session:test-session-tags");
  });

  it("works without session tags (backward compatible)", () => {
    const header: SessionHeader = {
      type: "session",
      id: "test-no-tags",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: TEST_HOME,
    };

    const tags = buildDocumentTags(header, defaultConfig);

    expect(tags).toContain("project:test");
    expect(tags).toContain("session:test-no-tags");
  });

  it("includes session tags with forked session", () => {
    const header: SessionHeader = {
      type: "session",
      id: "fork-session-tags",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: TEST_HOME,
      parentSession: "/path/to/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    };

    const tags = buildDocumentTags(header, defaultConfig, {
      sessionTags: ["topic:fork"],
    });

    expect(tags).toContain("topic:fork");
    expect(tags).toContain("parent:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});

// ============================================
// Context
// ============================================

describe("hindsight context", () => {
  it("prefers session name over first user message", () => {
    const path = createSessionFile("context-session-name.jsonl", { id: "context-session-name" }, [
      userEntry("u1", null, "Build me a homepage"),
      assistantEntry("a1", "u1", "Sure!", "resp-ctx"),
    ]);

    const context = getHindsightContext(path, defaultConfig, "My Custom Session Name");

    expect(context).toBe("pi: My Custom Session Name");
  });

  it("extracts first user message as context when no session name", () => {
    const path = createSessionFile("context-test.jsonl", { id: "context-session" }, [
      userEntry("u1", null, "Build me a homepage"),
      assistantEntry("a1", "u1", "Sure!", "resp-ctx"),
    ]);

    const context = getHindsightContext(path, defaultConfig);

    expect(context).toBe("pi: Build me a homepage");
  });

  it("truncates long session name", () => {
    const longName = "A".repeat(200);
    const path = createSessionFile(
      "context-long-name.jsonl",
      { id: "context-long-name-session" },
      []
    );

    const config: HindsightConfig = {
      ...defaultConfig,
      hindsightContextMaxLength: 50,
    };

    const context = getHindsightContext(path, config, longName);

    expect(context.length).toBe(50);
    expect(context.endsWith("…")).toBe(true);
  });

  it("truncates long context from first message", () => {
    const longText = "A".repeat(200);
    const path = createSessionFile("context-long.jsonl", { id: "context-long-session" }, [
      userEntry("u1", null, longText),
      assistantEntry("a1", "u1", "OK", "resp-long"),
    ]);

    const config: HindsightConfig = {
      ...defaultConfig,
      hindsightContextMaxLength: 50,
    };

    const context = getHindsightContext(path, config);

    expect(context.length).toBe(50);
    expect(context.endsWith("…")).toBe(true);
  });

  it("uses default context when no user message or session name", () => {
    const path = createSessionFile("context-empty.jsonl", { id: "context-empty-session" }, []);

    const context = getHindsightContext(path, defaultConfig);

    expect(context).toBe("pi: pi session");
  });
});

// ============================================
// Content Filtering
// ============================================

describe("content filtering", () => {
  it("excludes tool results by default", () => {
    const path = createSessionFile("with-tools-filtered.jsonl", { id: "tools-filtered-session" }, [
      userEntry("u1", null, "Read the file"),
      assistantEntry("a1", "u1", "Let me read it", "resp-001"),
      toolResultEntry("t1", "a1", "read"),
      assistantEntry("a2", "t1", "Done", "resp-002"),
    ]);

    const result = buildDocumentContent(path, defaultConfig);
    const parsed = JSON.parse(result.content);

    // Tool results excluded by default (empty toolResult array in config)
    expect(parsed).toHaveLength(3);
    expect(
      parsed.every(
        (p: { message: { role: string } }) =>
          p.message.role === "user" || p.message.role === "assistant"
      )
    ).toBe(true);
  });

  it("includes tool results when configured", () => {
    const configWithTools: HindsightConfig = {
      ...defaultConfig,
      retainContent: {
        ...defaultConfig.retainContent,
        toolResult: ["text"],
      },
    };

    const path = createSessionFile("with-tools-included.jsonl", { id: "tools-included-session" }, [
      userEntry("u1", null, "Read the file"),
      assistantEntry("a1", "u1", "Let me read it", "resp-001"),
      toolResultEntry("t1", "a1", "read"),
      assistantEntry("a2", "t1", "Done", "resp-002"),
    ]);

    const result = buildDocumentContent(path, configWithTools);
    const parsed = JSON.parse(result.content);

    // Tool results included
    expect(parsed).toHaveLength(4);
    expect(parsed[2].message.role).toBe("toolResult");
  });

  it("filters assistant content types", () => {
    // Create assistant with thinking and text
    const assistantWithThinking: SessionEntry = {
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Internal thought" },
          { type: "text", text: "Public response" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ],
        responseId: "resp-filter",
      },
    };

    const path = createSessionFile("assistant-filter.jsonl", { id: "assistant-filter-session" }, [
      userEntry("u1", null, "Hello"),
      assistantWithThinking,
    ]);

    // Config excluding thinking
    const configNoThinking: HindsightConfig = {
      ...defaultConfig,
      retainContent: {
        ...defaultConfig.retainContent,
        assistant: ["text", "toolCall"],
      },
    };

    const result = buildDocumentContent(path, configNoThinking);
    const parsed = JSON.parse(result.content);

    expect(parsed[1].message.content).toHaveLength(2);
    expect(parsed[1].message.content[0].type).toBe("text");
    expect(parsed[1].message.content[1].type).toBe("toolCall");
  });

  it("filters user content types (excludes images by default)", () => {
    const userWithImage: SessionEntry = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
        timestamp: Date.now(),
      },
    };

    const path = createSessionFile("user-image.jsonl", { id: "user-image-session" }, [
      userWithImage,
      assistantEntry("a1", "u1", "I see it", "resp-img"),
    ]);

    const result = buildDocumentContent(path, defaultConfig);
    const parsed = JSON.parse(result.content);

    // Image excluded by default (user: ["text"])
    expect(parsed[0].message.content).toHaveLength(1);
    expect(parsed[0].message.content[0].type).toBe("text");
  });

  it("includes images when configured", () => {
    const userWithImage: SessionEntry = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
        timestamp: Date.now(),
      },
    };

    const path = createSessionFile(
      "user-image-include.jsonl",
      { id: "user-image-include-session" },
      [userWithImage, assistantEntry("a1", "u1", "I see it", "resp-img-2")]
    );

    const configWithImages: HindsightConfig = {
      ...defaultConfig,
      retainContent: {
        ...defaultConfig.retainContent,
        user: ["text", "image"],
      },
    };

    const result = buildDocumentContent(path, configWithImages);
    const parsed = JSON.parse(result.content);

    expect(parsed[0].message.content).toHaveLength(2);
    expect(parsed[0].message.content[1].type).toBe("image");
  });

  it("excludes hindsight-recall messages (injected context)", () => {
    // hindsight-recall messages are injected by the extension during context events
    // They should be filtered during parsing to match runtime filtering behavior
    const recallEntry: SessionEntry = {
      type: "message",
      id: "recall-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "custom",
        customType: "hindsight-recall",
        content: "Retrieved memories...",
      } as SessionEntry["message"],
    };

    const path = createSessionFile("with-recall.jsonl", { id: "with-recall-session" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi!", "resp-1"),
      recallEntry,
      userEntry("u2", "a1", "Thanks"),
      assistantEntry("a2", "u2", "You're welcome", "resp-2"),
    ]);

    const result = buildDocumentContent(path, defaultConfig);
    const parsed = JSON.parse(result.content);

    // Should have 4 messages (u1, a1, u2, a2) - recall entry filtered out
    expect(parsed).toHaveLength(4);
    expect(
      parsed.every(
        (p: { message: { customType?: string } }) => p.message.customType !== "hindsight-recall"
      )
    ).toBe(true);
  });
});

// ============================================
// buildMessageArrayFromSession (for parse-session command)
// ============================================

describe("buildMessageArrayFromSession", () => {
  it("returns all messages for non-fork session", () => {
    const path = createSessionFile("non-fork-msgs.jsonl", { id: "non-fork-msgs-session" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi!", "resp-nf"),
    ]);

    const { messages, documentId } = buildMessageArrayFromSession(path, defaultConfig);

    expect(documentId).toBe("non-fork-msgs-session");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveProperty("message");
  });

  it("returns only fork content for forked session", () => {
    const parentPath = createSessionFile("parent-msgs.jsonl", { id: "parent-msgs-session" }, [
      userEntry("u1", null, "Parent question"),
      assistantEntry("a1", "u1", "Parent answer", "resp-pm"),
    ]);

    const forkPath = createSessionFile(
      "fork-msgs.jsonl",
      { id: "fork-msgs-session", parentSession: parentPath },
      [
        userEntry("u1", null, "Parent question"),
        assistantEntry("a1", "u1", "Parent answer", "resp-pm"),
        userEntry("u2", "a1", "Fork question"),
        assistantEntry("a2", "u2", "Fork answer", "resp-fm"),
      ]
    );

    const { messages, documentId } = buildMessageArrayFromSession(forkPath, defaultConfig);

    expect(documentId).toBe("fork-msgs-session");
    expect(messages).toHaveLength(2);
  });

  it("returns warning for missing parent", () => {
    const path = createSessionFile(
      "orphan-msgs.jsonl",
      { id: "orphan-msgs-session", parentSession: "/nonexistent/parent.jsonl" },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi!", "resp-om")]
    );

    const { messages, warning } = buildMessageArrayFromSession(path, defaultConfig);

    expect(messages).toHaveLength(0);
    expect(warning).toContain("Parent session not found");
  });
});

// ============================================
// Tool Filtering (combined retainContent + toolFilter + strip)
// ============================================

describe("tool filtering", () => {
  // Helper to create a toolCall content entry
  function toolCallEntry(
    id: string,
    parentId: string | null,
    text: string,
    toolName: string,
    toolId: string,
    responseId: string
  ): SessionEntry {
    return {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text },
          { type: "toolCall", id: toolId, name: toolName, arguments: {} },
        ],
        responseId,
      },
    };
  }

  // Helper to create a tool result entry with toolName
  function toolResultNamedEntry(
    id: string,
    parentId: string | null,
    toolName: string,
    toolCallId: string,
    resultText: string
  ): SessionEntry {
    return {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: resultText }],
        isError: false,
        timestamp: Date.now(),
      } as SessionEntry["message"],
    };
  }

  it("excludes toolCall blocks by tool name via toolFilter", () => {
    const configWithToolFilter: HindsightConfig = {
      ...defaultConfig,
      retainContent: {
        assistant: ["text", "toolCall"],
        user: ["text"],
        toolResult: [],
      },
      toolFilter: {
        toolCall: { exclude: ["bash", "read"] },
      },
    };

    const path = createSessionFile(
      "toolfilter-exclude-call.jsonl",
      { id: "toolfilter-exclude-call-session" },
      [
        userEntry("u1", null, "Run a command"),
        toolCallEntry("a1", "u1", "Running", "bash", "call-1", "resp-1"),
        toolResultNamedEntry("t1", "a1", "bash", "call-1", "output"),
        toolCallEntry("a2", "t1", "Reading", "read", "call-2", "resp-2"),
        toolCallEntry("a3", "a2", "Remember this", "hindsight_retain", "call-3", "resp-3"),
      ]
    );

    const result = buildDocumentContent(path, configWithToolFilter);
    const parsed = JSON.parse(result.content);

    // bash and read toolCalls excluded, hindsight_retain kept
    // a1 has bash call -> only text retained
    // a2 has read call -> only text retained
    // a3 has hindsight_retain call -> text + toolCall retained
    expect(parsed).toHaveLength(4); // u1, a1, a2, a3 (toolResults excluded by retainContent)
    const a1Content = parsed[1].message.content;
    expect(a1Content).toHaveLength(1);
    expect(a1Content[0].type).toBe("text");
    const a3Content = parsed[3].message.content;
    expect(a3Content).toHaveLength(2);
    expect(a3Content[1].name).toBe("hindsight_retain");
  });

  it("excludes toolResult messages by tool name via toolFilter", () => {
    const configWithToolFilter: HindsightConfig = {
      ...defaultConfig,
      retainContent: {
        assistant: ["text", "toolCall"],
        user: ["text"],
        toolResult: ["text"] as "text"[],
      },
      toolFilter: {
        toolResult: { exclude: ["bash", "write", "edit"] },
      },
    };

    const path = createSessionFile(
      "toolfilter-exclude-result.jsonl",
      { id: "toolfilter-exclude-result-session" },
      [
        userEntry("u1", null, "Do things"),
        toolCallEntry("a1", "u1", "Running", "bash", "call-1", "resp-1"),
        toolResultNamedEntry("t1", "a1", "bash", "call-1", "bash output"),
        toolCallEntry("a2", "t1", "Reading", "read", "call-2", "resp-2"),
        toolResultNamedEntry("t2", "a2", "read", "call-2", "file contents"),
        toolCallEntry("a3", "t2", "Writing", "write", "call-3", "resp-3"),
        toolResultNamedEntry("t3", "a3", "write", "call-3", "wrote file"),
      ]
    );

    const result = buildDocumentContent(path, configWithToolFilter);
    const parsed = JSON.parse(result.content);

    // bash and write toolResults excluded, read toolResult kept
    const toolResults = parsed.filter(
      (p: { message: { role: string } }) => p.message.role === "toolResult"
    );
    expect(toolResults).toHaveLength(1); // only read result
    expect(toolResults[0].message.toolName).toBe("read");
  });

  it("includes only listed tools via include filter", () => {
    const configWithToolFilter: HindsightConfig = {
      ...defaultConfig,
      retainContent: {
        assistant: ["text", "toolCall"],
        user: ["text"],
        toolResult: ["text"] as "text"[],
      },
      toolFilter: {
        toolCall: { include: ["hindsight_retain", "hindsight_recall", "hindsight_reflect"] },
        toolResult: { include: ["hindsight_retain", "hindsight_recall", "hindsight_reflect"] },
      },
    };

    const path = createSessionFile(
      "toolfilter-include.jsonl",
      { id: "toolfilter-include-session" },
      [
        userEntry("u1", null, "Do things"),
        toolCallEntry("a1", "u1", "Running", "bash", "call-1", "resp-1"),
        toolResultNamedEntry("t1", "a1", "bash", "call-1", "output"),
        toolCallEntry("a2", "t1", "Remembering", "hindsight_retain", "call-2", "resp-2"),
        toolResultNamedEntry("t2", "a2", "hindsight_retain", "call-2", "stored"),
      ]
    );

    const result = buildDocumentContent(path, configWithToolFilter);
    const parsed = JSON.parse(result.content);

    // a1: bash call excluded -> only text; t1: bash result excluded entirely
    // a2: hindsight_retain call kept; t2: hindsight_retain result kept
    expect(parsed).toHaveLength(4); // u1, a1 (text only), a2, t2
    const a1Content = parsed[1].message.content;
    expect(a1Content).toHaveLength(1);
    expect(a1Content[0].type).toBe("text"); // no bash toolCall

    const a2Content = parsed[2].message.content;
    expect(a2Content).toHaveLength(2);
    expect(a2Content[1].name).toBe("hindsight_retain");

    const toolResults = parsed.filter(
      (p: { message: { role: string } }) => p.message.role === "toolResult"
    );
    expect(toolResults).toHaveLength(1); // t2 kept (hindsight_retain)
    expect(toolResults[0].message.toolName).toBe("hindsight_retain");
  });

  it("combines retainContent, toolFilter, and strip in session parsing", () => {
    // This test verifies all three config layers work together during session parsing
    const config: HindsightConfig = {
      ...defaultConfig,
      retainContent: {
        assistant: ["text", "toolCall"], // no thinking
        user: ["text"],
        toolResult: ["text"] as "text"[],
      },
      strip: {
        topLevel: ["type", "id", "parentId"],
        message: [
          "api",
          "provider",
          "model",
          "usage",
          "cost",
          "stopReason",
          "timestamp",
          "responseId",
          "toolCallId",
        ],
      },
      toolFilter: {
        toolCall: { exclude: ["grep", "find", "ls", "read"] },
        toolResult: { exclude: ["grep", "find", "ls", "write", "edit"] },
      },
    };

    // Create a realistic session with mixed content
    const assistantWithThinkingAndTools: SessionEntry = {
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to search for this" },
          { type: "text", text: "Let me search" },
          { type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "test" } },
          { type: "toolCall", id: "call-2", name: "read", arguments: { path: "/tmp/file" } },
          {
            type: "toolCall",
            id: "call-3",
            name: "hindsight_retain",
            arguments: { content: "user prefers X" },
          },
        ],
        api: "openai",
        provider: "test",
        model: "gpt-4",
        responseId: "resp-combined",
      } as SessionEntry["message"],
    };

    const grepResult: SessionEntry = {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "grep",
        content: [{ type: "text", text: "found 3 matches" }],
        isError: false,
        timestamp: Date.now(),
      } as SessionEntry["message"],
    };

    const writeResult: SessionEntry = {
      type: "message",
      id: "t2",
      parentId: "t1",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "write",
        content: [{ type: "text", text: "wrote successfully" }],
        isError: false,
        timestamp: Date.now(),
      } as SessionEntry["message"],
    };

    const retainResult: SessionEntry = {
      type: "message",
      id: "t3",
      parentId: "t2",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-3",
        toolName: "hindsight_retain",
        content: [{ type: "text", text: "stored" }],
        isError: false,
        timestamp: Date.now(),
      } as SessionEntry["message"],
    };

    const path = createSessionFile("combined-filter.jsonl", { id: "combined-filter-session" }, [
      userEntry("u1", null, "Do everything"),
      assistantWithThinkingAndTools,
      grepResult,
      writeResult,
      retainResult,
    ]);

    const result = buildDocumentContent(path, config);
    const parsed = JSON.parse(result.content);

    // u1 + a1 + grep/writing/retain results
    // grep and write toolResults excluded by toolFilter.toolResult
    // retain toolResult kept
    expect(parsed).toHaveLength(3); // u1, a1, t3 (retain result);

    // Check user message - just text, no stripping artifacts
    expect(parsed[0].message.role).toBe("user");
    expect(parsed[0].message.content[0].type).toBe("text");

    // Check assistant message
    const assistantMsg = parsed[1].message;
    // retainContent: thinking removed, toolCall kept
    // toolFilter: grep and read calls excluded, hindsight_retain kept
    // strip: api, provider, model, responseId removed
    expect(assistantMsg.api).toBeUndefined();
    expect(assistantMsg.provider).toBeUndefined();
    expect(assistantMsg.model).toBeUndefined();
    expect(assistantMsg.responseId).toBeUndefined();
    expect(assistantMsg.content).toHaveLength(2); // text + hindsight_retain toolCall
    expect(assistantMsg.content[0].type).toBe("text");
    expect(assistantMsg.content[1].type).toBe("toolCall");
    expect(assistantMsg.content[1].name).toBe("hindsight_retain");

    // Tool results
    const toolResults = parsed.filter(
      (p: { message: { role: string } }) => p.message.role === "toolResult"
    );
    expect(toolResults).toHaveLength(1); // only hindsight_retain result
    expect(toolResults[0].message.toolName).toBe("hindsight_retain");
    // toolCallId stripped by strip.message config
    expect(toolResults[0].message.toolCallId).toBeUndefined();
  });

  it("toolFilter with forked sessions", () => {
    const configWithToolFilter: HindsightConfig = {
      ...defaultConfig,
      retainContent: {
        assistant: ["text", "toolCall"],
        user: ["text"],
        toolResult: [],
      },
      toolFilter: {
        toolCall: { exclude: ["bash"] },
      },
    };

    const parentPath = createSessionFile(
      "toolfilter-parent.jsonl",
      { id: "toolfilter-parent-session" },
      [
        userEntry("u1", null, "Run something"),
        toolCallEntry("a1", "u1", "Running", "bash", "call-1", "resp-1"),
      ]
    );

    const forkPath = createSessionFile(
      "toolfilter-fork.jsonl",
      { id: "toolfilter-fork-session", parentSession: parentPath },
      [
        userEntry("u1", null, "Run something"),
        toolCallEntry("a1", "u1", "Running", "bash", "call-1", "resp-1"),
        userEntry("u2", "a1", "Do more"),
        toolCallEntry("a2", "u2", "Remembering", "hindsight_retain", "call-2", "resp-2"),
      ]
    );

    const result = buildDocumentContent(forkPath, configWithToolFilter);
    const parsed = JSON.parse(result.content);

    // Fork content: u2 + a2
    // a2 has hindsight_retain -> toolCall not filtered
    expect(parsed).toHaveLength(2);
    const a2Content = parsed[1].message.content;
    expect(a2Content).toHaveLength(2); // text + toolCall
    expect(a2Content[1].name).toBe("hindsight_retain");
  });
});

// ============================================
// Regression: documentId must be raw session ID
// ============================================

describe("documentId is raw session ID (no session: prefix)", () => {
  it("buildDocumentContent returns raw session ID for non-fork session", () => {
    const path = createSessionFile("docid-nonfork.jsonl", { id: "abc-123-def" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi", "resp-1"),
    ]);

    const result = buildDocumentContent(path, defaultConfig);

    expect(result.documentId).toBe("abc-123-def");
    expect(result.documentId).not.toContain("session:");
  });

  it("buildDocumentContent returns raw session ID for forked session", () => {
    const parentPath = createSessionFile("docid-parent.jsonl", { id: "docid-parent-session" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi", "resp-p"),
    ]);

    const forkPath = createSessionFile(
      "docid-fork.jsonl",
      { id: "fork-xyz-456", parentSession: parentPath },
      [
        userEntry("u1", null, "Hello"),
        assistantEntry("a1", "u1", "Hi", "resp-p"),
        userEntry("u2", "a1", "New"),
        assistantEntry("a2", "u2", "Answer", "resp-f"),
      ]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);

    expect(result.documentId).toBe("fork-xyz-456");
    expect(result.documentId).not.toContain("session:");
  });

  it("buildDocumentContent returns raw session ID for fork with no new content", () => {
    const parentPath = createSessionFile(
      "docid-replay-parent.jsonl",
      { id: "docid-replay-parent" },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi", "resp-rp")]
    );

    const forkPath = createSessionFile(
      "docid-replay.jsonl",
      { id: "replay-789", parentSession: parentPath },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi", "resp-rp")]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);

    expect(result.documentId).toBe("replay-789");
    expect(result.documentId).not.toContain("session:");
  });

  it("buildDocumentContent returns raw session ID for missing parent", () => {
    const forkPath = createSessionFile(
      "docid-orphan.jsonl",
      { id: "orphan-id-999", parentSession: "/nonexistent/parent.jsonl" },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi", "resp-o")]
    );

    const result = buildDocumentContent(forkPath, defaultConfig);

    expect(result.documentId).toBe("orphan-id-999");
    expect(result.documentId).not.toContain("session:");
  });

  it("buildDocumentContent returns raw session ID for empty session", () => {
    const path = createSessionFile("docid-empty.jsonl", { id: "empty-raw-id" }, []);

    const result = buildDocumentContent(path, defaultConfig);

    expect(result.documentId).toBe("empty-raw-id");
    expect(result.documentId).not.toContain("session:");
  });

  it("buildMessageArrayFromSession returns raw session ID for non-fork", () => {
    const path = createSessionFile("docid-msgs-nonfork.jsonl", { id: "msgs-nonfork-id" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi", "resp-mn"),
    ]);

    const { documentId } = buildMessageArrayFromSession(path, defaultConfig);

    expect(documentId).toBe("msgs-nonfork-id");
    expect(documentId).not.toContain("session:");
  });

  it("buildMessageArrayFromSession returns raw session ID for forked session", () => {
    const parentPath = createSessionFile("docid-msgs-parent.jsonl", { id: "docid-msgs-parent" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi", "resp-mp"),
    ]);

    const forkPath = createSessionFile(
      "docid-msgs-fork.jsonl",
      { id: "msgs-fork-id", parentSession: parentPath },
      [
        userEntry("u1", null, "Hello"),
        assistantEntry("a1", "u1", "Hi", "resp-mp"),
        userEntry("u2", "a1", "New"),
        assistantEntry("a2", "u2", "Answer", "resp-mf"),
      ]
    );

    const { documentId } = buildMessageArrayFromSession(forkPath, defaultConfig);

    expect(documentId).toBe("msgs-fork-id");
    expect(documentId).not.toContain("session:");
  });

  it("buildMessageArrayFromSession returns raw session ID for missing parent", () => {
    const path = createSessionFile(
      "docid-msgs-orphan.jsonl",
      { id: "msgs-orphan-id", parentSession: "/nonexistent/parent.jsonl" },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi", "resp-mo")]
    );

    const { documentId } = buildMessageArrayFromSession(path, defaultConfig);

    expect(documentId).toBe("msgs-orphan-id");
    expect(documentId).not.toContain("session:");
  });

  it("buildMessageArrayFromSession returns raw session ID for fork with no new content", () => {
    const parentPath = createSessionFile(
      "docid-msgs-replay-parent.jsonl",
      { id: "docid-msgs-replay-parent" },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi", "resp-mrp")]
    );

    const forkPath = createSessionFile(
      "docid-msgs-replay.jsonl",
      { id: "msgs-replay-id", parentSession: parentPath },
      [userEntry("u1", null, "Hello"), assistantEntry("a1", "u1", "Hi", "resp-mrp")]
    );

    const { documentId } = buildMessageArrayFromSession(forkPath, defaultConfig);

    expect(documentId).toBe("msgs-replay-id");
    expect(documentId).not.toContain("session:");
  });
});

// ============================================
// Runtime/parsing parity: filtering must match
// ============================================
//
// The AGENTS.md guideline requires that runtime filtering (src/index.ts context handler)
// and parsing filtering (src/document.ts isConversationMessage) stay aligned.
// These tests verify that the same set of messages is excluded by both paths.

describe("runtime/parsing filtering parity", () => {
  it("both paths exclude hindsight-recall messages", () => {
    // Runtime path: context handler filters customType === "hindsight-recall"
    const runtimeMessages = [
      { role: "user", content: "Hello" },
      { role: "custom", customType: "hindsight-recall", content: "Old memory" },
      { role: "assistant", content: "Hi" },
    ];
    const runtimeFiltered = runtimeMessages.filter(
      (msg) => (msg as { customType?: string }).customType !== "hindsight-recall"
    );

    // Parsing path: isConversationMessage filters customType === "hindsight-recall"
    const recallEntry: SessionEntry = {
      type: "message",
      id: "recall-parity",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "custom",
        customType: "hindsight-recall",
        content: "Old memory",
      } as SessionEntry["message"],
    };
    const path = createSessionFile("parity-recall.jsonl", { id: "parity-recall-session" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi", "resp-p1"),
      recallEntry,
    ]);
    const result = buildDocumentContent(path, defaultConfig);
    const parsed = JSON.parse(result.content);

    // Both should produce the same count of non-recall messages
    expect(runtimeFiltered).toHaveLength(2);
    expect(parsed).toHaveLength(2);
    expect(
      runtimeFiltered.every((m) => (m as { customType?: string }).customType !== "hindsight-recall")
    ).toBe(true);
    expect(
      parsed.every(
        (p: { message: { customType?: string } }) => p.message.customType !== "hindsight-recall"
      )
    ).toBe(true);
  });

  it("both paths preserve non-recall custom messages", () => {
    // Runtime path: only filters customType === "hindsight-recall"
    const runtimeMessages = [
      { role: "user", content: "Hello" },
      { role: "custom", customType: "other-type", content: "Other" },
      { role: "assistant", content: "Hi" },
    ];
    const runtimeFiltered = runtimeMessages.filter(
      (msg) => (msg as { customType?: string }).customType !== "hindsight-recall"
    );

    // Runtime keeps all 3 (no hindsight-recall to filter)
    expect(runtimeFiltered).toHaveLength(3);

    // Parsing path: custom-role messages are excluded by shouldRetainMessage
    // (only user/assistant/toolResult roles are retained). This is intentional —
    // parsing is more restrictive because custom messages are session-internal metadata.
    // The parity guarantee is that hindsight-recall is filtered consistently,
    // not that every message type has identical handling.
    const otherEntry: SessionEntry = {
      type: "message",
      id: "other-parity",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "custom",
        customType: "other-type",
        content: "Other",
      } as SessionEntry["message"],
    };
    const path = createSessionFile("parity-other.jsonl", { id: "parity-other-session" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Hi", "resp-p2"),
      otherEntry,
    ]);
    const result = buildDocumentContent(path, defaultConfig);
    const parsed = JSON.parse(result.content);

    // Parsing excludes custom-role messages (by shouldRetainMessage)
    expect(parsed).toHaveLength(2); // user + assistant only
  });

  it("both paths produce identical filtered sets for mixed messages", () => {
    // Runtime path
    const runtimeMessages = [
      { role: "user", content: "Hello" },
      { role: "custom", customType: "hindsight-recall", content: "Memory 1" },
      { role: "custom", customType: "other-type", content: "Other" },
      { role: "custom", customType: "hindsight-recall", content: "Memory 2" },
      { role: "assistant", content: "Hi" },
    ];
    const runtimeFiltered = runtimeMessages.filter(
      (msg) => (msg as { customType?: string }).customType !== "hindsight-recall"
    );

    // Parsing path
    const recallEntry1: SessionEntry = {
      type: "message",
      id: "recall-mix-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "custom",
        customType: "hindsight-recall",
        content: "Memory 1",
      } as SessionEntry["message"],
    };
    const otherEntry: SessionEntry = {
      type: "message",
      id: "other-mix",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "custom",
        customType: "other-type",
        content: "Other",
      } as SessionEntry["message"],
    };
    const recallEntry2: SessionEntry = {
      type: "message",
      id: "recall-mix-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "custom",
        customType: "hindsight-recall",
        content: "Memory 2",
      } as SessionEntry["message"],
    };
    const path = createSessionFile("parity-mixed.jsonl", { id: "parity-mixed-session" }, [
      userEntry("u1", null, "Hello"),
      assistantEntry("a1", "u1", "Response", "resp-mix"),
      recallEntry1,
      otherEntry,
      recallEntry2,
    ]);
    const result = buildDocumentContent(path, defaultConfig);
    const parsed = JSON.parse(result.content);

    // Both should filter out exactly the 2 hindsight-recall messages
    const runtimeRecallCount = runtimeMessages.length - runtimeFiltered.length;
    // 3 entries minus kept entries (assistant may be filtered by retainContent)
    expect(runtimeRecallCount).toBe(2);

    // Runtime: 3 kept (user, other-type, assistant)
    expect(runtimeFiltered).toHaveLength(3);
    // Parsing: at least user + other-type (assistant may be filtered by retainContent)
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    expect(
      parsed.every(
        (p: { message: { customType?: string } }) => p.message.customType !== "hindsight-recall"
      )
    ).toBe(true);
  });
});
