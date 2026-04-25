/**
 * Unit tests for prepare utilities.
 */

import { describe, expect, it } from "bun:test";
import type { HindsightConfig, RetainContent, ToolFilter } from "../src/config";
import { filterContent, passesToolFilter, prepareEntry, shouldRetainMessage } from "../src/prepare";

// Uses a Pick<> subset of HindsightConfig since prepare functions only need
// retainContent, strip, and toolFilter (not the full runtime config).
const defaultConfig: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter"> = {
  retainContent: {
    assistant: ["text", "thinking", "toolCall"],
    user: ["text"],
    toolResult: [],
  },
  strip: {
    topLevel: ["type", "id", "parentId"],
    message: ["api", "provider", "model", "usage", "cost", "stopReason", "timestamp", "responseId"],
  },
  toolFilter: {},
};

describe("shouldRetainMessage", () => {
  it("returns true for user messages", () => {
    expect(shouldRetainMessage({ role: "user", content: [] }, defaultConfig.retainContent)).toBe(
      true
    );
  });

  it("returns true for assistant messages", () => {
    expect(
      shouldRetainMessage({ role: "assistant", content: [] }, defaultConfig.retainContent)
    ).toBe(true);
  });

  it("returns false for toolResult by default", () => {
    expect(
      shouldRetainMessage({ role: "toolResult", content: [] }, defaultConfig.retainContent)
    ).toBe(false);
  });

  it("returns true for toolResult when configured", () => {
    const configWithTools: RetainContent = {
      ...defaultConfig.retainContent,
      toolResult: ["text"] as "text"[],
    };
    expect(shouldRetainMessage({ role: "toolResult", content: [] }, configWithTools)).toBe(true);
  });

  it("returns false for unknown roles", () => {
    expect(shouldRetainMessage({ role: "system", content: [] }, defaultConfig.retainContent)).toBe(
      false
    );
  });
});

describe("filterContent", () => {
  it("filters assistant content by allowed types", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "Internal" },
      { type: "toolCall", id: "call-1", name: "read" },
    ];

    const filtered = filterContent(content, "assistant", defaultConfig.retainContent);
    expect(filtered).toHaveLength(3);
  });

  it("excludes thinking when not in allowed types", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "Internal" },
    ];

    const configNoThinking: RetainContent = {
      ...defaultConfig.retainContent,
      assistant: ["text"] as "text"[],
    };

    const filtered = filterContent(content, "assistant", configNoThinking);
    expect(filtered).toHaveLength(1);
    expect((filtered as unknown[])[0]).toEqual({ type: "text", text: "Hello" });
  });

  it("excludes images from user by default", () => {
    const content = [
      { type: "text", text: "Look at this" },
      { type: "image", source: { type: "base64", data: "abc" } },
    ];

    const filtered = filterContent(content, "user", defaultConfig.retainContent);
    expect(filtered).toHaveLength(1);
    expect((filtered as unknown[])[0]).toEqual({ type: "text", text: "Look at this" });
  });

  it("includes images when configured", () => {
    const content = [
      { type: "text", text: "Look at this" },
      { type: "image", source: { type: "base64", data: "abc" } },
    ];

    const configWithImages: RetainContent = {
      ...defaultConfig.retainContent,
      user: ["text", "image"] as ("text" | "image")[],
    };

    const filtered = filterContent(content, "user", configWithImages);
    expect(filtered).toHaveLength(2);
  });

  it("returns non-array content unchanged", () => {
    const content = "plain text";
    expect(filterContent(content, "user", defaultConfig.retainContent)).toBe("plain text");
  });
});

