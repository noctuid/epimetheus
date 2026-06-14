/**
 * Unit tests for slash commands.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../src/client";
import { registerCommands } from "../src/commands";
import type { RecallMessageDetails } from "../src/index";
import {
  createMockClient,
  readToolQueueFromDisk,
  setupTempAgentDir,
  statusTestConfig,
  withTempDir,
  writeSessionFile,
} from "./fixtures";

// Redirect agent-dir filesystem operations to a temp directory instead of
// the real user's ~/.pi/agent/ directory.
setupTempAgentDir("commands");

afterEach(() => {
  // Clean up parsed-session cache and live state to prevent leaks between tests
  // using the same session ID (test-session-123).
  try {
    const { getMetaPath, getMessagesPath } =
      require("../src/parsed-store") as typeof import("../src/parsed-store");
    const { getSessionStatePath } =
      require("../src/session-state") as typeof import("../src/session-state");
    const { existsSync } = require("node:fs");
    const { rmSync } = require("node:fs");
    for (const p of [
      getMetaPath("test-session-123"),
      getMessagesPath("test-session-123"),
      getSessionStatePath("test-session-123"),
    ]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
  } catch {
    // best-effort
  }
});

interface RegisteredCmd {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  getArgumentCompletions?: (
    argumentPrefix: string
  ) => Promise<Array<{ label: string; value: string; description?: string }> | null>;
}

describe("registerCommands", () => {
  let registeredCommands: Map<string, RegisteredCmd>;
  let mockPi: {
    registerCommand: ReturnType<typeof mock>;
    appendEntry: ReturnType<typeof mock>;
    getActiveTools: ReturnType<typeof mock>;
    setActiveTools: ReturnType<typeof mock>;
  };
  let mockClient: HindsightClientWrapper | null;
  let recallDetails: RecallMessageDetails | null;
  let autoRecallDisplayOverride: boolean | null;
  let lastNotification: { message: string; type: string } | null;
  let appendedEntries: { customType: string; data?: unknown }[];
  let sessionEntries: unknown[];
  let confirmResult: boolean;

  beforeEach(() => {
    // Fresh state for every test — prevents mockClient mutation from leaking
    registeredCommands = new Map();
    recallDetails = null;
    autoRecallDisplayOverride = null;
    lastNotification = null;
    appendedEntries = [];
    sessionEntries = [];
    confirmResult = true;
    mockClient = createMockClient();

    mockPi = {
      registerCommand: mock((name: string, options: RegisteredCmd) => {
        registeredCommands.set(name, options);
      }),
      appendEntry: mock((customType: string, data?: unknown) => {
        appendedEntries.push({ customType, data });
      }),
      getActiveTools: mock(() => [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "hindsight_retain",
        "hindsight_recall",
        "hindsight_reflect",
      ]),
      setActiveTools: mock(() => {}),
    } as unknown as typeof mockPi;
  });

  function register(config = statusTestConfig, client = mockClient) {
    registerCommands(
      mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      config,
      client,
      () => recallDetails,
      () => autoRecallDisplayOverride,
      () => {
        autoRecallDisplayOverride = !autoRecallDisplayOverride;
      },
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );
  }

  function registerWithMeta(meta: {
    configPath?: string;
    envVars: string[];
    warning?: string;
    validationWarnings: string[];
  }) {
    registerCommands(
      mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      statusTestConfig,
      mockClient,
      () => recallDetails,
      () => autoRecallDisplayOverride,
      () => {
        autoRecallDisplayOverride = !autoRecallDisplayOverride;
      },
      meta
    );
  }

  function makeCtx(sessionId: string | null = "test-session-123") {
    return {
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => sessionEntries,
        getSessionFile: () => null,
        getHeader: () => null,
        getSessionName: () => undefined,
      },
      ui: {
        notify: mock((message: string, type: string) => {
          lastNotification = { message, type };
        }),
        confirm: mock(async () => confirmResult),
        select: mock(async () => undefined),
      },
      signal: undefined,
      cwd: "/test",
    } as unknown as ExtensionContext;
  }

  function makeConfigCtx() {
    return {
      ui: {
        notify: mock((message: string, type: string) => {
          lastNotification = { message, type };
        }),
      },
      signal: undefined,
    } as unknown as ExtensionContext;
  }

  function getHandler() {
    return registeredCommands.get("hindsight")!.handler;
  }

  function getCompletions() {
    return registeredCommands.get("hindsight")!.getArgumentCompletions!;
  }

  it("registers a single /hindsight command", () => {
    register();
    expect(registeredCommands.has("hindsight")).toBe(true);
    expect(registeredCommands.size).toBe(1);
  });

  it("falls back to status when called with no subcommand", async () => {
    register();
    await getHandler()("", makeCtx());
    expect(lastNotification?.message).toContain("Server: reachable");
  });

  it("shows error for unknown subcommand", async () => {
    register();
    await getHandler()("unknown-sub", makeCtx());
    expect(lastNotification?.message).toContain("Unknown subcommand: unknown-sub");
  });

  describe("status subcommand", () => {
    it("shows connection status when server is reachable", async () => {
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Server: reachable");
      expect(lastNotification?.message).toContain("Bank ID: test-bank");
      expect(lastNotification?.message).toContain("Session ID: test-session-123");
      expect(lastNotification?.message).toContain("Auto-recall: enabled");
      expect(lastNotification?.message).toContain("Auto-retain: enabled");
    });

    it("shows connection status when server is unreachable", async () => {
      mockClient = createMockClient({
        healthCheckResult: { success: false, error: "Connection refused" },
      });
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Server: unreachable");
      expect(lastNotification?.message).toContain("Connection refused");
    });

    it("shows 'Server: not configured' when client is null", async () => {
      register(statusTestConfig, null);
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Server: not configured");
    });

    it("shows 'Session ID: none' when getSessionId() returns null", async () => {
      register();
      await getHandler()("status", makeCtx(null));
      expect(lastNotification?.message).toContain("Session ID: none");
    });

    it("shows 'Types: all' when autoRecallTypes is null", async () => {
      register({ ...statusTestConfig, autoRecallTypes: null });
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Types: all");
    });

    it("shows last recall details when available", async () => {
      recallDetails = {
        count: 3,
        snippet: "Test memory snippet that is quite long",
        memories: "Memory 1\nMemory 2\nMemory 3",
      };
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Memories: 3");
      expect(lastNotification?.message).toContain("Snippet:");
    });

    it("shows no recall message when no recall has happened", async () => {
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("No recall this session");
    });

    it("shows disabled features when auto-recall/retain are disabled", async () => {
      register({ ...statusTestConfig, autoRecallEnabled: false, autoRetainEnabled: false });
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Auto-recall: disabled");
      expect(lastNotification?.message).toContain("Auto-retain: disabled");
    });

    it("does not append '...' when snippet is exactly 60 chars", async () => {
      recallDetails = { count: 1, snippet: "a".repeat(60), memories: "Memory 1" };
      register();
      await getHandler()("status", makeCtx("test-session"));
      const snippetLine = lastNotification?.message
        .split("\n")
        .find((l: string) => l.includes("Snippet:"));
      expect(snippetLine).toBeDefined();
      expect(snippetLine?.endsWith("...")).toBe(false);
    });

    it("appends '...' when snippet is 61 chars", async () => {
      recallDetails = { count: 1, snippet: "a".repeat(61), memories: "Memory 1" };
      register();
      await getHandler()("status", makeCtx("test-session"));
      const snippetLine = lastNotification?.message
        .split("\n")
        .find((l: string) => l.includes("Snippet:"));
      expect(snippetLine).toBeDefined();
      expect(snippetLine?.endsWith("...")).toBe(true);
    });

    it("does not append '...' when snippet is 59 chars", async () => {
      recallDetails = { count: 1, snippet: "a".repeat(59), memories: "Memory 1" };
      register();
      await getHandler()("status", makeCtx("test-session"));
      const snippetLine = lastNotification?.message
        .split("\n")
        .find((l: string) => l.includes("Snippet:"));
      expect(snippetLine).toBeDefined();
      expect(snippetLine?.endsWith("...")).toBe(false);
    });

    it("shows 'Snippet: ' with no trailing content for empty snippet", async () => {
      recallDetails = { count: 1, snippet: "", memories: "Memory 1" };
      register();
      await getHandler()("status", makeCtx("test-session"));
      const snippetLine = lastNotification?.message
        .split("\n")
        .find((l: string) => l.includes("Snippet:"));
      expect(snippetLine).toBeDefined();
      expect(snippetLine?.endsWith("...")).toBe(false);
      expect(snippetLine).toBe("  Snippet: ");
    });
  });

  describe("config subcommand", () => {
    it("shows config file path and env vars", async () => {
      registerWithMeta({
        configPath: "/path/to/config.json",
        envVars: ["HINDSIGHT_API_URL", "HINDSIGHT_API_KEY"],
        warning: undefined,
        validationWarnings: [],
      });
      await getHandler()("config", makeConfigCtx());
      expect(lastNotification?.message).toContain("File: /path/to/config.json");
      expect(lastNotification?.message).toContain("HINDSIGHT_API_URL, HINDSIGHT_API_KEY");
    });

    it("shows 'none (using defaults)' when no config file", async () => {
      register();
      await getHandler()("config", makeConfigCtx());
      expect(lastNotification?.message).toContain("File: none (using defaults)");
      expect(lastNotification?.message).toContain("None set");
    });

    it("masks API key showing only last 4 characters", async () => {
      register();
      await getHandler()("config", makeConfigCtx());
      expect(lastNotification?.message).toContain("****2345");
      expect(lastNotification?.message).not.toContain("test-api-key-12345");
    });

    it("masks short API key with **** only", async () => {
      register({ ...statusTestConfig, apiKey: "ab" });
      await getHandler()("config", makeConfigCtx());
      expect(lastNotification?.message).toContain("****");
      const apiKeyMatch = lastNotification?.message.match(/"apiKey":\s*"([^"]+)"/);
      expect(apiKeyMatch).not.toBeNull();
      expect(apiKeyMatch?.[1]).toBe("****");
    });

    it("shows (not set) when API key is empty", async () => {
      register({ ...statusTestConfig, apiKey: "" });
      await getHandler()("config", makeConfigCtx());
      expect(lastNotification?.message).toContain("(not set)");
    });

    it("shows config warnings", async () => {
      registerWithMeta({
        configPath: undefined,
        envVars: [],
        warning: "Test warning from config loading",
        validationWarnings: ["Validation warning 1", "Validation warning 2"],
      });
      await getHandler()("config", makeConfigCtx());
      expect(lastNotification?.message).toContain("Test warning from config loading");
      expect(lastNotification?.message).toContain("Validation warning 1");
      expect(lastNotification?.message).toContain("Validation warning 2");
    });

    it("shows 'None' when no warnings", async () => {
      register();
      await getHandler()("config", makeConfigCtx());
      const warningsMatch = lastNotification?.message.match(/== Warnings ==[\s\S]*?None/);
      expect(warningsMatch).not.toBeNull();
    });
  });

  describe("parse-and-upsert-session subcommand", () => {
    it("errors when Hindsight not configured", async () => {
      register(statusTestConfig, null);
      await getHandler()("parse-and-upsert-session", makeCtx());
      expect(lastNotification?.message).toContain("Hindsight not configured");
    });

    it("notifies when no session file", async () => {
      register();
      await getHandler()("parse-and-upsert-session", makeCtx());
      expect(lastNotification?.message).toContain("No session file found");
      expect(lastNotification?.type).toBe("error");
    });

    it("deletes queued messages after upsert to prevent duplication", async () => {
      const sessionId = "test-session-123";
      const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
        await import("../src/queue");

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);

        try {
          await touchPendingFlag(sessionId);
          expect(hasPendingFlag(sessionId)).toBe(true);

          let retainCalled = false;
          mockClient = createMockClient({
            retainResult: { success: true },
          });
          // Override retain to track calls
          (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => {
            retainCalled = true;
            return { success: true };
          });

          register();

          const ctx = {
            ...makeCtx(),
            sessionManager: {
              ...makeCtx().sessionManager,
              getSessionFile: () => sessionPath,
            },
          } as unknown as ExtensionContext;

          await getHandler()("parse-and-upsert-session", ctx);

          expect(hasPendingFlag(sessionId)).toBe(false);
          expect(retainCalled).toBe(true);
          expect(lastNotification?.message).toContain("Parsed and upserted");
        } finally {
          removePendingFlag(sessionId);
          clearSessionQueueState(sessionId);
        }
      });
    });

    it("does not error when no queue files exist", async () => {
      const sessionId = "test-session-123";
      const { removePendingFlag, clearSessionQueueState } = await import("../src/queue");

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);

        try {
          let retainCalled = false;
          mockClient = createMockClient();
          (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => {
            retainCalled = true;
            return { success: true };
          });

          register();

          const ctx = {
            ...makeCtx(),
            sessionManager: {
              ...makeCtx().sessionManager,
              getSessionFile: () => sessionPath,
            },
          } as unknown as ExtensionContext;

          await getHandler()("parse-and-upsert-session", ctx);
          expect(retainCalled).toBe(true);
          expect(lastNotification?.message).toContain("Parsed and upserted");
        } finally {
          removePendingFlag(sessionId);
          clearSessionQueueState(sessionId);
        }
      });
    });

    it("preserves tool queue on upsert (tool retains are separate documents)", async () => {
      const sessionId = "test-session-123";
      const {
        enqueueToolMessage,

        removePendingFlag,
        clearSessionQueueState,
        hasPendingFlag,
        touchPendingFlag,
      } = await import("../src/queue");

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);

        try {
          // Enqueue both auto and tool messages
          await touchPendingFlag(sessionId);
          await enqueueToolMessage(sessionId, {
            content: "User prefers dark mode",
            tags: ["topic:ui"],
            timestamp: new Date().toISOString(),
            store_method: "tool",
            sessionId: "test-session",
          });
          expect(hasPendingFlag(sessionId)).toBe(true);
          expect(readToolQueueFromDisk(sessionId)).toHaveLength(1);

          mockClient = createMockClient({
            retainResult: { success: true },
          });
          (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
            success: true,
          }));

          register();

          const ctx = {
            ...makeCtx(),
            sessionManager: {
              ...makeCtx().sessionManager,
              getSessionFile: () => sessionPath,
            },
          } as unknown as ExtensionContext;

          await getHandler()("parse-and-upsert-session", ctx);

          // Auto queue should be cleared (session messages are already upserted)
          expect(hasPendingFlag(sessionId)).toBe(false);
          // Tool queue should be preserved (tool retains are separate documents,
          // not included in the session upsert; deleting them would cause data loss)
          expect(readToolQueueFromDisk(sessionId)).toHaveLength(1);
          expect(readToolQueueFromDisk(sessionId)[0]?.content).toBe("User prefers dark mode");
          expect(lastNotification?.message).toContain("Parsed and upserted");
        } finally {
          removePendingFlag(sessionId);
          clearSessionQueueState(sessionId);
        }
      });
    });
  });

  describe("toggle-retain subcommand", () => {
    it("toggles retention off, deletes queue files", async () => {
      const sessionId = "test-session-123";
      const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
        await import("../src/queue");
      try {
        await touchPendingFlag(sessionId);
        expect(hasPendingFlag(sessionId)).toBe(true);

        register();
        await getHandler()("toggle-retain", makeCtx(sessionId));

        expect(hasPendingFlag(sessionId)).toBe(false);
        expect(lastNotification?.message).toContain("disabled");
        expect(appendedEntries).toHaveLength(1);
        expect(appendedEntries[0]?.data).toEqual({ retained: false });
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("disable retention: metadata update and tool hiding happen before queue clear", async () => {
      const sessionId = "test-session-disable-order";
      const {
        enqueueToolMessage,

        removePendingFlag,
        clearSessionQueueState,
        hasPendingFlag,
        touchPendingFlag,
      } = await import("../src/queue");

      // Track ordering: record what exists when appendEntry and setActiveTools are called
      const orderingLog: Array<{ event: string; hadPending: boolean; hadToolEntries: boolean }> =
        [];

      try {
        // Set up queued state
        await touchPendingFlag(sessionId);
        await enqueueToolMessage(sessionId, {
          content: "Tool memory",
          tags: ["test"],
          store_method: "tool",
          timestamp: new Date().toISOString(),
          sessionId: "test-session",
        });
        expect(hasPendingFlag(sessionId)).toBe(true);
        expect(readToolQueueFromDisk(sessionId)).toHaveLength(1);

        sessionEntries = [
          { type: "custom", customType: "hindsight-meta", data: { retained: true } },
        ];

        // Override appendEntry to capture ordering at metadata update time
        mockPi.appendEntry = mock((customType: string, data?: unknown) => {
          appendedEntries.push({ customType, data });
          if (
            customType === "hindsight-meta" &&
            (data as Record<string, unknown>)?.retained === false
          ) {
            orderingLog.push({
              event: "appendEntry(retained:false)",
              hadPending: hasPendingFlag(sessionId),
              hadToolEntries: readToolQueueFromDisk(sessionId).length > 0,
            });
          }
        }) as typeof mockPi.appendEntry;

        // Override setActiveTools to capture ordering at tool-hiding time
        mockPi.setActiveTools = mock((names: string[]) => {
          if (!names.includes("hindsight_retain")) {
            orderingLog.push({
              event: "setActiveTools(hide_retain)",
              hadPending: hasPendingFlag(sessionId),
              hadToolEntries: readToolQueueFromDisk(sessionId).length > 0,
            });
          }
        }) as typeof mockPi.setActiveTools;

        register();
        await getHandler()("toggle-retain", makeCtx(sessionId));

        // Verify ordering: metadata update and tool hiding happened while queue still existed
        expect(orderingLog).toHaveLength(2);
        expect(orderingLog[0]?.event).toBe("appendEntry(retained:false)");
        expect(orderingLog[0]?.hadPending).toBe(true);
        expect(orderingLog[0]?.hadToolEntries).toBe(true);
        expect(orderingLog[1]?.event).toBe("setActiveTools(hide_retain)");
        expect(orderingLog[1]?.hadPending).toBe(true);
        expect(orderingLog[1]?.hadToolEntries).toBe(true);

        // After handler completes, queue should be cleared
        expect(hasPendingFlag(sessionId)).toBe(false);
        expect(readToolQueueFromDisk(sessionId)).toHaveLength(0);
        expect(lastNotification?.message).toContain("disabled");
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("toggles retention on with confirm=yes and appends meta", async () => {
      const sessionId = "test-session-confirm-no-enable";
      const { removePendingFlag, clearSessionQueueState, hasPendingFlag } = await import(
        "../src/queue"
      );
      try {
        sessionEntries = [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ];
        confirmResult = true;
        register();
        await getHandler()("toggle-retain", makeCtx(sessionId));
        expect(appendedEntries).toHaveLength(1);
        expect(appendedEntries[0]?.data).toEqual({ retained: true });
        // Pending marker is created before confirm prompt
        expect(hasPendingFlag(sessionId)).toBe(true);
        // Session retention is enabled even though parse-and-upsert fails (no session file)
        expect(lastNotification?.message).toContain("Session file not found");
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("toggles retention on with confirm=no, still enables and marks pending", async () => {
      const sessionId = "test-session-confirm-no-enable";
      const { removePendingFlag, clearSessionQueueState, hasPendingFlag } = await import(
        "../src/queue"
      );
      try {
        sessionEntries = [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ];
        confirmResult = false;
        register();
        await getHandler()("toggle-retain", makeCtx(sessionId));
        // Retention is enabled even when user declines immediate upsert
        expect(appendedEntries).toHaveLength(1);
        expect(appendedEntries[0]?.data).toEqual({ retained: true });
        // Session is marked dirty (pending marker was created before confirm prompt)
        expect(hasPendingFlag(sessionId)).toBe(true);
        expect(lastNotification?.message).toContain("enabled");
        expect(lastNotification?.message).toContain("next flush");
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("confirm=yes with missing session file enables and leaves pending marker for retry", async () => {
      const sessionId = "test-session-confirm-yes-missing-file";
      const { removePendingFlag, clearSessionQueueState, hasPendingFlag } = await import(
        "../src/queue"
      );
      try {
        sessionEntries = [
          { type: "custom", customType: "hindsight-meta", data: { retained: false } },
        ];
        confirmResult = true;
        // getSessionFile returns null to simulate missing session file
        register();
        await getHandler()("toggle-retain", makeCtx(sessionId));
        // Retention is enabled
        expect(appendedEntries).toHaveLength(1);
        expect(appendedEntries[0]?.data).toEqual({ retained: true });
        // Pending marker remains for retry since upsert couldn't run
        expect(hasPendingFlag(sessionId)).toBe(true);
        expect(lastNotification?.message).toContain("Session file not found");
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("toggles retention off with confirm=no, does not disable or delete queues", async () => {
      const sessionId = "test-session-confirm-no";
      const {
        enqueueToolMessage,

        removePendingFlag,
        clearSessionQueueState,
        hasPendingFlag,
        touchPendingFlag,
      } = await import("../src/queue");
      try {
        await touchPendingFlag(sessionId);
        await enqueueToolMessage(sessionId, {
          content: "Tool memory",
          tags: ["test"],
          store_method: "tool",
          timestamp: new Date().toISOString(),
          sessionId: "test-session",
        });
        expect(hasPendingFlag(sessionId)).toBe(true);
        expect(readToolQueueFromDisk(sessionId)).toHaveLength(1);

        sessionEntries = [
          { type: "custom", customType: "hindsight-meta", data: { retained: true } },
        ];
        confirmResult = false;
        register();
        await getHandler()("toggle-retain", makeCtx(sessionId));

        expect(appendedEntries).toHaveLength(0);
        expect(lastNotification?.message).toContain("Retention not disabled");
        expect(hasPendingFlag(sessionId)).toBe(true);
        expect(readToolQueueFromDisk(sessionId)).toHaveLength(1);
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("preserves existing tags when toggling off", async () => {
      sessionEntries = [
        {
          type: "custom",
          customType: "hindsight-meta",
          data: { retained: true, tags: ["topic:ai"] },
        },
      ];
      register();
      await getHandler()("toggle-retain", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ retained: false, tags: ["topic:ai"] });
    });

    it("preserves existing tags when toggling on", async () => {
      sessionEntries = [
        {
          type: "custom",
          customType: "hindsight-meta",
          data: { retained: false, tags: ["topic:ai"] },
        },
      ];
      confirmResult = true;
      register();
      await getHandler()("toggle-retain", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ retained: true, tags: ["topic:ai"] });
    });

    it("uses retainSessionsByDefault=false as starting state", async () => {
      confirmResult = true;
      register({ ...statusTestConfig, retainSessionsByDefault: false });
      await getHandler()("toggle-retain", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ retained: true });
    });

    it("allows toggling on when requireExtraContextBeforeFlush is true and extra context not set", async () => {
      confirmResult = true;
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { retained: false } },
      ];
      register({ ...statusTestConfig, requireExtraContextBeforeFlush: true });
      await getHandler()("toggle-retain", makeCtx());
      // Toggle-retain no longer blocks on missing extra context —
      // the guard only applies at upsert time.
      expect(appendedEntries).toHaveLength(1);
      expect(appendedEntries[0]?.data).toEqual({ retained: true });
    });

    it("allows toggling on when requireExtraContextBeforeFlush is true and extra context is set", async () => {
      confirmResult = true;
      sessionEntries = [
        {
          type: "custom",
          customType: "hindsight-meta",
          data: { retained: false, extraContext: "fiction" },
        },
      ];
      register({ ...statusTestConfig, requireExtraContextBeforeFlush: true });
      await getHandler()("toggle-retain", makeCtx());
      expect(appendedEntries).toHaveLength(1);
      expect(appendedEntries[0]?.data).toEqual({ retained: true, extraContext: "fiction" });
    });

    it("allows toggling on when requireExtraContextBeforeFlush is true and extra context is empty string", async () => {
      confirmResult = true;
      sessionEntries = [
        {
          type: "custom",
          customType: "hindsight-meta",
          data: { retained: false, extraContext: "" },
        },
      ];
      register({ ...statusTestConfig, requireExtraContextBeforeFlush: true });
      await getHandler()("toggle-retain", makeCtx());
      expect(appendedEntries).toHaveLength(1);
      expect(appendedEntries[0]?.data).toEqual({ retained: true, extraContext: "" });
    });

    it("allows toggling on when requireExtraContextBeforeFlush is true and no meta exists at all", async () => {
      confirmResult = true;
      sessionEntries = []; // no hindsight-meta entries
      register({
        ...statusTestConfig,
        requireExtraContextBeforeFlush: true,
        retainSessionsByDefault: false,
      });
      await getHandler()("toggle-retain", makeCtx());
      // Toggle-retain no longer blocks on missing extra context
      expect(appendedEntries).toHaveLength(1);
    });

    it("allows toggling on when requireExtraContextBeforeFlush is true and meta has no extraContext key", async () => {
      confirmResult = true;
      sessionEntries = [
        {
          type: "custom",
          customType: "hindsight-meta",
          data: { retained: false, tags: ["topic:ai"] },
        },
      ];
      register({ ...statusTestConfig, requireExtraContextBeforeFlush: true });
      await getHandler()("toggle-retain", makeCtx());
      // Toggle-retain no longer blocks on missing extra context
      expect(appendedEntries).toHaveLength(1);
    });
  });

  describe("tag subcommand", () => {
    it("adds a tag to session metadata", async () => {
      register();
      await getHandler()("tag my-tag", makeCtx());
      expect(lastNotification?.message).toContain('Tag "my-tag" added');
      expect(appendedEntries).toHaveLength(1);
      expect(appendedEntries[0]?.customType).toBe("hindsight-meta");
      expect(appendedEntries[0]?.data).toEqual({ tags: ["my-tag"] });
    });

    it("preserves existing retained state when adding tag", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { retained: false } },
      ];
      register();
      await getHandler()("tag my-tag", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ retained: false, tags: ["my-tag"] });
    });

    it("appends to existing tags", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { tags: ["existing"] } },
      ];
      register();
      await getHandler()("tag new-tag", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ tags: ["existing", "new-tag"] });
    });

    it("warns when tag already exists", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { tags: ["existing"] } },
      ];
      register();
      await getHandler()("tag existing", makeCtx());
      expect(lastNotification?.message).toContain('Tag "existing" already exists');
      expect(appendedEntries).toHaveLength(0);
    });

    it("warns when no tag provided", async () => {
      register();
      await getHandler()("tag", makeCtx());
      expect(lastNotification?.message).toContain("Usage");
      expect(appendedEntries).toHaveLength(0);
    });

    it("warns when only whitespace provided", async () => {
      register();
      await getHandler()("tag   ", makeCtx());
      expect(lastNotification?.message).toContain("Usage");
      expect(appendedEntries).toHaveLength(0);
    });
  });

  describe("remove-tag subcommand", () => {
    it("removes a tag from session metadata", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { tags: ["a", "b", "c"] } },
      ];
      register();
      await getHandler()("remove-tag b", makeCtx());
      expect(lastNotification?.message).toContain('Tag "b" removed');
      expect(appendedEntries[0]?.data).toEqual({ tags: ["a", "c"] });
    });

    it("preserves existing retained state when removing tag", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { retained: true, tags: ["a"] } },
      ];
      register();
      await getHandler()("remove-tag a", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ retained: true });
    });

    it("warns when tag not found", async () => {
      sessionEntries = [{ type: "custom", customType: "hindsight-meta", data: { tags: ["a"] } }];
      register();
      await getHandler()("remove-tag z", makeCtx());
      expect(lastNotification?.message).toContain('Tag "z" not found');
      expect(appendedEntries).toHaveLength(0);
    });

    it("warns when no tag provided", async () => {
      register();
      await getHandler()("remove-tag", makeCtx());
      expect(lastNotification?.message).toContain("Usage");
      expect(appendedEntries).toHaveLength(0);
    });

    it("warns when tag not found in empty tag list", async () => {
      register();
      await getHandler()("remove-tag any", makeCtx());
      expect(lastNotification?.message).toContain('Tag "any" not found');
      expect(appendedEntries).toHaveLength(0);
    });
  });

  describe("set-extra-context subcommand", () => {
    it("sets extra context with text args", async () => {
      register();
      await getHandler()("set-extra-context This is fiction", makeCtx());
      expect(lastNotification?.message).toContain("Extra context set");
      expect(appendedEntries).toHaveLength(1);
      expect(appendedEntries[0]?.customType).toBe("hindsight-meta");
      expect(appendedEntries[0]?.data).toEqual({ extraContext: "This is fiction" });
    });

    it("sets extra context to empty string (satisfies flush guard)", async () => {
      register();
      await getHandler()("set-extra-context", makeCtx());
      expect(lastNotification?.message).toContain("No extra context needed");
      expect(appendedEntries).toHaveLength(1);
      expect(appendedEntries[0]?.data).toEqual({ extraContext: "" });
    });

    it("preserves existing retained state when setting extra context", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { retained: false } },
      ];
      register();
      await getHandler()("set-extra-context fiction session", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({
        retained: false,
        extraContext: "fiction session",
      });
    });

    it("preserves existing tags when setting extra context", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { tags: ["topic:ai"] } },
      ];
      register();
      await getHandler()("set-extra-context test", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ tags: ["topic:ai"], extraContext: "test" });
    });

    it("replaces existing extra context", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { extraContext: "old" } },
      ];
      register();
      await getHandler()("set-extra-context new context", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ extraContext: "new context" });
    });

    it("preserves internal newlines/multiline whitespace in the argument", async () => {
      // Regression: argument parsing must only use whitespace to identify the
      // first subcommand token; it must not collapse internal whitespace or
      // newlines (e.g. inserted via Shift+Return) in the remaining args.
      register();
      // "line 1\nline 2" with a literal newline between the two lines.
      await getHandler()("set-extra-context line 1\nline 2", makeCtx());
      expect(appendedEntries).toHaveLength(1);
      expect(appendedEntries[0]?.data).toEqual({ extraContext: "line 1\nline 2" });
    });

    it("preserves multiple spaces and tabs inside the argument", async () => {
      // Regression: internal whitespace runs must not be collapsed to single
      // spaces. Multiple spaces and tabs are significant inside extra context.
      register();
      await getHandler()("set-extra-context line   1\tline\t\t2", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ extraContext: "line   1\tline\t\t2" });
    });

    it("trims only leading/trailing whitespace, preserving internal newlines", async () => {
      // The set-extra-context handler itself trims boundaries; command parsing
      // must hand it the internal-whitespace-preserving string (then the
      // handler trims). Leading/trailing newlines/whitespace are dropped.
      register();
      await getHandler()("set-extra-context   \n  line 1\nline 2  \n  ", makeCtx());
      expect(appendedEntries[0]?.data).toEqual({ extraContext: "line 1\nline 2" });
    });
  });

  describe("status with queue count", () => {
    it("shows queued messages count when session is active", async () => {
      const sessionId = "test-session-123";
      const { removePendingFlag, clearSessionQueueState, touchPendingFlag } = await import(
        "../src/queue"
      );
      try {
        await touchPendingFlag(sessionId);
        register();
        await getHandler()("status", makeCtx());
        expect(lastNotification?.message).toContain("Queued documents: 1");
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("shows queued messages: 0 when queue is empty", async () => {
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Queued documents: 0");
    });

    it("does not show queued messages when no session", async () => {
      register();
      await getHandler()("status", makeCtx(null));
      expect(lastNotification?.message).not.toContain("Queued messages");
    });
  });

  describe("status with retention and tags", () => {
    it("shows retained: yes by default", async () => {
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Retained: yes");
      expect(lastNotification?.message).toContain("Tags: none");
    });

    it("shows retained: no when toggled off", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { retained: false } },
      ];
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Retained: no");
    });

    it("shows retained: no when retainSessionsByDefault is false", async () => {
      register({ ...statusTestConfig, retainSessionsByDefault: false });
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Retained: no");
    });

    it("shows tags from metadata", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { tags: ["topic:ai", "project:x"] } },
      ];
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Tags: topic:ai, project:x");
    });
  });

  describe("flush subcommand", () => {
    it("errors when Hindsight not configured", async () => {
      register(statusTestConfig, null);
      await getHandler()("flush", makeCtx());
      expect(lastNotification?.message).toContain("Hindsight not configured");
    });

    it("errors when no active session", async () => {
      register();
      await getHandler()("flush", makeCtx(null));
      expect(lastNotification?.message).toContain("No active session");
    });

    it("notifies when no active session", async () => {
      register();
      await getHandler()("flush", makeCtx());
      expect(lastNotification?.message).toContain("No active session");
    });

    it("flushes queued messages on success", async () => {
      const sessionId = "test-session-123";
      const { removePendingFlag, clearSessionQueueState, hasPendingFlag, touchPendingFlag } =
        await import("../src/queue");
      const { withTempDir, writeSessionFile } = await import("./fixtures");
      try {
        await touchPendingFlag(sessionId);
        expect(hasPendingFlag(sessionId)).toBe(true);

        let flushCalled = false;
        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => {
          flushCalled = true;
          return { success: true };
        });

        register();
        await withTempDir(async (tmpDir) => {
          const sessionPath = writeSessionFile(tmpDir, sessionId);
          const ctx = {
            ...makeCtx(),
            sessionManager: {
              ...makeCtx().sessionManager,
              getSessionFile: () => sessionPath,
            },
          };
          await getHandler()("flush", ctx);
        });
        expect(flushCalled).toBe(true);
        expect(lastNotification?.message).toContain("Parsed and upserted");
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("shows error on flush failure", async () => {
      const sessionId = "test-session-123";
      const { removePendingFlag, clearSessionQueueState, touchPendingFlag } = await import(
        "../src/queue"
      );
      const { withTempDir, writeSessionFile } = await import("./fixtures");
      try {
        await touchPendingFlag(sessionId);

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: false,
          error: "Server error",
        }));

        register();
        await withTempDir(async (tmpDir) => {
          const sessionPath = writeSessionFile(tmpDir, sessionId);
          const ctx = {
            ...makeCtx(),
            sessionManager: {
              ...makeCtx().sessionManager,
              getSessionFile: () => sessionPath,
            },
          };
          await getHandler()("flush", ctx);
        });
        expect(lastNotification?.message).toContain("error");
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });
  });

  describe("flush-pending subcommand", () => {
    it("errors when Hindsight not configured", async () => {
      register(statusTestConfig, null);
      await getHandler()("flush-pending", makeCtx());
      expect(lastNotification?.message).toContain("Hindsight not configured");
    });

    it("notifies no pending changes when queue is empty", async () => {
      register();
      await getHandler()("flush-pending", makeCtx());
      expect(lastNotification?.message).toContain("No pending changes");
    });

    it("cancels when user declines confirmation", async () => {
      const { touchPendingFlag, removePendingFlag, clearSessionQueueState } = await import(
        "../src/queue"
      );
      const sessionId = "test-flush-pending-cancel";
      try {
        await touchPendingFlag(sessionId);
        confirmResult = false;
        register();
        await getHandler()("flush-pending", makeCtx());
        expect(lastNotification?.message).toContain("Flush cancelled");
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("detects tool-queue-only sessions as pending work", async () => {
      const { enqueueToolMessage, clearSessionQueueState } = await import("../src/queue");
      const sessionId = "test-flush-pending-tool-only";
      try {
        await enqueueToolMessage(sessionId, {
          content: "tool fact",
          timestamp: "2024-01-01T00:00:00Z",
          store_method: "tool",
          sessionId: "test-session",
        });
        confirmResult = false;
        register();
        await getHandler()("flush-pending", makeCtx());
        expect(lastNotification?.message).toContain("Flush cancelled");
      } finally {
        clearSessionQueueState(sessionId);
      }
    });

    it("flushes tool-queue-only session and clears queue", async () => {
      const { enqueueToolMessage, removePendingFlag, clearSessionQueueState } = await import(
        "../src/queue"
      );
      const sessionId = "test-flush-pending-tool-flush";
      try {
        await enqueueToolMessage(sessionId, {
          content: "tool fact",
          timestamp: "2024-01-01T00:00:00Z",
          store_method: "tool",
          sessionId: "test-session",
        });

        mockClient = createMockClient();
        confirmResult = true;
        register();
        await getHandler()("flush-pending", makeCtx());

        expect(mockClient!.retainBatch).toHaveBeenCalled();
        expect(readToolQueueFromDisk(sessionId)).toHaveLength(0);
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("reports error when pending session not found", async () => {
      const { touchPendingFlag, removePendingFlag, clearSessionQueueState } = await import(
        "../src/queue"
      );
      const sessionId = `test-missing-session-${Date.now()}`;
      try {
        await touchPendingFlag(sessionId);
        confirmResult = true;
        register();
        await getHandler()("flush-pending", makeCtx());

        // Per-session notification includes the session ID and reason
        expect(lastNotification?.message).toContain(sessionId);
        expect(lastNotification?.message).toContain("session file not found");
        // No final summary notification
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("flushes tool queue even when session file is missing", async () => {
      const { enqueueToolMessage, touchPendingFlag, removePendingFlag, clearSessionQueueState } =
        await import("../src/queue");
      const sessionId = `test-missing-session-with-tool-${Date.now()}`;
      try {
        // Create both a pending marker (no session file) and a tool queue entry
        await touchPendingFlag(sessionId);
        await enqueueToolMessage(sessionId, {
          content: "tool fact",
          timestamp: "2024-01-01T00:00:00Z",
          store_method: "tool",
          sessionId: "test-session",
        });

        mockClient = createMockClient();
        confirmResult = true;
        register();
        await getHandler()("flush-pending", makeCtx());

        // Per-session error notification for missing session file
        // (may be overwritten by subsequent tool queue notification)
        // Tool queue should still have been flushed
        expect(mockClient!.retainBatch).toHaveBeenCalled();
        expect(readToolQueueFromDisk(sessionId)).toHaveLength(0);
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });
  });

  describe("parse-session subcommand", () => {
    it("shows error when no session file", async () => {
      register();
      await getHandler()("parse-session", makeCtx());
      expect(lastNotification?.message).toContain("No session file found");
      expect(lastNotification?.type).toBe("error");
    });

    it("writes .meta.json not containing lastUpsertedAt", async () => {
      const sessionId = "test-session-meta-no-lastupserted";
      const { getMetaPath } =
        require("../src/parsed-store") as typeof import("../src/parsed-store");
      const { readFileSync } = require("node:fs");

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          messages: [{ role: "user", content: "hello" }],
        });

        register();
        const ctx = {
          ...makeCtx(),
          sessionManager: {
            ...makeCtx().sessionManager,
            getSessionId: () => sessionId,
            getSessionFile: () => sessionPath,
          },
        } as unknown as ExtensionContext;

        await getHandler()("parse-session", ctx);

        const metaContent = readFileSync(getMetaPath(sessionId), "utf-8");
        const writtenMeta = JSON.parse(metaContent);
        // Regression: parsed .meta.json must NOT contain lastUpsertedAt
        expect("lastUpsertedAt" in writtenMeta).toBe(false);
        // Required fields are still present
        expect(writtenMeta.sessionId).toBe(sessionId);
        expect(writtenMeta.messageCount).toBeGreaterThan(0);
        expect(writtenMeta.retained).toBe(true);
      });
    });
  });

  describe("upsert-all-parsed subcommand", () => {
    it("errors when Hindsight not configured", async () => {
      register(statusTestConfig, null);
      await getHandler()("upsert-all-parsed", makeCtx());
      expect(lastNotification?.message).toContain("Hindsight not configured");
    });

    it("notifies when no parsed sessions directory", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      // Ensure directory is absent
      rmSync(parsedDir, { recursive: true, force: true });

      mockClient = createMockClient();
      (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
        success: true,
      }));
      register();
      await getHandler()("upsert-all-parsed", makeCtx());
      expect(lastNotification?.message).toContain("No parsed sessions found");
      expect(mockClient!.retain).not.toHaveBeenCalled();
    });

    it("asks for confirmation before upserting", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      const sessionId = "test-upsert-confirm";

      // Clean any leftovers first
      rmSync(parsedDir, { recursive: true, force: true });
      mkdirSync(parsedDir, { recursive: true });
      writeFileSync(
        join(parsedDir, `${sessionId}.meta.json`),
        JSON.stringify({
          sessionId: sessionId,
          sessionName: "test session",
          extraContext: null,
          sessionUserTags: [],
          tags: [],
          retained: true,
        }),
        "utf8"
      );
      writeFileSync(
        join(parsedDir, `${sessionId}.messages.jsonl`),
        `${JSON.stringify({ role: "user", content: "hello" })}\n`,
        "utf8"
      );

      try {
        let confirmTitle = "";
        let confirmMessage = "";
        confirmResult = true;

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: true,
        }));

        register();

        const trackedCtx = {
          ...makeCtx(),
          ui: {
            ...makeCtx().ui,
            confirm: mock(async (title: string, message: string) => {
              confirmTitle = title;
              confirmMessage = message;
              return confirmResult;
            }),
          },
        } as unknown as ExtensionContext;

        await getHandler()("upsert-all-parsed", trackedCtx);

        expect(confirmTitle).toContain("Upsert all parsed sessions?");
        expect(confirmMessage).toContain("session(s)");
        expect(confirmMessage).toContain("take a long time");
        expect(confirmMessage).toContain("many API requests");
      } finally {
        rmSync(join(parsedDir, `${sessionId}.meta.json`), { force: true });
        rmSync(join(parsedDir, `${sessionId}.messages.jsonl`), { force: true });
      }
    });

    it("cancels upsert when user declines confirmation", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      const sessionId = "test-upsert-cancel";

      rmSync(parsedDir, { recursive: true, force: true });
      mkdirSync(parsedDir, { recursive: true });
      writeFileSync(
        join(parsedDir, `${sessionId}.meta.json`),
        JSON.stringify({
          sessionId: sessionId,
          sessionName: "test session",
          extraContext: null,
          sessionUserTags: [],
          tags: [],
          retained: true,
        }),
        "utf8"
      );
      writeFileSync(
        join(parsedDir, `${sessionId}.messages.jsonl`),
        `${JSON.stringify({ role: "user", content: "hello" })}\n`,
        "utf8"
      );

      try {
        confirmResult = false;

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: true,
        }));

        register();

        const trackedCtx = {
          ...makeCtx(),
          ui: {
            ...makeCtx().ui,
            confirm: mock(async () => false),
          },
        } as unknown as ExtensionContext;

        await getHandler()("upsert-all-parsed", trackedCtx);

        expect(lastNotification?.message).toContain("Upsert cancelled");
        expect(mockClient!.retain).not.toHaveBeenCalled();
      } finally {
        rmSync(join(parsedDir, `${sessionId}.meta.json`), { force: true });
        rmSync(join(parsedDir, `${sessionId}.messages.jsonl`), { force: true });
      }
    });

    it("proceeds with upsert when user accepts confirmation", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      const sessionId = "test-upsert-proceed";

      rmSync(parsedDir, { recursive: true, force: true });
      mkdirSync(parsedDir, { recursive: true });
      writeFileSync(
        join(parsedDir, `${sessionId}.meta.json`),
        JSON.stringify({
          sessionId: sessionId,
          sessionName: "test session",
          retained: true,
          extraContext: null,
          sessionUserTags: [],
          sessionCwd: "/test/project",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
        }),
        "utf8"
      );
      writeFileSync(
        join(parsedDir, `${sessionId}.messages.jsonl`),
        `${JSON.stringify({ role: "user", content: "hello" })}\n`,
        "utf8"
      );

      try {
        confirmResult = true;

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: true,
        }));

        register();

        const trackedCtx = {
          ...makeCtx(),
          ui: {
            ...makeCtx().ui,
            confirm: mock(async () => true),
          },
        } as unknown as ExtensionContext;

        await getHandler()("upsert-all-parsed", trackedCtx);

        expect(mockClient!.retain).toHaveBeenCalled();
        expect(lastNotification?.message).toContain("Successfully upserted");
      } finally {
        rmSync(join(parsedDir, `${sessionId}.meta.json`), { force: true });
        rmSync(join(parsedDir, `${sessionId}.messages.jsonl`), { force: true });
      }
    });

    it("skips sessions with retained=false", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");

      rmSync(parsedDir, { recursive: true, force: true });
      mkdirSync(parsedDir, { recursive: true });

      // Session with retained=true should be upserted
      writeFileSync(
        join(parsedDir, "retained-session.meta.json"),
        JSON.stringify({
          sessionId: "retained-session",
          sessionName: "retained session",
          tags: [],
          retained: true,
          sessionCwd: "/test/project",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          extraContext: null,
          sessionUserTags: [],
        }),
        "utf8"
      );
      writeFileSync(
        join(parsedDir, "retained-session.messages.jsonl"),
        `${JSON.stringify({ role: "user", content: "retained" })}\n`,
        "utf8"
      );

      // Session with retained=false should be skipped
      writeFileSync(
        join(parsedDir, "not-retained-session.meta.json"),
        JSON.stringify({
          sessionId: "not-retained-session",
          sessionName: "not retained session",
          tags: [],
          retained: false,
          sessionCwd: "/test/project",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          extraContext: null,
          sessionUserTags: [],
        }),
        "utf8"
      );
      writeFileSync(
        join(parsedDir, "not-retained-session.messages.jsonl"),
        `${JSON.stringify({ role: "user", content: "not retained" })}\n`,
        "utf8"
      );

      try {
        confirmResult = true;

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: true,
        }));

        register();

        await getHandler()("upsert-all-parsed", makeCtx());

        // Only the retained session should be upserted
        expect(mockClient!.retain).toHaveBeenCalledTimes(1);
        expect(lastNotification?.message).toContain("Successfully upserted 1 sessions");
      } finally {
        rmSync(join(parsedDir, "retained-session.meta.json"), { force: true });
        rmSync(join(parsedDir, "retained-session.messages.jsonl"), { force: true });
        rmSync(join(parsedDir, "not-retained-session.meta.json"), { force: true });
        rmSync(join(parsedDir, "not-retained-session.messages.jsonl"), { force: true });
      }
    });

    it("reports parsed sessions with missing retained metadata as malformed", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      const sessionId = "missing-retained-session";

      rmSync(parsedDir, { recursive: true, force: true });
      mkdirSync(parsedDir, { recursive: true });
      writeFileSync(
        join(parsedDir, `${sessionId}.meta.json`),
        JSON.stringify({
          sessionId: sessionId,
          sessionName: "missing retained session",
          sessionUserTags: [],
          sessionCwd: "/test/project",
          sessionTimestamp: new Date().toISOString(),
          messageCount: 1,
          extraContext: null,
        }),
        "utf8"
      );
      writeFileSync(
        join(parsedDir, `${sessionId}.messages.jsonl`),
        `${JSON.stringify({ role: "user", content: "missing retained" })}\n`,
        "utf8"
      );

      try {
        confirmResult = true;

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: true,
        }));

        register();

        await getHandler()("upsert-all-parsed", makeCtx());

        expect(mockClient!.retain).not.toHaveBeenCalled();
        expect(lastNotification?.message).toContain("Invalid or malformed");
      } finally {
        rmSync(join(parsedDir, `${sessionId}.meta.json`), { force: true });
        rmSync(join(parsedDir, `${sessionId}.messages.jsonl`), { force: true });
      }
    });

    it("reports malformed parseable .meta.json as invalid", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      const sessionId = "malformed-meta-session";

      rmSync(parsedDir, { recursive: true, force: true });
      mkdirSync(parsedDir, { recursive: true });
      // Valid JSON but structurally invalid (missing required fields)
      writeFileSync(
        join(parsedDir, `${sessionId}.meta.json`),
        JSON.stringify({ sessionId: sessionId }),
        "utf8"
      );
      writeFileSync(
        join(parsedDir, `${sessionId}.messages.jsonl`),
        `${JSON.stringify({ role: "user", content: "hello" })}\n`,
        "utf8"
      );

      try {
        confirmResult = true;

        mockClient = createMockClient();
        register();

        await getHandler()("upsert-all-parsed", makeCtx());

        expect(mockClient!.retain).not.toHaveBeenCalled();
        expect(lastNotification?.message).toContain("failed");
        expect(lastNotification?.message).toContain("Invalid or malformed");
      } finally {
        rmSync(join(parsedDir, `${sessionId}.meta.json`), { force: true });
        rmSync(join(parsedDir, `${sessionId}.messages.jsonl`), { force: true });
      }
    });

    it("stops upsert loop when signal is already aborted", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");

      rmSync(parsedDir, { recursive: true, force: true });
      mkdirSync(parsedDir, { recursive: true });

      const sessionIds = ["abort-s1", "abort-s2"];
      for (const sid of sessionIds) {
        writeFileSync(
          join(parsedDir, `${sid}.meta.json`),
          JSON.stringify({
            sessionId: sid,
            sessionName: `${sid} session`,
            retained: true,
            extraContext: null,
            sessionUserTags: [],
            sessionCwd: "/test",
            sessionTimestamp: new Date().toISOString(),
            messageCount: 1,
          }),
          "utf8"
        );
        writeFileSync(
          join(parsedDir, `${sid}.messages.jsonl`),
          `${JSON.stringify({ role: "user", content: "hello" })}\n`,
          "utf8"
        );
      }

      try {
        confirmResult = true;

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: true,
        }));
        register();

        const controller = new AbortController();
        controller.abort();

        const abortedCtx = {
          ...makeCtx(),
          signal: controller.signal,
        } as unknown as ExtensionContext;

        await getHandler()("upsert-all-parsed", abortedCtx);

        expect(mockClient!.retain).not.toHaveBeenCalled();
        expect(lastNotification?.message).toContain("cancelled");
      } finally {
        for (const sid of sessionIds) {
          rmSync(join(parsedDir, `${sid}.meta.json`), { force: true });
          rmSync(join(parsedDir, `${sid}.messages.jsonl`), { force: true });
        }
      }
    });

    it("stops upsert loop when signal aborts between iterations", async () => {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");

      rmSync(parsedDir, { recursive: true, force: true });
      mkdirSync(parsedDir, { recursive: true });

      const sessionIds = ["mid-abort-s1", "mid-abort-s2"];
      for (const sid of sessionIds) {
        writeFileSync(
          join(parsedDir, `${sid}.meta.json`),
          JSON.stringify({
            sessionId: sid,
            sessionName: `${sid} session`,
            retained: true,
            extraContext: null,
            sessionUserTags: [],
            sessionCwd: "/test",
            sessionTimestamp: new Date().toISOString(),
            messageCount: 1,
          }),
          "utf8"
        );
        writeFileSync(
          join(parsedDir, `${sid}.messages.jsonl`),
          `${JSON.stringify({ role: "user", content: "hello" })}\n`,
          "utf8"
        );
      }

      try {
        confirmResult = true;

        const controller = new AbortController();
        let retainCallCount = 0;

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => {
          retainCallCount++;
          // Abort after the first session is upserted
          if (retainCallCount === 1) {
            controller.abort();
          }
          return { success: true };
        });
        register();

        const abortedCtx = {
          ...makeCtx(),
          signal: controller.signal,
        } as unknown as ExtensionContext;

        await getHandler()("upsert-all-parsed", abortedCtx);

        // First session should have been upserted, second should not
        expect(mockClient!.retain).toHaveBeenCalledTimes(1);
        expect(lastNotification?.message).toContain("cancelled after 1");
      } finally {
        for (const sid of sessionIds) {
          rmSync(join(parsedDir, `${sid}.meta.json`), { force: true });
          rmSync(join(parsedDir, `${sid}.messages.jsonl`), { force: true });
        }
      }
    });
  });

  describe("toggle-display subcommand", () => {
    it("warns when autoRecallPersist is false", async () => {
      register(); // autoRecallPersist: false by default
      await getHandler()("toggle-display", makeCtx());
      expect(lastNotification?.message).toContain("Cannot toggle display");
      expect(lastNotification?.message).toContain("autoRecallPersist is false");
    });

    it("toggles display from hidden to visible when autoRecallPersist is true", async () => {
      register({ ...statusTestConfig, autoRecallPersist: true, autoRecallDisplay: false });
      await getHandler()("toggle-display", makeCtx());
      expect(lastNotification?.message).toContain("Recall display: visible");
    });

    it("toggles display from visible to hidden when autoRecallPersist is true", async () => {
      register({ ...statusTestConfig, autoRecallPersist: true, autoRecallDisplay: true });
      await getHandler()("toggle-display", makeCtx());
      expect(lastNotification?.message).toContain("Recall display: hidden");
    });

    it("respects existing override", async () => {
      autoRecallDisplayOverride = true;
      register({ ...statusTestConfig, autoRecallPersist: true, autoRecallDisplay: false });
      await getHandler()("toggle-display", makeCtx());
      expect(lastNotification?.message).toContain("Recall display: hidden");
    });
  });

  describe("popup subcommand", () => {
    it("shows 'No recall this session' when no recall has happened", async () => {
      register();
      await getHandler()("popup", makeCtx());
      expect(lastNotification?.message).toContain("No recall this session");
    });

    it("invokes overlay with recall details when recall has occurred", async () => {
      recallDetails = {
        count: 3,
        snippet: "Memory 1 · Memory 2",
        memories: "Memory 1\n\n---\n\nMemory 2\n\n---\n\nMemory 3",
      };
      register();

      let overlayCalled = false;
      let overlayDetails: RecallMessageDetails | null = null;

      const ctx = {
        ...makeCtx(),
        ui: {
          ...makeCtx().ui,
          custom: mock(async (_factory: unknown) => {
            overlayCalled = true;
            // Capture what would have been passed to RecallOverlayComponent
            overlayDetails = recallDetails;
          }),
        },
      } as unknown as ExtensionContext;

      await getHandler()("popup", ctx);

      expect(overlayCalled).toBe(true);
      expect((overlayDetails as RecallMessageDetails | null)?.count).toBe(3);
    });

    it("uses singular 'memory' for count of 1 in popup", async () => {
      recallDetails = {
        count: 1,
        snippet: "Single memory",
        memories: "Single memory",
      };
      register();

      let overlayDetails: RecallMessageDetails | null = null;

      const ctx = {
        ...makeCtx(),
        ui: {
          ...makeCtx().ui,
          custom: mock(async () => {
            overlayDetails = recallDetails;
          }),
        },
      } as unknown as ExtensionContext;

      await getHandler()("popup", ctx);

      expect((overlayDetails as RecallMessageDetails | null)?.count).toBe(1);
    });
  });

  describe("filename mismatch regression (GLM bug 1)", () => {
    it("parse-session reports path using header.id, not sessionId", async () => {
      const sessionId = "test-session-abc123";

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId);

        register();
        const ctx = {
          ...makeCtx(),
          sessionManager: {
            ...makeCtx().sessionManager,
            getSessionFile: () => sessionPath,
          },
        } as unknown as ExtensionContext;

        await getHandler()("parse-session", ctx);
        expect(lastNotification?.message).toContain(sessionId);
        expect(lastNotification?.message).not.toContain("session:test-session-abc123.jsonl");
      });
    });
  });

  describe("warning swallowed regression (GLM bug 2)", () => {
    it("parse-session shows specific warning instead of generic message", async () => {
      const sessionId = "test-session-fork1";

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          parentSession: "/nonexistent/parent-session.jsonl",
          messages: [],
        });

        register();
        const ctx = {
          ...makeCtx(),
          sessionManager: {
            ...makeCtx().sessionManager,
            getSessionId: () => sessionId,
            getSessionFile: () => sessionPath,
          },
        } as unknown as ExtensionContext;

        await getHandler()("parse-session", ctx);
        expect(lastNotification?.message).toContain("Cannot determine fork point");
        expect(lastNotification?.message).not.toContain("No messages to parse");
        expect(lastNotification?.type).toBe("warning");
      });
    });

    it("parse-and-upsert-session shows specific warning instead of generic message", async () => {
      const sessionId = "test-session-fork2";

      await withTempDir(async (tmpDir) => {
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          parentSession: "/nonexistent/parent-session.jsonl",
          messages: [],
        });

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: true,
        }));

        register();
        const ctx = {
          ...makeCtx(),
          sessionManager: {
            ...makeCtx().sessionManager,
            getSessionId: () => sessionId,
            getSessionFile: () => sessionPath,
          },
        } as unknown as ExtensionContext;

        await getHandler()("parse-and-upsert-session", ctx);
        expect(lastNotification?.message).toContain("Cannot determine fork point");
        expect(lastNotification?.message).not.toContain("No messages to parse");
        expect(lastNotification?.type).toBe("warning");
      });
    });
  });

  describe("parentSession path regression (GLM bug 3)", () => {
    it("flush subcommand extracts session ID from parent path, falls back to sessionId when parent is absent", async () => {
      const sessionId = "test-session-123";
      const { removePendingFlag, clearSessionQueueState, touchPendingFlag } = await import(
        "../src/queue"
      );
      const { withTempDir, writeSessionFile } = await import("./fixtures");
      try {
        await touchPendingFlag(sessionId);

        let retainCalled = false;
        let retainTags: string[] | undefined;
        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(
          async (params: { tags?: string[] }) => {
            retainCalled = true;
            retainTags = params.tags;
            return { success: true };
          }
        );

        register();
        await withTempDir(async (tmpDir) => {
          // Write a parent session file so fork detection works
          writeSessionFile(tmpDir, "parent-uuid-456", {
            messages: [
              { role: "user", content: "Hi" },
              { role: "assistant", content: "Hello" },
            ],
          });
          const sessionPath = writeSessionFile(tmpDir, sessionId, {
            parentSession: join(tmpDir, "parent-uuid-456.jsonl"),
            messages: [
              { role: "user", content: "Hi" },
              { role: "assistant", content: "Hello there" },
            ],
          });
          const ctx = {
            ...makeCtx(),
            sessionManager: {
              ...makeCtx().sessionManager,
              getSessionFile: () => sessionPath,
              getHeader: () => ({
                timestamp: new Date().toISOString(),
                cwd: "/test",
                parentSession: join(tmpDir, "parent-uuid-456.jsonl"),
              }),
            },
          } as unknown as ExtensionContext;

          await getHandler()("flush", ctx);
        });
        expect(retainCalled).toBe(true);
        const parentTag = retainTags?.find((t: string) => t.startsWith("parent:"));
        expect(parentTag).toBeDefined();
        expect(parentTag).not.toContain("/");
        expect(parentTag).not.toContain(".pi/sessions");
        expect(parentTag).toBe(`parent:parent-uuid-456`);
      } finally {
        removePendingFlag(sessionId);
        clearSessionQueueState(sessionId);
      }
    });

    it("flush subcommand uses extracted parent ID when parent file exists", async () => {
      const sessionId = "test-session-123";
      const { removePendingFlag, clearSessionQueueState, touchPendingFlag } = await import(
        "../src/queue"
      );

      await withTempDir(async (tmpDir) => {
        const parentPath = writeSessionFile(tmpDir, "parent-uuid-789", {
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello" },
          ],
        });
        const sessionPath = writeSessionFile(tmpDir, sessionId, {
          parentSession: parentPath,
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello there" },
          ],
        });

        try {
          await touchPendingFlag(sessionId);

          let retainTags: string[] | undefined;
          mockClient = createMockClient();
          (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(
            async (params: { tags?: string[] }) => {
              retainTags = params.tags;
              return { success: true };
            }
          );

          const ctx = {
            ...makeCtx(),
            sessionManager: {
              ...makeCtx().sessionManager,
              getSessionFile: () => sessionPath,
              getHeader: () => ({
                timestamp: new Date().toISOString(),
                cwd: "/test",
                parentSession: parentPath,
              }),
            },
          } as unknown as ExtensionContext;

          register();
          await getHandler()("flush", ctx);
          const parentTag = retainTags?.find((t: string) => t.startsWith("parent:"));
          expect(parentTag).toBeDefined();
          expect(parentTag).toBe("parent:parent-uuid-789");
          expect(parentTag).not.toContain("/");
        } finally {
          removePendingFlag(sessionId);
          clearSessionQueueState(sessionId);
        }
      });
    });
  });

  describe("subcommand completion", () => {
    it("provides completions for subcommand names", async () => {
      register();
      const completions = await getCompletions()("sta");
      expect(completions).not.toBeNull();
      expect(completions!.some((c: { value: string }) => c.value === "status")).toBe(true);
    });

    it("returns null for non-matching prefix", async () => {
      register();
      const completions = await getCompletions()("xyz");
      expect(completions).toBeNull();
    });

    it("completes all subcommands with empty prefix", async () => {
      register();
      const completions = await getCompletions()("");
      expect(completions).not.toBeNull();
      expect(completions?.length).toBeGreaterThanOrEqual(8);
    });
  });
});
