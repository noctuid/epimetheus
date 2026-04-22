/**
 * Unit tests for utility functions.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractParentSessionId,
  extractTextFromContent,
  getSessionDisplayName,
  truncate,
} from "../src/utils";

describe("truncate", () => {
  it("returns string unchanged if shorter than maxChars", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns string unchanged if equal to maxChars", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates with ellipsis for strings longer than maxChars", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("handles maxChars of 1 (just ellipsis)", () => {
    expect(truncate("hello", 1)).toBe("…");
  });

  it("returns string unchanged for maxChars <= 0", () => {
    expect(truncate("hello", 0)).toBe("hello");
    expect(truncate("hello", -1)).toBe("hello");
  });

  it("handles multi-byte Unicode correctly", () => {
    // Emoji is 1 code point (but 2 UTF-16 code units)
    const str = "😀😀😀😀😀"; // 5 emojis = 5 code points
    expect(truncate(str, 3)).toBe("😀😀…");
    expect(truncate(str, 1)).toBe("…");
  });

  it("does not split surrogate pairs", () => {
    const str = "a😀b"; // 3 code points: a, 😀, b
    const result = truncate(str, 3);
    // 3 code points fits in maxChars=3, no truncation
    expect(result).toBe("a😀b");
    expect([...result].length).toBe(3);
  });
});

describe("extractParentSessionId", () => {
  const testDir = join(tmpdir(), "pi-hindsight-test");

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns undefined for undefined path", () => {
    expect(extractParentSessionId(undefined)).toBe(undefined);
  });

  it("extracts ID from valid session file", () => {
    const sessionPath = join(testDir, "session.jsonl");
    const header = JSON.stringify({
      type: "session",
      id: "test-session-id",
      timestamp: "2024-01-01T00:00:00Z",
      cwd: "/test",
    });
    writeFileSync(sessionPath, `${header}\n`);

    const result = extractParentSessionId(sessionPath);
    expect(result).toBe("test-session-id");
  });

  it("returns undefined for file without session type", () => {
    const sessionPath = join(testDir, "invalid.jsonl");
    writeFileSync(sessionPath, `${JSON.stringify({ id: "test-id" })}\n`);

    const result = extractParentSessionId(sessionPath);
    expect(result).toBe(undefined);
  });

  it("returns undefined for malformed JSON", () => {
    const sessionPath = join(testDir, "malformed.jsonl");
    writeFileSync(sessionPath, "not json\n");

    const result = extractParentSessionId(sessionPath);
    expect(result).toBe(undefined);
  });

  it("returns undefined for empty file", () => {
    const sessionPath = join(testDir, "empty.jsonl");
    writeFileSync(sessionPath, "");

    const result = extractParentSessionId(sessionPath);
    expect(result).toBe(undefined);
  });

  it("extracts ID from path when file doesn't exist", () => {
    const result = extractParentSessionId(
      "/nonexistent/550e8400-e29b-41d4-a716-446655440000.jsonl"
    );
    expect(result).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("returns undefined for non-existent file without UUID in path", () => {
    expect(extractParentSessionId("/nonexistent/path.jsonl")).toBe(undefined);
  });
});

describe("extractTextFromContent", () => {
  it("returns string content as-is", () => {
    expect(extractTextFromContent("hello")).toBe("hello");
  });

  it("returns null for empty string", () => {
    expect(extractTextFromContent("")).toBe(null);
  });

  it("returns null for non-array, non-string content", () => {
    expect(extractTextFromContent(null)).toBe(null);
    expect(extractTextFromContent(undefined)).toBe(null);
    expect(extractTextFromContent({})).toBe(null);
  });

  it("extracts text from single text block", () => {
    const content = [{ type: "text", text: "hello" }];
    expect(extractTextFromContent(content)).toBe("hello");
  });

  it("joins multiple text blocks with newline", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromContent(content)).toBe("hello\nworld");
  });

  it("ignores non-text blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "image", source: { data: "abc" } },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromContent(content)).toBe("hello\nworld");
  });

  it("returns null for array with no text blocks", () => {
    const content = [{ type: "image", source: { data: "abc" } }];
    expect(extractTextFromContent(content)).toBe(null);
  });

  it("returns null for empty array", () => {
    expect(extractTextFromContent([])).toBe(null);
  });
});

describe("getSessionDisplayName", () => {
  it("returns session name if set", () => {
    const result = getSessionDisplayName(
      () => "My Session",
      () => []
    );
    expect(result).toBe("My Session");
  });

  it("falls back to first user message", () => {
    const entries = [
      { type: "message", message: { role: "assistant", content: "hi" } },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Hello world" }] },
      },
    ];
    const result = getSessionDisplayName(
      () => undefined,
      () => entries
    );
    expect(result).toBe("Hello world");
  });

  it("extracts text from string content for first user message", () => {
    const entries = [{ type: "message", message: { role: "user", content: "Simple text" } }];
    const result = getSessionDisplayName(
      () => undefined,
      () => entries
    );
    expect(result).toBe("Simple text");
  });

  it("returns Untitled if no name or user message", () => {
    const result = getSessionDisplayName(
      () => undefined,
      () => []
    );
    expect(result).toBe("Untitled");
  });

  it("returns Untitled if user message has no text content", () => {
    const entries = [{ type: "message", message: { role: "user", content: [{ type: "image" }] } }];
    const result = getSessionDisplayName(
      () => undefined,
      () => entries
    );
    expect(result).toBe("Untitled");
  });

  it("prefers session name over first user message", () => {
    const entries = [{ type: "message", message: { role: "user", content: "First message" } }];
    const result = getSessionDisplayName(
      () => "Custom Title",
      () => entries
    );
    expect(result).toBe("Custom Title");
  });

  it("truncates long first user message to 100 characters", () => {
    const longText = "a".repeat(150);
    const entries = [{ type: "message", message: { role: "user", content: longText } }];
    const result = getSessionDisplayName(
      () => undefined,
      () => entries
    );
    expect(result.length).toBe(100);
    expect(result.endsWith("…")).toBe(true);
  });
});