describe("prepareEntry", () => {
  it("strips top-level fields", () => {
    const entry = {
      type: "message",
      id: "msg-123",
      parentId: "msg-122",
      timestamp: "2026-04-10T12:00:00Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    };

    const stripped = prepareEntry(entry, defaultConfig);

    expect(stripped.type).toBeUndefined();
    expect(stripped.id).toBeUndefined();
    expect(stripped.parentId).toBeUndefined();
    expect(stripped.timestamp).toBe("2026-04-10T12:00:00Z");
  });

  it("strips message-level fields", () => {
    const entry = {
      type: "message",
      id: "msg-123",
      timestamp: "2026-04-10T12:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        api: "openai-completions",
        provider: "synthetic",
        model: "gpt-4",
        usage: { input: 10, output: 20 },
        cost: { total: 0.01 },
        stopReason: "stop",
        timestamp: 1234567890,
        responseId: "resp-123",
      },
    };

    const stripped = prepareEntry(entry, defaultConfig);
    const msg = stripped.message as Record<string, unknown>;

    expect(msg.api).toBeUndefined();
    expect(msg.provider).toBeUndefined();
    expect(msg.model).toBeUndefined();
    expect(msg.usage).toBeUndefined();
    expect(msg.cost).toBeUndefined();
    expect(msg.stopReason).toBeUndefined();
    expect(msg.timestamp).toBeUndefined();
    expect(msg.responseId).toBeUndefined();
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBeDefined();
  });

  it("filters content before stripping fields", () => {
    const entry = {
      type: "message",
      id: "msg-123",
      timestamp: "2026-04-10T12:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "Internal" },
        ],
      },
    };

    const configNoThinking: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter"> = {
      retainContent: {
        ...defaultConfig.retainContent,
        assistant: ["text"] as "text"[],
      },
      strip: defaultConfig.strip,
      toolFilter: {},
    };

    const stripped = prepareEntry(entry, configNoThinking);
    const content = (stripped.message as Record<string, unknown>).content as unknown[];

    expect(content).toHaveLength(1);
    expect((content[0] as { type: string }).type).toBe("text");
  });

  it("does not mutate original object", () => {
    const entry = {
      type: "message",
      id: "msg-123",
      message: {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    };

    const stripped = prepareEntry(entry, defaultConfig);

    expect(entry.type).toBe("message");
    expect(entry.id).toBe("msg-123");
    expect(stripped.type).toBeUndefined();
  });

  it("handles entries without message", () => {
    const entry = {
      type: "compaction",
      id: "comp-123",
      timestamp: "2026-04-10T12:00:00Z",
    };

    const stripped = prepareEntry(entry, defaultConfig);

    expect(stripped.type).toBeUndefined();
    expect(stripped.id).toBeUndefined();
    expect(stripped.timestamp).toBe("2026-04-10T12:00:00Z");
  });
});

describe("passesToolFilter", () => {
  it("passes when include list contains the tool name", () => {
    const filter = { include: ["hindsight_retain", "hindsight_recall"] };
    expect(passesToolFilter("hindsight_retain", filter)).toBe(true);
  });

  it("fails when include list does not contain the tool name", () => {
    const filter = { include: ["hindsight_retain", "hindsight_recall"] };
    expect(passesToolFilter("bash", filter)).toBe(false);
  });

  it("passes when exclude list does not contain the tool name", () => {
    const filter = { exclude: ["bash", "read"] };
    expect(passesToolFilter("hindsight_retain", filter)).toBe(true);
  });

  it("fails when exclude list contains the tool name", () => {
    const filter = { exclude: ["bash", "read"] };
    expect(passesToolFilter("bash", filter)).toBe(false);
  });

  it("include with empty list matches nothing", () => {
    const filter = { include: [] };
    expect(passesToolFilter("bash", filter)).toBe(false);
    expect(passesToolFilter("hindsight_retain", filter)).toBe(false);
  });

  it("exclude with empty list matches everything", () => {
    const filter = { exclude: [] };
    expect(passesToolFilter("bash", filter)).toBe(true);
    expect(passesToolFilter("hindsight_retain", filter)).toBe(true);
  });
});

