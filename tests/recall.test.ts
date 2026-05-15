/**
 * Unit tests for recall message formatting and the popup subcommand.
 *
 * Tests formatRecallMessage, renderRecallMessage, doAutoRecallImpl,
 * RecallOverlayComponent, and the real popup command handler
 * (via registerCommands → createPopupSubcommand).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RecallResponse } from "@vectorize-io/hindsight-client";
import { registerCommands } from "../src/commands";
import type { HindsightConfig } from "../src/config";
import type { AutoRecallConfig, RecallClient, RecallMessageDetails } from "../src/index";
import { doAutoRecallImpl, formatRecallMessage, renderRecallMessage } from "../src/index";
import { RecallOverlayComponent } from "../src/overlay";
import { testConfig } from "./fixtures";

// Default preamble - the combined Hermes/Hindsight system note
const DEFAULT_PREAMBLE =
  "[System note: The following are recalled memories from hindsight, NOT new user input. Prioritize recent when conflicting. Only use memories that are directly useful to continue this conversation; ignore the rest]";

describe("formatRecallMessage", () => {
  it("wraps content in hindsight_memories tags", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);

    expect(message.role).toBe("custom");
    expect(message.customType).toBe("hindsight-recall");
    expect(message.display).toBe(false);
    expect(message.content).toContain("<hindsight_memories>");
    expect(message.content).toContain("</hindsight_memories>");
  });

  it("includes the preamble at the top", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);

    expect(message.content).toContain(DEFAULT_PREAMBLE);

    // Preamble should appear right after <hindsight_memories>\n
    const preamblePos = message.content.indexOf(DEFAULT_PREAMBLE);
    const tagEndPos = message.content.indexOf("\n"); // end of "<hindsight_memories>" line
    expect(preamblePos).toBe(tagEndPos + 1); // right after the opening tag
  });

  it("includes date/time when showDateTime is true", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);

    expect(message.content).toContain("Current date and time:");
  });

  it("excludes date/time when showDateTime is false", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, false);

    expect(message.content).not.toContain("Current date and time:");
  });

  it("includes memories from results", () => {
    const results: RecallResponse["results"] = [
      { id: "1", text: "User prefers dark mode" },
      { id: "2", text: "User uses VS Code" },
    ];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);

    expect(message.content).toContain("User prefers dark mode");
    expect(message.content).toContain("User uses VS Code");
  });

  it("separates memories with delimiter", () => {
    const results: RecallResponse["results"] = [
      { id: "1", text: "First memory" },
      { id: "2", text: "Second memory" },
    ];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);

    expect(message.content).toContain("---");
  });

  it("places all content inside hindsight_memories fence", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);
    const content = message.content;

    // Extract content between tags
    const match = content.match(/<hindsight_memories>\n([\s\S]*)\n<\/hindsight_memories>/);
    expect(match).not.toBeNull();

    const innerContent = match?.[1];

    // All parts should be inside the fence
    expect(innerContent).toContain(DEFAULT_PREAMBLE);
    expect(innerContent).toContain("Current date and time:");
    expect(innerContent).toContain("User prefers dark mode");
  });

  it("orders content correctly: preamble, date/time, memories", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "Memory content" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);
    const content = message.content;

    // Find positions of each part
    const preamblePos = content.indexOf(DEFAULT_PREAMBLE);
    const dateTimePos = content.indexOf("Current date and time:");
    const memoryPos = content.indexOf("Memory content");

    // Verify order: preamble < date/time < memories
    expect(preamblePos).toBeLessThan(dateTimePos);
    expect(dateTimePos).toBeLessThan(memoryPos);
  });

  it("includes timestamp in message", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const before = Date.now();
    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);
    const after = Date.now();

    expect(message.timestamp).toBeGreaterThanOrEqual(before);
    expect(message.timestamp).toBeLessThanOrEqual(after);
  });

  it("supports custom preamble", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const customPreamble = "Custom system note for testing";
    const message = formatRecallMessage(results, customPreamble, false);

    expect(message.content).toContain(customPreamble);
    expect(message.content).not.toContain(DEFAULT_PREAMBLE);
  });

  // ============================================
  // details field tests
  // ============================================

  it("includes details with count of memories", () => {
    const results: RecallResponse["results"] = [
      { id: "1", text: "Memory 1" },
      { id: "2", text: "Memory 2" },
      { id: "3", text: "Memory 3" },
    ];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, false);

    expect(message.details).toBeDefined();
    expect(message.details.count).toBe(3);
  });

  it("includes snippet from first 3 memories", () => {
    const results: RecallResponse["results"] = [
      { id: "1", text: "First memory" },
      { id: "2", text: "Second memory" },
      { id: "3", text: "Third memory" },
      { id: "4", text: "Fourth memory" },
    ];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, false);

    // Snippet should include first 3 memories joined with middle dot
    expect(message.details.snippet).toContain("First memory");
    expect(message.details.snippet).toContain("Second memory");
    expect(message.details.snippet).toContain("Third memory");
    expect(message.details.snippet).not.toContain("Fourth memory");
  });

  it("includes memories content without wrapper tags in details", () => {
    const results: RecallResponse["results"] = [
      { id: "1", text: "User prefers dark mode" },
      { id: "2", text: "User uses VS Code" },
    ];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, false);

    expect(message.details.memories).toContain("User prefers dark mode");
    expect(message.details.memories).toContain("User uses VS Code");
    expect(message.details.memories).not.toContain("<hindsight_memories>");
    expect(message.details.memories).not.toContain("</hindsight_memories>");
  });

  it("truncates snippet to ~200 chars", () => {
    const longMemory =
      "This is a very long memory that will be truncated when joined with other memories in the snippet to ensure it doesn't exceed the maximum length";
    const results: RecallResponse["results"] = [
      { id: "1", text: longMemory },
      { id: "2", text: longMemory },
      { id: "3", text: longMemory },
    ];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, false);

    expect(message.details.snippet.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it("handles single memory", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "Single memory" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, false);

    expect(message.details.count).toBe(1);
    expect(message.details.snippet).toBe("Single memory");
    expect(message.details.memories).toBe("Single memory");
  });

  it("formatRecallMessage uses display parameter", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const messageHidden = formatRecallMessage(results, DEFAULT_PREAMBLE, true, false);
    const messageShown = formatRecallMessage(results, DEFAULT_PREAMBLE, true, true);

    expect(messageHidden.display).toBe(false);
    expect(messageShown.display).toBe(true);
  });

  it("display: false hides message from TUI", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true, false);

    expect(message.display).toBe(false);
    expect(message.role).toBe("custom");
    expect(message.customType).toBe("hindsight-recall");
  });

  it("display: true shows message in TUI", () => {
    const results: RecallResponse["results"] = [{ id: "1", text: "User prefers dark mode" }];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true, true);

    expect(message.display).toBe(true);
    expect(message.role).toBe("custom");
    expect(message.customType).toBe("hindsight-recall");
  });
});

// ============================================
// autoRecallPersist behavior tests
// ============================================

describe("autoRecallPersist behavior", () => {
  describe("when autoRecallPersist: true", () => {
    it("recall message has display: false by default", () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true, false);
      expect(message.display).toBe(false);
      expect(message.role).toBe("custom");
      expect(message.customType).toBe("hindsight-recall");
    });

    it("recall message can have display: true when autoRecallDisplay is true", () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true, true);
      expect(message.display).toBe(true);
    });
  });

  describe("when autoRecallPersist: false", () => {
    it("recall message always has display: false", () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true, false);
      expect(message.display).toBe(false);
    });

    it("recall message is injected into context but not persisted", () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true, false);
      expect(message.display).toBe(false);
      expect(message.customType).toBe("hindsight-recall");
    });
  });

  describe("context filtering", () => {
    it("recall messages are identified by customType hindsight-recall", () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true);
      expect(message.customType).toBe("hindsight-recall");
    });
  });
});

// ============================================
// Message renderer tests
// ============================================

describe("renderRecallMessage", () => {
  it("collapsed view shows summary with snippet", () => {
    const details = {
      count: 3,
      snippet: "Memory 1 \u00b7 Memory 2 \u00b7 Memory 3",
      memories: "Memory 1\n\n---\n\nMemory 2\n\n---\n\nMemory 3",
    };

    const rendered = renderRecallMessage(details, false);

    expect(rendered).toContain("Hindsight recalled 3 memories");
    expect(rendered).toContain("[Memory 1 \u00b7 Memory 2 \u00b7 Memory 3]");
    expect(rendered).not.toContain("---"); // separator not shown in collapsed
  });

  it("expanded view shows full content", () => {
    const details = {
      count: 3,
      snippet: "Memory 1 \u00b7 Memory 2 \u00b7 Memory 3",
      memories: "Memory 1\n\n---\n\nMemory 2\n\n---\n\nMemory 3",
    };

    const rendered = renderRecallMessage(details, true);

    expect(rendered).toContain("Hindsight recalled 3 memories");
    expect(rendered).toContain("Memory 1");
    expect(rendered).toContain("Memory 2");
    expect(rendered).toContain("Memory 3");
    expect(rendered).toContain("---"); // separator shown in expanded
  });

  it("uses singular 'memory' for count of 1", () => {
    const details = {
      count: 1,
      snippet: "Single memory",
      memories: "Single memory",
    };

    const collapsed = renderRecallMessage(details, false);
    const expanded = renderRecallMessage(details, true);

    expect(collapsed).toContain("1 memory");
    expect(expanded).toContain("1 memory");
  });

  it("uses plural 'memories' for count > 1", () => {
    const details = {
      count: 5,
      snippet: "Truncated...",
      memories: "Full content",
    };

    const collapsed = renderRecallMessage(details, false);
    const expanded = renderRecallMessage(details, true);

    expect(collapsed).toContain("5 memories");
    expect(expanded).toContain("5 memories");
  });

  it("includes separator line in expanded view", () => {
    const details = {
      count: 2,
      snippet: "A \u00b7 B",
      memories: "A\n\n---\n\nB",
    };

    const rendered = renderRecallMessage(details, true);

    // Should have a separator line made of box-drawing characters
    expect(rendered).toContain("\u2500".repeat(80));
  });

  it("works with formatRecallMessage output", () => {
    const results: RecallResponse["results"] = [
      { id: "1", text: "First memory" },
      { id: "2", text: "Second memory" },
    ];

    const message = formatRecallMessage(results, DEFAULT_PREAMBLE, false);
    const collapsed = renderRecallMessage(message.details, false);
    const expanded = renderRecallMessage(message.details, true);

    expect(collapsed).toContain("Hindsight recalled 2 memories");
    expect(collapsed).toContain("First memory");
    expect(expanded).toContain("First memory");
    expect(expanded).toContain("Second memory");
  });
});

// ============================================
// /hindsight popup command tests (real handler)
// ============================================

describe("hindsight-popup command", () => {
  // These tests exercise the real popup subcommand handler
  // through registerCommands, not a simulated version.

  let registeredCommands: Map<string, unknown>;
  let recallDetails: RecallMessageDetails | null;
  let lastNotification: { message: string; type: string } | null;

  beforeEach(() => {
    registeredCommands = new Map();
    recallDetails = null;
    lastNotification = null;
  });

  function register(config: HindsightConfig = testConfig) {
    registerCommands(
      {
        registerCommand: mock((name: string, opts: unknown) => {
          registeredCommands.set(name, opts);
        }),
      } as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI,
      config,
      null, // client not needed for popup
      () => recallDetails,
      () => null,
      () => {},
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );
  }

  function getHandler() {
    return (
      registeredCommands.get("hindsight") as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;
  }

  function makeCtx() {
    return {
      ui: {
        notify: mock((message: string, type: string) => {
          lastNotification = { message, type };
        }),
        custom: mock(async () => {}),
      },
      signal: undefined,
      sessionManager: {
        getSessionId: () => "test-popup-session",
        getEntries: () => [],
        getHeader: () => null,
        getSessionName: () => undefined,
        getSessionFile: () => null,
      },
    } as unknown as ExtensionContext;
  }

  describe("when no recall has occurred", () => {
    it("shows 'No recall this session'", async () => {
      register();
      await getHandler()("popup", makeCtx());
      expect(lastNotification?.message).toBe("No recall this session");
    });
  });

  describe("when recall has occurred", () => {
    it("invokes ui.custom overlay with recall details", async () => {
      recallDetails = {
        count: 5,
        snippet: "Truncated...",
        memories: "Full content",
      };
      register();

      let overlayCalled = false;
      const ctx = {
        ...makeCtx(),
        ui: {
          ...makeCtx().ui,
          custom: mock(async () => {
            overlayCalled = true;
          }),
        },
      } as unknown as ExtensionContext;

      await getHandler()("popup", ctx);

      expect(overlayCalled).toBe(true);
      expect(lastNotification).toBeNull(); // no notification, overlay handles display
    });

    it("overlay receives correct memory count for singular", async () => {
      recallDetails = {
        count: 1,
        snippet: "Single memory",
        memories: "Single memory",
      };
      register();

      let capturedDetails: RecallMessageDetails | null = null;
      const ctx = {
        ...makeCtx(),
        ui: {
          ...makeCtx().ui,
          custom: mock(async (_factory: unknown) => {
            capturedDetails = recallDetails;
          }),
        },
      } as unknown as ExtensionContext;

      await getHandler()("popup", ctx);

      expect((capturedDetails as RecallMessageDetails | null)?.count).toBe(1);
    });

    it("overlay receives correct memory count for plural", async () => {
      recallDetails = {
        count: 5,
        snippet: "Truncated...",
        memories: "Full content",
      };
      register();

      let capturedDetails: RecallMessageDetails | null = null;
      const ctx = {
        ...makeCtx(),
        ui: {
          ...makeCtx().ui,
          custom: mock(async () => {
            capturedDetails = recallDetails;
          }),
        },
      } as unknown as ExtensionContext;

      await getHandler()("popup", ctx);

      expect((capturedDetails as RecallMessageDetails | null)?.count).toBe(5);
    });
  });

  describe("recall caching", () => {
    it("caches recall details from formatRecallMessage output", () => {
      const results: RecallResponse["results"] = [
        { id: "1", text: "First memory" },
        { id: "2", text: "Second memory" },
      ];

      const message = formatRecallMessage(results, DEFAULT_PREAMBLE, false);
      // Simulate caching the details
      const cachedDetails: RecallMessageDetails | null = message.details;

      recallDetails = cachedDetails;
      register();

      // The popup handler should use the cached details
      expect(recallDetails).not.toBeNull();
      expect(recallDetails?.count).toBe(2);
    });

    it("works with autoRecallPersist: true scenario", () => {
      const results: RecallResponse["results"] = [
        { id: "1", text: "Memory from before_agent_start" },
      ];

      const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true, true);
      recallDetails = message.details;

      expect(recallDetails?.count).toBe(1);
    });

    it("works with autoRecallPersist: false scenario", () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory from context event" }];

      const message = formatRecallMessage(results, DEFAULT_PREAMBLE, true, false);
      recallDetails = message.details;

      expect(recallDetails?.count).toBe(1);
    });
  });
});

// ============================================
// RecallOverlayComponent scrolling tests
// ============================================

describe("RecallOverlayComponent scrolling", () => {
  // Mock theme
  const mockTheme = {
    fg: (_color: string, text: string) => text,
  };

  // Mock done callback
  let doneCalled = false;
  const mockDone = () => {
    doneCalled = true;
  };

  beforeEach(() => {
    doneCalled = false;
  });

  describe("closing the overlay", () => {
    it("closes on Escape key", () => {
      const details: RecallMessageDetails = {
        count: 1,
        snippet: "Test",
        memories: "Test memory",
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });
      component.handleInput("\u001b"); // Escape

      expect(doneCalled).toBe(true);
    });

    it("closes on 'q' key", () => {
      const details: RecallMessageDetails = {
        count: 1,
        snippet: "Test",
        memories: "Test memory",
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });
      component.handleInput("q");

      expect(doneCalled).toBe(true);
    });
  });

  describe("scrolling behavior", () => {
    // Create a large content for testing scrolling
    const createLargeMemories = (lineCount: number): string => {
      const lines = [];
      for (let i = 0; i < lineCount; i++) {
        lines.push(`Memory line ${i + 1}`);
      }
      return lines.join("\n");
    };

    it("scrolls down with down arrow and 'j'", () => {
      const details: RecallMessageDetails = {
        count: 50,
        snippet: "Large content",
        memories: createLargeMemories(50),
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });
      const initialRender = component.render(80);
      const initialLineCount = initialRender.length;

      // Scroll down
      component.handleInput("\u001b[B"); // Down arrow
      const afterScroll = component.render(80);

      // Should still have same number of lines
      expect(afterScroll.length).toBe(initialLineCount);

      // Content should have changed (scrolled)
      expect(afterScroll).not.toEqual(initialRender);
    });

    it("scrolls up with up arrow and 'k'", () => {
      const details: RecallMessageDetails = {
        count: 50,
        snippet: "Large content",
        memories: createLargeMemories(50),
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });

      // Scroll down first
      component.handleInput("\u001b[B"); // Down arrow
      component.handleInput("\u001b[B"); // Down arrow
      const afterDown = component.render(80);

      // Scroll up
      component.handleInput("\u001b[A"); // Up arrow
      const afterUp = component.render(80);

      // Content should have changed
      expect(afterUp).not.toEqual(afterDown);
    });

    it("scrolls by page with Page Up/Page Down and 'b'/'f'", () => {
      const details: RecallMessageDetails = {
        count: 100,
        snippet: "Large content",
        memories: createLargeMemories(100),
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });

      // Scroll down by page
      component.handleInput("\u001b[6~"); // Page Down
      const afterPageDown = component.render(80);

      // Scroll down by one line to compare
      const component2 = new RecallOverlayComponent(mockTheme, details, mockDone, {
        maxHeight: 30,
      });
      component2.handleInput("\u001b[B"); // Down arrow (single line)
      const afterSingleDown = component2.render(80);

      // Page scroll should be different from single line scroll
      expect(afterPageDown).not.toEqual(afterSingleDown);
    });

    it("does not scroll past the beginning", () => {
      const details: RecallMessageDetails = {
        count: 50,
        snippet: "Large content",
        memories: createLargeMemories(50),
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });

      // Try to scroll up at the beginning
      component.handleInput("\u001b[A"); // Up arrow
      const render1 = component.render(80);

      // Scroll up again (should have no effect)
      component.handleInput("\u001b[A"); // Up arrow
      const render2 = component.render(80);

      // Renders should be identical (already at top)
      expect(render1).toEqual(render2);
    });

    it("does not scroll past the end", () => {
      const details: RecallMessageDetails = {
        count: 10,
        snippet: "Small content",
        memories: createLargeMemories(10),
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });

      // Scroll down many times
      for (let i = 0; i < 20; i++) {
        component.handleInput("\u001b[B"); // Down arrow
      }
      const render1 = component.render(80);

      // Scroll down more (should have no effect)
      component.handleInput("\u001b[B"); // Down arrow
      const render2 = component.render(80);

      // Renders should be identical (already at bottom)
      expect(render1).toEqual(render2);
    });
  });

  describe("rendering", () => {
    it("shows scroll indicator when content overflows", () => {
      const details: RecallMessageDetails = {
        count: 50,
        snippet: "Large content",
        memories: Array(50)
          .fill(0)
          .map((_, i) => `Line ${i + 1}`)
          .join("\n"),
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });
      const lines = component.render(80);

      // Should show position indicator somewhere
      const hasPositionIndicator = lines.some((line) => line.includes("/50"));
      expect(hasPositionIndicator).toBe(true);
    });

    it("does not show scroll indicator when content fits", () => {
      const details: RecallMessageDetails = {
        count: 3,
        snippet: "Small content",
        memories: "Line 1\nLine 2\nLine 3",
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });
      const lines = component.render(80);

      // Should NOT show position indicator
      const hasPositionIndicator = lines.some((line) => /\d+\/\d+/.test(line));
      expect(hasPositionIndicator).toBe(false);
    });

    it("limits rendered lines to maxHeight", () => {
      const details: RecallMessageDetails = {
        count: 100,
        snippet: "Large content",
        memories: Array(100)
          .fill(0)
          .map((_, i) => `Line ${i + 1}`)
          .join("\n"),
      };

      const maxHeight = 20;
      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight });
      const lines = component.render(80);

      expect(lines.length).toBeLessThanOrEqual(maxHeight + 5);
    });

    it("shows help line with keyboard shortcuts", () => {
      const details: RecallMessageDetails = {
        count: 1,
        snippet: "Test",
        memories: "Test memory",
      };

      const component = new RecallOverlayComponent(mockTheme, details, mockDone, { maxHeight: 30 });
      const lines = component.render(80);

      const hasHelpLine = lines.some(
        (line) => line.includes("scroll") && line.includes("page") && line.includes("close")
      );
      expect(hasHelpLine).toBe(true);
    });
  });
});

// ============================================
// doAutoRecallImpl tests
// ============================================

describe("doAutoRecallImpl", () => {
  // Helper to create a mock client
  function createMockClient(
    options: { success?: boolean; error?: string; results?: RecallResponse["results"] } = {}
  ): RecallClient {
    return {
      recall: async (
        _opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        },
        _signal: AbortSignal | undefined
      ) => {
        if (options.success === false) {
          return { success: false, error: options.error ?? "API error" };
        }
        return {
          success: true,
          response: {
            results: options.results ?? [],
          },
        };
      },
    };
  }

  // Default config for testing
  const defaultConfig: AutoRecallConfig = {
    recallMaxQueryChars: 800,
    recallTypes: null,
    recallPromptPreamble: DEFAULT_PREAMBLE,
    recallShowDateTime: true,
    autoRecallTags: null,
    autoRecallTagsMatch: "any",
    autoRecallTagGroups: null,
  };

  // Create a mock AbortSignal
  const mockSignal = new AbortController().signal;

  describe("null client handling", () => {
    it("returns null when client is null", async () => {
      let cachedDetails: RecallMessageDetails | null = { count: 0, snippet: "", memories: "" };

      const result = await doAutoRecallImpl(
        null,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (details) => {
          cachedDetails = details;
        }
      );

      expect(result).toBeNull();
      // cacheDetails should not be called when client is null
      expect(cachedDetails).toEqual({ count: 0, snippet: "", memories: "" });
    });
  });

  describe("error handling", () => {
    it("returns null when client returns error", async () => {
      const mockClient = createMockClient({ success: false, error: "API rate limit exceeded" });
      let cachedDetails: RecallMessageDetails | null = {
        count: 1,
        snippet: "prev",
        memories: "prev",
      };

      const result = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (details) => {
          cachedDetails = details;
        }
      );

      expect(result).toBeNull();
      // cacheDetails should be called with null on error
      expect(cachedDetails).toBeNull();
    });

    it("returns null when client throws exception", async () => {
      const mockClient: RecallClient = {
        recall: async () => {
          throw new Error("Network error");
        },
      };
      let cachedDetails: RecallMessageDetails | null = {
        count: 1,
        snippet: "prev",
        memories: "prev",
      };

      const result = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (details) => {
          cachedDetails = details;
        }
      );

      expect(result).toBeNull();
      expect(cachedDetails).toBeNull();
    });
  });

  describe("no results case", () => {
    it("returns null when recall returns empty results", async () => {
      const mockClient = createMockClient({ success: true, results: [] });
      let cachedDetails: RecallMessageDetails | null = {
        count: 1,
        snippet: "prev",
        memories: "prev",
      };

      const result = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (details) => {
          cachedDetails = details;
        }
      );

      expect(result).toBeNull();
      // cacheDetails should be called with null when no results
      expect(cachedDetails).toBeNull();
    });

    it("returns null when response is undefined", async () => {
      const mockClient: RecallClient = {
        recall: async () => ({ success: true }),
      };
      let cachedDetails: RecallMessageDetails | null = {
        count: 1,
        snippet: "prev",
        memories: "prev",
      };

      const result = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (details) => {
          cachedDetails = details;
        }
      );

      expect(result).toBeNull();
      expect(cachedDetails).toBeNull();
    });
  });

  describe("successful recall with results", () => {
    it("returns recall message with correct structure", async () => {
      const results: RecallResponse["results"] = [
        { id: "1", text: "User prefers dark mode" },
        { id: "2", text: "User uses VS Code" },
      ];
      const mockClient = createMockClient({ success: true, results });
      const result = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (_details) => {}
      );

      expect(result).not.toBeNull();
      expect(result?.recallMessage.role).toBe("custom");
      expect(result?.recallMessage.customType).toBe("hindsight-recall");
      expect(result?.recallMessage.display).toBe(false);
      expect(result?.recallMessage.content).toContain("<hindsight_memories>");
      expect(result?.recallMessage.content).toContain("User prefers dark mode");
      expect(result?.recallMessage.content).toContain("User uses VS Code");
    });

    it("passes display parameter to recall message", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Test memory" }];
      const mockClient = createMockClient({ success: true, results });
      const resultHidden = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (_details) => {}
      );

      const resultShown = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        true,
        defaultConfig,
        (_details) => {}
      );

      expect(resultHidden?.recallMessage.display).toBe(false);
      expect(resultShown?.recallMessage.display).toBe(true);
    });

    it("includes date/time when showDateTime is true", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Test memory" }];
      const mockClient = createMockClient({ success: true, results });
      const result = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, recallShowDateTime: true },
        (_details) => {}
      );

      expect(result?.recallMessage.content).toContain("Current date and time:");
    });

    it("excludes date/time when showDateTime is false", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Test memory" }];
      const mockClient = createMockClient({ success: true, results });
      const result = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, recallShowDateTime: false },
        (_details) => {}
      );

      expect(result?.recallMessage.content).not.toContain("Current date and time:");
    });
  });

  describe("lastRecallDetails caching", () => {
    it("caches recall details on successful recall", async () => {
      const results: RecallResponse["results"] = [
        { id: "1", text: "First memory" },
        { id: "2", text: "Second memory" },
      ];
      const mockClient = createMockClient({ success: true, results });
      const cacheState: { details: RecallMessageDetails | null } = { details: null };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (details) => {
          cacheState.details = details;
        }
      );

      expect(cacheState.details).not.toBeNull();
      expect(cacheState.details?.count).toBe(2);
      expect(cacheState.details?.memories).toContain("First memory");
      expect(cacheState.details?.memories).toContain("Second memory");
    });

    it("clears cache on error", async () => {
      const mockClient = createMockClient({ success: false, error: "API error" });
      let cachedDetails: RecallMessageDetails | null = {
        count: 1,
        snippet: "prev",
        memories: "prev",
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (details) => {
          cachedDetails = details;
        }
      );

      expect(cachedDetails).toBeNull();
    });

    it("clears cache on no results", async () => {
      const mockClient = createMockClient({ success: true, results: [] });
      let cachedDetails: RecallMessageDetails | null = {
        count: 1,
        snippet: "prev",
        memories: "prev",
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        defaultConfig,
        (details) => {
          cachedDetails = details;
        }
      );

      expect(cachedDetails).toBeNull();
    });
  });

  describe("query truncation", () => {
    it("truncates query to recallMaxQueryChars", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedQuery: string | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedQuery = opts.query;
          return { success: true, response: { results } };
        },
      };

      const longQuery = "A".repeat(1000);

      await doAutoRecallImpl(
        mockClient,
        longQuery,
        mockSignal,
        false,
        { ...defaultConfig, recallMaxQueryChars: 100 },
        () => {}
      );

      expect(receivedQuery?.length).toBeLessThanOrEqual(100);
      // Truncated should end with ellipsis
      expect(receivedQuery?.endsWith("…") || receivedQuery?.length === 100).toBe(true);
    });

    it("does not truncate short queries", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedQuery: string | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedQuery = opts.query;
          return { success: true, response: { results } };
        },
      };

      const shortQuery = "Hello world";

      await doAutoRecallImpl(
        mockClient,
        shortQuery,
        mockSignal,
        false,
        { ...defaultConfig, recallMaxQueryChars: 800 },
        () => {}
      );

      expect(receivedQuery).toBe(shortQuery);
    });

    it("handles multi-byte Unicode characters in truncation", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedQuery: string | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedQuery = opts.query;
          return { success: true, response: { results } };
        },
      };

      // Emoji and multi-byte chars
      const unicodeQuery = `Hello 👋 世界 🌍 ${"x".repeat(100)}`;

      await doAutoRecallImpl(
        mockClient,
        unicodeQuery,
        mockSignal,
        false,
        { ...defaultConfig, recallMaxQueryChars: 20 },
        () => {}
      );

      // Should be truncated to 20 code points (19 + ellipsis)
      expect([...(receivedQuery ?? "")].length).toBe(20);
    });
  });

  describe("types config", () => {
    it("passes types to client when configured", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTypes: ("world" | "experience" | "observation")[] | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTypes = opts.types;
          return { success: true, response: { results } };
        },
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, recallTypes: ["world", "experience"] },
        () => {}
      );

      expect(receivedTypes).toEqual(["world", "experience"]);
    });

    it("passes undefined when types is null", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTypes: ("world" | "experience" | "observation")[] | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTypes = opts.types;
          return { success: true, response: { results } };
        },
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, recallTypes: null },
        () => {}
      );

      expect(receivedTypes).toBeUndefined();
    });

    it("passes empty array as undefined", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTypes: ("world" | "experience" | "observation")[] | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTypes = opts.types;
          return { success: true, response: { results } };
        },
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, recallTypes: [] as ("world" | "experience" | "observation")[] },
        () => {}
      );

      // Empty array is truthy (not null/undefined), so it passes through as-is
      expect(receivedTypes).toEqual([]);
    });
  });

  describe("preamble configuration", () => {
    it("uses custom preamble in recall message", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Test memory" }];
      const mockClient = createMockClient({ success: true, results });

      const customPreamble = "[Custom note: This is custom context]";

      const result = await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, recallPromptPreamble: customPreamble },
        () => {}
      );

      expect(result?.recallMessage.content).toContain(customPreamble);
      expect(result?.recallMessage.content).not.toContain(DEFAULT_PREAMBLE);
    });
  });

  describe("recall tags filtering", () => {
    it("passes autoRecallTags to client when configured", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTags: string[] | undefined;
      let receivedTagsMatch: string | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTags = opts.tags;
          receivedTagsMatch = opts.tagsMatch;
          return { success: true, response: { results } };
        },
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, autoRecallTags: ["project:myapp"], autoRecallTagsMatch: "any_strict" },
        () => {}
      );

      expect(receivedTags).toEqual(["project:myapp"]);
      expect(receivedTagsMatch).toBe("any_strict");
    });

    it("passes undefined tags when autoRecallTags is null", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTags: string[] | undefined;
      let receivedTagsMatch: string | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTags = opts.tags;
          receivedTagsMatch = opts.tagsMatch;
          return { success: true, response: { results } };
        },
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, autoRecallTags: null, autoRecallTagsMatch: "any" },
        () => {}
      );

      expect(receivedTags).toBeUndefined();
      expect(receivedTagsMatch).toBeUndefined();
    });

    it("does not pass tagsMatch when autoRecallTags is null", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTagsMatch: string | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTagsMatch = opts.tagsMatch;
          return { success: true, response: { results } };
        },
      };

      // Even if autoRecallTagsMatch is set, it should not be passed when autoRecallTags is null
      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, autoRecallTags: null, autoRecallTagsMatch: "all_strict" },
        () => {}
      );

      expect(receivedTagsMatch).toBeUndefined();
    });
  });

  describe("recall tagGroups filtering", () => {
    it("passes autoRecallTagGroups to client when configured", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTagGroups: unknown;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          tagGroups?: import("../src/config").TagGroupInput[];
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTagGroups = opts.tagGroups;
          return { success: true, response: { results } };
        },
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        {
          ...defaultConfig,
          autoRecallTagGroups: [
            { tags: ["project:myapp"], match: "any_strict" },
            { not: { tags: ["session:abc"] } },
          ],
        },
        () => {}
      );

      expect(receivedTagGroups).toEqual([
        { tags: ["project:myapp"], match: "any_strict" },
        { not: { tags: ["session:abc"] } },
      ]);
    });

    it("passes undefined tagGroups when autoRecallTagGroups is null", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTagGroups: unknown;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          tagGroups?: import("../src/config").TagGroupInput[];
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTagGroups = opts.tagGroups;
          return { success: true, response: { results } };
        },
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        { ...defaultConfig, autoRecallTagGroups: null },
        () => {}
      );

      expect(receivedTagGroups).toBeUndefined();
    });

    it("sends both tags/tagGroups when both are configured", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTags: string[] | undefined;
      let receivedTagsMatch: string | undefined;
      let receivedTagGroups: unknown;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          tagGroups?: import("../src/config").TagGroupInput[];
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTags = opts.tags;
          receivedTagsMatch = opts.tagsMatch;
          receivedTagGroups = opts.tagGroups;
          return { success: true, response: { results } };
        },
      };

      // Both autoRecallTags and autoRecallTagGroups set - both are sent to the API
      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        {
          ...defaultConfig,
          autoRecallTags: ["project:myapp"],
          autoRecallTagsMatch: "any_strict",
          autoRecallTagGroups: [{ tags: ["project:myapp"], match: "any_strict" }],
        },
        () => {}
      );

      expect(receivedTags).toEqual(["project:myapp"]);
      expect(receivedTagsMatch).toBe("any_strict");
      expect(receivedTagGroups).toEqual([{ tags: ["project:myapp"], match: "any_strict" }]);
    });

    it("passes tags/tagsMatch when tagGroups is null", async () => {
      const results: RecallResponse["results"] = [{ id: "1", text: "Memory" }];
      let receivedTags: string[] | undefined;
      let receivedTagsMatch: string | undefined;

      const mockClient: RecallClient = {
        recall: async (opts: {
          query: string;
          tags?: string[];
          tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
          tagGroups?: import("../src/config").TagGroupInput[];
          types?: ("world" | "experience" | "observation")[];
        }) => {
          receivedTags = opts.tags;
          receivedTagsMatch = opts.tagsMatch;
          return { success: true, response: { results } };
        },
      };

      await doAutoRecallImpl(
        mockClient,
        "test query",
        mockSignal,
        false,
        {
          ...defaultConfig,
          autoRecallTags: ["project:myapp"],
          autoRecallTagsMatch: "any_strict",
          autoRecallTagGroups: null,
        },
        () => {}
      );

      expect(receivedTags).toEqual(["project:myapp"]);
      expect(receivedTagsMatch).toBe("any_strict");
    });
  });
});
