/**
 * Unit tests for slash commands.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HindsightClientWrapper } from "../src/client";
import { registerCommands } from "../src/commands";
import type { RecallMessageDetails } from "../src/index";
import { createMockClient, statusTestConfig } from "./fixtures";

interface RegisteredCmd {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  getArgumentCompletions?: (
    argumentPrefix: string
  ) => Promise<Array<{ label: string; value: string; description?: string }> | null>;
}

describe("registerCommands", () => {
  let registeredCommands: Map<string, RegisteredCmd>;
  let mockPi: { registerCommand: ReturnType<typeof mock>; appendEntry: ReturnType<typeof mock> };
  let mockClient: HindsightClientWrapper | null;
  let recallDetails: RecallMessageDetails | null;
  let recallDisplayOverride: boolean | null;
  let lastNotification: { message: string; type: string } | null;
  let appendedEntries: { customType: string; data?: unknown }[];
  let sessionEntries: unknown[];
  let confirmResult: boolean;

  beforeEach(() => {
    // Fresh state for every test — prevents mockClient mutation from leaking
    registeredCommands = new Map();
    recallDetails = null;
    recallDisplayOverride = null;
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
    } as unknown as typeof mockPi;
  });

  function register(config = statusTestConfig, client = mockClient) {
    registerCommands(
      mockPi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI,
      config,
      client,
      () => recallDetails,
      () => recallDisplayOverride,
      () => {
        recallDisplayOverride = !recallDisplayOverride;
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
      mockPi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI,
      statusTestConfig,
      mockClient,
      () => recallDetails,
      () => recallDisplayOverride,
      () => {
        recallDisplayOverride = !recallDisplayOverride;
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

    it("shows 'Types: all' when recallTypes is null", async () => {
      register({ ...statusTestConfig, recallTypes: null });
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
    });

    it("deletes queued messages after upsert to prevent duplication", async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
      const sessionPath = join(tmpDir, "test-session-123.jsonl");
      const { writeFileSync: writeFile } = await import("node:fs");

      const header = JSON.stringify({
        type: "session",
        id: "test-session-123",
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      const message = JSON.stringify({
        type: "message",
        message: { role: "user", content: "Hello world" },
      });
      writeFile(sessionPath, `${header}\n${message}\n`, "utf8");

      const sessionId = "test-session-123";
      const { enqueueAutoMessage, readAutoQueue, deleteAutoQueue, deleteToolQueue } = await import(
        "../src/queue"
      );

      try {
        enqueueAutoMessage(sessionId, {
          entry: { message: { role: "user", content: "Hello" } },
          store_method: "auto",
        });
        expect(readAutoQueue(sessionId)).toHaveLength(1);

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

        expect(readAutoQueue(sessionId)).toHaveLength(0);
        expect(retainCalled).toBe(true);
        expect(lastNotification?.message).toContain("Parsed and upserted");
      } finally {
        deleteAutoQueue(sessionId);
        deleteToolQueue(sessionId);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not error when no queue files exist", async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
      const sessionPath = join(tmpDir, "test-session-123.jsonl");
      const { writeFileSync: writeFile } = await import("node:fs");

      const header = JSON.stringify({
        type: "session",
        id: "test-session-123",
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      const message = JSON.stringify({
        type: "message",
        message: { role: "user", content: "Hello world" },
      });
      writeFile(sessionPath, `${header}\n${message}\n`, "utf8");

      const sessionId = "test-session-123";
      const { deleteAutoQueue, deleteToolQueue } = await import("../src/queue");

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
        deleteAutoQueue(sessionId);
        deleteToolQueue(sessionId);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("toggle-retain subcommand", () => {
    it("toggles retention off, deletes queue files", async () => {
      const sessionId = "test-session-123";
      const { enqueueAutoMessage, readAutoQueue, deleteAutoQueue, deleteToolQueue } = await import(
        "../src/queue"
      );
      try {
        enqueueAutoMessage(sessionId, {
          entry: { message: { role: "user", content: "Hello" } },
          store_method: "auto",
        });
        expect(readAutoQueue(sessionId)).toHaveLength(1);

        register();
        await getHandler()("toggle-retain", makeCtx());

        expect(readAutoQueue(sessionId)).toHaveLength(0);
        expect(lastNotification?.message).toContain("disabled");
        expect(appendedEntries).toHaveLength(1);
        expect(appendedEntries[0]?.data).toEqual({ retained: false });
      } finally {
        deleteAutoQueue(sessionId);
        deleteToolQueue(sessionId);
      }
    });

    it("toggles retention on with confirm=yes, appends meta and deletes queue", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { retained: false } },
      ];
      confirmResult = true;
      register();
      await getHandler()("toggle-retain", makeCtx());
      expect(appendedEntries).toHaveLength(1);
      expect(appendedEntries[0]?.data).toEqual({ retained: true });
      expect(lastNotification?.message).toContain("enabled");
    });

    it("toggles retention on with confirm=no, does not enable", async () => {
      sessionEntries = [
        { type: "custom", customType: "hindsight-meta", data: { retained: false } },
      ];
      confirmResult = false;
      register();
      await getHandler()("toggle-retain", makeCtx());
      expect(appendedEntries).toHaveLength(0);
      expect(lastNotification?.message).toContain("Retention not enabled");
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

  describe("status with queue count", () => {
    it("shows queued messages count when session is active", async () => {
      const sessionId = "test-session-123";
      const { enqueueAutoMessage, deleteAutoQueue, deleteToolQueue } = await import("../src/queue");
      try {
        enqueueAutoMessage(sessionId, {
          entry: { message: { role: "user", content: "Hello" } },
          store_method: "auto",
        });
        register();
        await getHandler()("status", makeCtx());
        expect(lastNotification?.message).toContain("Queued messages: 1");
      } finally {
        deleteAutoQueue(sessionId);
        deleteToolQueue(sessionId);
      }
    });

    it("shows queued messages: 0 when queue is empty", async () => {
      register();
      await getHandler()("status", makeCtx());
      expect(lastNotification?.message).toContain("Queued messages: 0");
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

    it("notifies when no messages queued", async () => {
      register();
      await getHandler()("flush", makeCtx());
      expect(lastNotification?.message).toContain("No messages queued");
    });

    it("flushes queued messages on success", async () => {
      const sessionId = "test-session-123";
      const { enqueueAutoMessage, readAutoQueue, deleteAutoQueue, deleteToolQueue } = await import(
        "../src/queue"
      );
      try {
        enqueueAutoMessage(sessionId, {
          entry: { message: { role: "user", content: "Hello" } },
          store_method: "auto",
        });
        expect(readAutoQueue(sessionId)).toHaveLength(1);

        let flushCalled = false;
        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => {
          flushCalled = true;
          return { success: true };
        });

        register();
        await getHandler()("flush", makeCtx());
        expect(flushCalled).toBe(true);
        expect(lastNotification?.message).toContain("Flushed");
      } finally {
        deleteAutoQueue(sessionId);
        deleteToolQueue(sessionId);
      }
    });

    it("shows error on flush failure", async () => {
      const sessionId = "test-session-123";
      const { enqueueAutoMessage, deleteAutoQueue, deleteToolQueue } = await import("../src/queue");
      try {
        enqueueAutoMessage(sessionId, {
          entry: { message: { role: "user", content: "Hello" } },
          store_method: "auto",
        });

        mockClient = createMockClient();
        (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: false,
          error: "Server error",
        }));

        register();
        await getHandler()("flush", makeCtx());
        expect(lastNotification?.message).toContain("Flush failed");
      } finally {
        deleteAutoQueue(sessionId);
        deleteToolQueue(sessionId);
      }
    });
  });

  describe("parse-session subcommand", () => {
    it("shows error when no session file", async () => {
      register();
      await getHandler()("parse-session", makeCtx());
      expect(lastNotification?.message).toContain("No session file found");
    });
  });

  describe("upsert-all-parsed subcommand", () => {
    it("errors when Hindsight not configured", async () => {
      register(statusTestConfig, null);
      await getHandler()("upsert-all-parsed", makeCtx());
      expect(lastNotification?.message).toContain("Hindsight not configured");
    });

    it("notifies when no parsed sessions directory", async () => {
      mockClient = createMockClient();
      (mockClient!.retain as ReturnType<typeof mock>).mockImplementation(async () => ({
        success: true,
      }));
      register();
      await getHandler()("upsert-all-parsed", makeCtx());
      expect(lastNotification?.message).toBeDefined();
    });

    it("asks for confirmation before upserting", async () => {
      const { mkdirSync, writeFileSync: writeFile, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { getAgentDir } = await import("@mariozechner/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      const testFile = join(parsedDir, "test-upsert-confirm.jsonl");

      mkdirSync(parsedDir, { recursive: true });
      writeFile(
        testFile,
        JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          documentId: "doc-confirm-test",
          context: "test",
          timestamp: new Date().toISOString(),
          tags: [],
        }),
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
        rmSync(testFile, { force: true });
      }
    });

    it("cancels upsert when user declines confirmation", async () => {
      const { mkdirSync, writeFileSync: writeFile, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { getAgentDir } = await import("@mariozechner/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      const testFile = join(parsedDir, "test-upsert-cancel.jsonl");

      mkdirSync(parsedDir, { recursive: true });
      writeFile(
        testFile,
        JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          documentId: "doc-cancel-test",
          context: "test",
          timestamp: new Date().toISOString(),
          tags: [],
        }),
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
      } finally {
        rmSync(testFile, { force: true });
      }
    });

    it("proceeds with upsert when user accepts confirmation", async () => {
      const { mkdirSync, writeFileSync: writeFile, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { getAgentDir } = await import("@mariozechner/pi-coding-agent");
      const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
      const testFile = join(parsedDir, "test-upsert-proceed.jsonl");

      mkdirSync(parsedDir, { recursive: true });
      writeFile(
        testFile,
        JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          documentId: "doc-proceed-test",
          context: "test",
          timestamp: new Date().toISOString(),
          tags: [],
        }),
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

        expect(lastNotification?.message).toContain("Successfully upserted");
      } finally {
        rmSync(testFile, { force: true });
      }
    });
  });

  describe("toggle-display subcommand", () => {
    it("warns when recallPersist is false", async () => {
      register(); // recallPersist: false by default
      await getHandler()("toggle-display", makeCtx());
      expect(lastNotification?.message).toContain("Cannot toggle display");
      expect(lastNotification?.message).toContain("recallPersist is false");
    });

    it("toggles display from hidden to visible when recallPersist is true", async () => {
      register({ ...statusTestConfig, recallPersist: true, recallDisplay: false });
      await getHandler()("toggle-display", makeCtx());
      expect(lastNotification?.message).toContain("Recall display: visible");
    });

    it("toggles display from visible to hidden when recallPersist is true", async () => {
      register({ ...statusTestConfig, recallPersist: true, recallDisplay: true });
      await getHandler()("toggle-display", makeCtx());
      expect(lastNotification?.message).toContain("Recall display: hidden");
    });

    it("respects existing override", async () => {
      recallDisplayOverride = true;
      register({ ...statusTestConfig, recallPersist: true, recallDisplay: false });
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
    it("parse-session reports path using header.id, not documentId", async () => {
      const { mkdtempSync, rmSync, writeFileSync: writeFile } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
      const sessionId = "test-session-abc123";
      const sessionPath = join(tmpDir, `${sessionId}.jsonl`);

      const header = JSON.stringify({
        type: "session",
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      const message = JSON.stringify({
        type: "message",
        message: { role: "user", content: "Hello world" },
      });
      writeFile(sessionPath, `${header}\n${message}\n`, "utf8");

      try {
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
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("warning swallowed regression (GLM bug 2)", () => {
    it("parse-session shows specific warning instead of generic message", async () => {
      const { mkdtempSync, rmSync, writeFileSync: writeFile } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
      const sessionId = "test-session-fork1";
      const sessionPath = join(tmpDir, `${sessionId}.jsonl`);

      const header = JSON.stringify({
        type: "session",
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: "/test",
        parentSession: "/nonexistent/parent-session.jsonl",
      });
      writeFile(sessionPath, `${header}\n`, "utf8");

      try {
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
        expect(lastNotification?.message).toContain("Parent session not found");
        expect(lastNotification?.message).not.toContain("No messages to parse");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("parse-and-upsert-session shows specific warning instead of generic message", async () => {
      const { mkdtempSync, rmSync, writeFileSync: writeFile } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
      const sessionId = "test-session-fork2";
      const sessionPath = join(tmpDir, `${sessionId}.jsonl`);

      const header = JSON.stringify({
        type: "session",
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: "/test",
        parentSession: "/nonexistent/parent-session.jsonl",
      });
      writeFile(sessionPath, `${header}\n`, "utf8");

      try {
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
        expect(lastNotification?.message).toContain("Parent session not found");
        expect(lastNotification?.message).not.toContain("No messages to parse");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("parentSession path regression (GLM bug 3)", () => {
    it("flush subcommand extracts session ID from parent path, falls back to sessionId when parent is absent", async () => {
      const sessionId = "test-session-123";
      const { enqueueAutoMessage, deleteAutoQueue, deleteToolQueue } = await import("../src/queue");
      try {
        enqueueAutoMessage(sessionId, {
          entry: { message: { role: "user", content: "Hello" } },
          store_method: "auto",
        });

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

        const ctx = {
          ...makeCtx(),
          sessionManager: {
            ...makeCtx().sessionManager,
            getHeader: () => ({
              timestamp: new Date().toISOString(),
              cwd: "/test",
              parentSession: "/home/user/.pi/sessions/parent-uuid-456.jsonl",
            }),
          },
        } as unknown as ExtensionContext;

        register();
        await getHandler()("flush", ctx);
        expect(retainCalled).toBe(true);
        const parentTag = retainTags?.find((t: string) => t.startsWith("parent:"));
        expect(parentTag).toBeDefined();
        expect(parentTag).not.toContain("/");
        expect(parentTag).not.toContain(".pi/sessions");
        expect(parentTag).toBe(`parent:${sessionId}`);
      } finally {
        deleteAutoQueue(sessionId);
        deleteToolQueue(sessionId);
      }
    });

    it("flush subcommand uses extracted parent ID when parent file exists", async () => {
      const { mkdtempSync, rmSync, writeFileSync: writeFile } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
      const sessionId = "test-session-123";
      const parentPath = join(tmpDir, "parent-uuid-789.jsonl");

      writeFile(
        parentPath,
        `${JSON.stringify({ type: "session", id: "parent-uuid-789", timestamp: new Date().toISOString(), cwd: "/test" })}\n`,
        "utf8"
      );

      const { enqueueAutoMessage, deleteAutoQueue, deleteToolQueue } = await import("../src/queue");
      try {
        enqueueAutoMessage(sessionId, {
          entry: { message: { role: "user", content: "Hello" } },
          store_method: "auto",
        });

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
        deleteAutoQueue(sessionId);
        deleteToolQueue(sessionId);
        rmSync(tmpDir, { recursive: true, force: true });
      }
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