describe("shouldRetainMessage with toolFilter", () => {
  const retainContentWithTools: RetainContent = {
    assistant: ["text", "toolCall"],
    user: ["text"],
    toolResult: ["text"] as "text"[],
  };

  it("returns false for excluded toolResult by tool name", () => {
    const toolFilter: ToolFilter = {
      toolResult: { exclude: ["bash"] },
    };
    expect(
      shouldRetainMessage(
        { role: "toolResult", toolName: "bash", content: [] },
        retainContentWithTools,
        toolFilter
      )
    ).toBe(false);
  });

  it("returns true for non-excluded toolResult by tool name", () => {
    const toolFilter: ToolFilter = {
      toolResult: { exclude: ["bash"] },
    };
    expect(
      shouldRetainMessage(
        { role: "toolResult", toolName: "hindsight_retain", content: [] },
        retainContentWithTools,
        toolFilter
      )
    ).toBe(true);
  });

  it("returns false for toolResult not in include list", () => {
    const toolFilter: ToolFilter = {
      toolResult: { include: ["read"] },
    };
    expect(
      shouldRetainMessage(
        { role: "toolResult", toolName: "bash", content: [] },
        retainContentWithTools,
        toolFilter
      )
    ).toBe(false);
  });

  it("returns true for toolResult in include list", () => {
    const toolFilter: ToolFilter = {
      toolResult: { include: ["read"] },
    };
    expect(
      shouldRetainMessage(
        { role: "toolResult", toolName: "read", content: [] },
        retainContentWithTools,
        toolFilter
      )
    ).toBe(true);
  });

  it("returns true for toolResult without toolName when no toolResult filter", () => {
    expect(shouldRetainMessage({ role: "toolResult", content: [] }, retainContentWithTools)).toBe(
      true
    );
  });

  it("returns true for toolResult without toolName when toolFilter.toolResult is active", () => {
    // If toolName is missing, we can't determine the tool, so fail-open (retain)
    const toolFilter: ToolFilter = {
      toolResult: { exclude: ["bash"] },
    };
    expect(
      shouldRetainMessage({ role: "toolResult", content: [] }, retainContentWithTools, toolFilter)
    ).toBe(true);
  });

  it("returns true for toolResult without toolName with include filter", () => {
    // Same fail-open behavior with include filter
    const toolFilter: ToolFilter = {
      toolResult: { include: ["read"] },
    };
    expect(
      shouldRetainMessage({ role: "toolResult", content: [] }, retainContentWithTools, toolFilter)
    ).toBe(true);
  });

  it("returns true for user/assistant regardless of toolFilter", () => {
    const toolFilter: ToolFilter = {
      toolCall: { exclude: ["bash"] },
      toolResult: { exclude: ["bash"] },
    };
    expect(
      shouldRetainMessage({ role: "user", content: [] }, retainContentWithTools, toolFilter)
    ).toBe(true);
    expect(
      shouldRetainMessage({ role: "assistant", content: [] }, retainContentWithTools, toolFilter)
    ).toBe(true);
  });
});

describe("filterContent with toolFilter", () => {
  const retainContentWithTools: RetainContent = {
    assistant: ["text", "toolCall"],
    user: ["text"],
    toolResult: ["text"] as "text"[],
  };

  it("excludes toolCall blocks by tool name via exclude filter", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      { type: "toolCall", id: "call-2", name: "hindsight_retain", arguments: {} },
    ];

    const toolFilter: ToolFilter = {
      toolCall: { exclude: ["bash"] },
    };

    const filtered = filterContent(content, "assistant", retainContentWithTools, toolFilter);
    expect(filtered).toHaveLength(2);
    expect((filtered as unknown[])[0]).toEqual({ type: "text", text: "Hello" });
    expect((filtered as unknown[])[1]).toEqual({
      type: "toolCall",
      id: "call-2",
      name: "hindsight_retain",
      arguments: {},
    });
  });

  it("includes only listed toolCall blocks via include filter", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      { type: "toolCall", id: "call-2", name: "hindsight_retain", arguments: {} },
    ];

    const toolFilter: ToolFilter = {
      toolCall: { include: ["hindsight_retain"] },
    };

    const filtered = filterContent(content, "assistant", retainContentWithTools, toolFilter);
    expect(filtered).toHaveLength(2);
    expect((filtered as unknown[])[0]).toEqual({ type: "text", text: "Hello" });
    expect((filtered as unknown[])[1]).toEqual({
      type: "toolCall",
      id: "call-2",
      name: "hindsight_retain",
      arguments: {},
    });
  });

  it("does not affect non-toolCall blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "I should run bash" },
    ];

    const retainContentWithThinking: RetainContent = {
      ...retainContentWithTools,
      assistant: ["text", "thinking", "toolCall"],
    };

    const toolFilter: ToolFilter = {
      toolCall: { exclude: ["bash"] },
    };

    const filtered = filterContent(content, "assistant", retainContentWithThinking, toolFilter);
    // thinking block is unaffected by toolFilter
    expect(filtered).toHaveLength(2);
  });

  it("passes all toolCall blocks when no toolCall filter", () => {
    const content = [
      { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      { type: "toolCall", id: "call-2", name: "read", arguments: {} },
    ];

    const toolFilter: ToolFilter = {
      toolResult: { exclude: ["bash"] }, // only toolResult filter
    };

    const filtered = filterContent(content, "assistant", retainContentWithTools, toolFilter);
    expect(filtered).toHaveLength(2);
  });

  it("passes all blocks when toolFilter is empty", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
    ];

    const filtered = filterContent(content, "assistant", retainContentWithTools, {});
    expect(filtered).toHaveLength(2);
  });

  it("passes toolCall blocks without name field", () => {
    const content = [
      { type: "toolCall", id: "call-1" }, // no name field
    ];

    const toolFilter: ToolFilter = {
      toolCall: { exclude: ["bash"] },
    };

    // toolCall without name should pass (can't determine tool)
    const filtered = filterContent(content, "assistant", retainContentWithTools, toolFilter);
    expect(filtered).toHaveLength(1);
  });

  it("passes toolCall blocks without name field with include filter", () => {
    const content = [
      { type: "toolCall", id: "call-1" }, // no name field
    ];

    const toolFilter: ToolFilter = {
      toolCall: { include: ["read"] },
    };

    // toolCall without name should pass (can't determine tool, fail-open)
    const filtered = filterContent(content, "assistant", retainContentWithTools, toolFilter);
    expect(filtered).toHaveLength(1);
  });
});

describe("prepareEntry with toolFilter", () => {
  it("filters toolCall blocks by tool name", () => {
    const entry = {
      type: "message",
      id: "msg-123",
      timestamp: "2026-04-10T12:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
          {
            type: "toolCall",
            id: "call-2",
            name: "hindsight_retain",
            arguments: { content: "fact" },
          },
        ],
      },
    };

    const configWithToolFilter: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter"> = {
      retainContent: {
        assistant: ["text", "toolCall"],
        user: ["text"],
        toolResult: ["text"] as "text"[],
      },
      strip: defaultConfig.strip,
      toolFilter: {
        toolCall: { exclude: ["bash"] },
      },
    };

    const stripped = prepareEntry(entry, configWithToolFilter);
    const content = (stripped.message as Record<string, unknown>).content as unknown[];

    expect(content).toHaveLength(2);
    expect((content[0] as { type: string }).type).toBe("text");
    expect((content[1] as { type: string; name: string }).type).toBe("toolCall");
    expect((content[1] as { type: string; name: string }).name).toBe("hindsight_retain");
  });

  it("combines retainContent, toolFilter, and strip", () => {
    const entry = {
      type: "message",
      id: "msg-456",
      parentId: "msg-455",
      timestamp: "2026-04-10T12:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to think" },
          { type: "text", text: "Let me check" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
          { type: "toolCall", id: "call-2", name: "read", arguments: { path: "/tmp" } },
        ],
        api: "openai",
        provider: "test",
        model: "gpt-4",
        responseId: "resp-123",
      },
    };

    const config: Pick<HindsightConfig, "retainContent" | "strip" | "toolFilter"> = {
      // retainContent excludes "thinking"
      retainContent: {
        assistant: ["text", "toolCall"],
        user: ["text"],
        toolResult: [],
      },
      // strip removes metadata fields and id/parentId
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
        ],
      },
      // toolFilter excludes bash tool calls
      toolFilter: {
        toolCall: { exclude: ["bash"] },
      },
    };

    const stripped = prepareEntry(entry, config);

    // Top-level stripping: type, id, parentId removed
    expect(stripped.type).toBeUndefined();
    expect(stripped.id).toBeUndefined();
    expect(stripped.parentId).toBeUndefined();
    expect(stripped.timestamp).toBe("2026-04-10T12:00:00Z");

    const msg = stripped.message as Record<string, unknown>;

    // Message-level stripping: api, provider, model, responseId removed
    expect(msg.api).toBeUndefined();
    expect(msg.provider).toBeUndefined();
    expect(msg.model).toBeUndefined();
    expect(msg.responseId).toBeUndefined();
    expect(msg.role).toBe("assistant");

    const content = msg.content as unknown[];

    // Content filtering: thinking removed (retainContent), bash toolCall removed (toolFilter)
    // Remaining: text + read toolCall
    expect(content).toHaveLength(2);
    expect((content[0] as { type: string }).type).toBe("text");
    expect((content[1] as { type: string; name: string }).type).toBe("toolCall");
    expect((content[1] as { type: string; name: string }).name).toBe("read");
  });
});
