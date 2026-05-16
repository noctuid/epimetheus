/**
 * Shared test fixtures and helpers for pi-hindsight tests.
 *
 * Centralizes config objects, mock factories, and common types
 * to avoid duplication across test files.
 */

import { mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HindsightClientWrapper } from "../src/client";
import type { HindsightConfig } from "../src/config";

// ============================================
// Shared config objects
// ============================================

/** Standard HindsightConfig for most tests. Override specific fields as needed. */
export const testConfig: HindsightConfig = {
  enabled: true,
  apiUrl: "https://test.vectorize.io",
  apiKey: "test-key",
  bankId: "test-bank",
  toolsEnabled: true,
  autoRecallEnabled: true,
  autoRecallBudget: "mid",
  autoRetainEnabled: true,
  hindsightContextPrefix: "pi: ",
  hindsightContextMaxLength: 100,
  maxRecallTokens: null,
  recallPromptPreamble: "Test preamble",
  recallShowDateTime: true,
  autoRecallDisplay: false,
  autoRecallPersist: false,
  recallMaxQueryChars: 800,
  recallTypes: ["observation"],
  autoRecallTags: null,
  autoRecallTagsMatch: "any",
  autoRecallTagGroups: null,
  constantTags: ["test"],
  retainContent: { assistant: ["text"], user: ["text"], toolResult: [] },
  strip: { topLevel: ["type"], message: ["api"] },
  toolFilter: {},
  flushOnCompact: false,
  entities: [],
  observationScopes: [["{session}"]] as string[][],
  statusHealthy: "🧠",
  retainSessionsByDefault: true,
  statusUnhealthy: "🤯",
};

/** Config with all retainContent types enabled (assistant: text+thinking+toolCall, user: text, toolResult: text). */
export const fullRetainConfig: HindsightConfig = {
  ...testConfig,
  retainContent: {
    assistant: ["text", "thinking", "toolCall"],
    user: ["text"],
    toolResult: ["text"],
  },
};

/** Config for status tests (with API key). */
export const statusTestConfig: HindsightConfig = {
  ...testConfig,
  apiKey: "test-api-key-12345",
  recallPromptPreamble: "Test preamble",
};

// ============================================
// Mock factories
// ============================================

/** Create a mock HindsightClientWrapper. Each call returns a fresh instance. */
export function createMockClient(
  options: {
    healthCheckResult?: { success: boolean; error?: string };
    retainResult?: { success: boolean; error?: string };
    retainBatchResult?: { success: boolean; error?: string };
    recallResult?: {
      success: boolean;
      response?: { results: Array<{ id: string; text: string }> };
      error?: string;
    };
    reflectResult?: { success: boolean; response?: { text: string }; error?: string };
  } = {}
): HindsightClientWrapper {
  return {
    healthCheck: mock(() => Promise.resolve(options.healthCheckResult ?? { success: true })),
    retain: mock(() => Promise.resolve(options.retainResult ?? { success: true })),
    retainBatch: mock(() => Promise.resolve(options.retainBatchResult ?? { success: true })),
    recall: mock(() =>
      Promise.resolve(options.recallResult ?? { success: true, response: { results: [] } })
    ),
    reflect: mock(() =>
      Promise.resolve(options.reflectResult ?? { success: true, response: { text: "" } })
    ),
  } as unknown as HindsightClientWrapper;
}

/** Create a mock ExtensionAPI that captures registered handlers, tools, commands, and renderers. */
export function createMockPi(): ExtensionAPI & CapturedExtension {
  return new MockPiBuilder().build();
}

/** Create a mock ExtensionContext for command/tool handler tests. */
export function createMockContext(overrides: Record<string, unknown> = {}): ExtensionContext {
  const sessionId = (overrides._sessionId as string) ?? "test-session-123";
  return {
    ui: {
      setStatus: mock(),
      notify: mock(),
      select: mock(() => Promise.resolve(undefined)),
      confirm: mock(() => Promise.resolve(false)),
      input: mock(() => Promise.resolve(undefined)),
      onTerminalInput: mock(() => () => {}),
      setWorkingMessage: mock(),
      setHiddenThinkingLabel: mock(),
      setWidget: mock(),
      setFooter: mock(),
      setHeader: mock(),
      setTitle: mock(),
      custom: mock(() => Promise.resolve(undefined)),
      pasteToEditor: mock(),
      setEditorText: mock(),
      getEditorText: mock(() => ""),
      editor: mock(() => Promise.resolve(undefined)),
      setEditorComponent: mock(),
      theme: {} as unknown,
      getAllThemes: mock(() => []),
      getTheme: mock(() => undefined),
      setTheme: mock(() => ({ success: false })),
      getToolsExpanded: mock(() => false),
      setToolsExpanded: mock(),
    },
    hasUI: true,
    cwd: "/test/project",
    sessionManager: {
      getSessionId: mock(() => sessionId),
      getEntries: mock(() => [
        { type: "custom", customType: "hindsight-meta", data: { retained: true } },
      ]),
      getHeader: mock(() => ({
        id: sessionId,
        timestamp: "2026-01-01T00:00:00Z",
        cwd: "/test/project",
        parentSession: undefined,
      })),
      getSessionName: mock(() => undefined),
      getCwd: mock(() => "/test/project"),
      getSessionDir: mock(() => "/tmp/session"),
      getSessionFile: mock(() => "/tmp/session/session.jsonl"),
      getLeafId: mock(() => sessionId),
      getLeafEntry: mock(() => null),
      getEntry: mock(() => null),
      getLabel: mock(() => undefined),
      getBranch: mock(() => null),
      getTree: mock(() => []),
    },
    modelRegistry: {} as unknown,
    model: undefined,
    signal: undefined,
    isIdle: mock(() => true),
    abort: mock(),
    hasPendingMessages: mock(() => false),
    ...overrides,
  } as unknown as ExtensionContext;
}

// ============================================
// Temp directory and session file helpers
// ============================================

/**
 * Hindsight-related environment variable keys that affect config loading.
 * Use with {@link saveEnvKeys} in beforeEach/afterEach to isolate tests from
 * the host environment.
 */
export const HINDSIGHT_ENV_KEYS = [
  "PI_HINDSIGHT_ENABLED",
  "HINDSIGHT_API_URL",
  "HINDSIGHT_API_KEY",
  "PI_HINDSIGHT_BANK_ID",
  "PI_HINDSIGHT_TOOLS_ENABLED",
  "PI_HINDSIGHT_AUTO_RECALL_ENABLED",
  "PI_HINDSIGHT_AUTO_RECALL_BUDGET",
  "PI_HINDSIGHT_AUTO_RETAIN_ENABLED",
  "PI_HINDSIGHT_CONTEXT_PREFIX",
  "PI_HINDSIGHT_CONTEXT_MAX_LENGTH",
  "PI_HINDSIGHT_MAX_RECALL_TOKENS",
  "PI_HINDSIGHT_RECALL_PROMPT_PREAMBLE",
  "PI_HINDSIGHT_RECALL_SHOW_DATETIME",
  "PI_HINDSIGHT_AUTO_RECALL_DISPLAY",
  "PI_HINDSIGHT_AUTO_RECALL_PERSIST",
  "PI_HINDSIGHT_RECALL_MAX_QUERY_CHARS",
  "PI_HINDSIGHT_RECALL_TYPES",
  "PI_HINDSIGHT_AUTO_RECALL_TAGS",
  "PI_HINDSIGHT_AUTO_RECALL_TAGS_MATCH",
  "PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS",
  "PI_HINDSIGHT_CONSTANT_TAGS",
  "PI_HINDSIGHT_FLUSH_ON_COMPACT",
  "PI_HINDSIGHT_RETAIN_CONTENT",
  "PI_HINDSIGHT_STRIP",
  "PI_HINDSIGHT_ENTITIES",
  "PI_HINDSIGHT_STATUS_HEALTHY",
  "PI_HINDSIGHT_STATUS_UNHEALTHY",
  "PI_HINDSIGHT_OBSERVATION_SCOPES",
  "PI_HINDSIGHT_RETAIN_SESSIONS_BY_DEFAULT",
  "PI_HINDSIGHT_TOOL_FILTER",
  "PI_HINDSIGHT_PROJECT_NAME",
];

/**
 * Save and clear the given env vars, returning a restore function.
 * Call the restore function in afterEach to put the original values back.
 *
 * ```ts
 * let restoreEnv: () => void;
 * beforeEach(() => { restoreEnv = saveEnvKeys(HINDSIGHT_ENV_KEYS); });
 * afterEach(() => { restoreEnv(); });
 * ```
 */
export function saveEnvKeys(keys: readonly string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  };
}

/**
 * Create a temporary directory and clean it up after the callback completes.
 * Useful for tests that need to write session files without polluting /tmp.
 */
export async function withTempDir<T>(fn: (tmpDir: string) => Promise<T>): Promise<T> {
  const tmpDir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
  try {
    return await fn(tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Write a pi session JSONL file and return its path.
 *
 * @param dir - Directory to write the file in
 * @param sessionId - Session ID (used as filename and in the header)
 * @param options.parentSession - Optional parent session path (for forked sessions)
 * @param options.messages - Messages to include. Defaults to a single user message.
 *   Pass an empty array to write a header-only file (e.g. for fork-without-messages tests).
 */
export function writeSessionFile(
  dir: string,
  sessionId: string,
  options: {
    parentSession?: string;
    messages?: Array<{ role: string; content: unknown }>;
  } = {}
): string {
  const sessionPath = join(dir, `${sessionId}.jsonl`);
  const header: Record<string, unknown> = {
    type: "session",
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: "/test",
  };
  if (options.parentSession) {
    header.parentSession = options.parentSession;
  }
  const messages = options.messages ?? [{ role: "user", content: "Hello world" }];
  const lines = [JSON.stringify(header)];
  for (const msg of messages) {
    lines.push(JSON.stringify({ type: "message", message: msg }));
  }
  writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
  return sessionPath;
}

// ============================================
// Types
// ===========================================

/** Captured state from a mock ExtensionAPI. */
export interface CapturedExtension {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  tools: Array<{ name: string; execute: (...args: unknown[]) => unknown; parameters: unknown }>;
  commands: Map<string, unknown>;
  renderers: Map<string, unknown>;
  appendedEntries: { customType: string; data?: unknown }[];
  /** Current active tool names, or null if all tools are active (default). */
  activeToolNames: string[] | null;
  /** History of all setActiveTools calls for assertions. */
  setActiveToolsCalls: string[][];
}

/** Builder for mock ExtensionAPI instances with fluent configuration. */
export class MockPiBuilder {
  private handlers = new Map<string, (...args: unknown[]) => unknown>();
  private tools: Array<{
    name: string;
    execute: (...args: unknown[]) => unknown;
    parameters: unknown;
  }> = [];
  private commands = new Map<string, unknown>();
  private renderers = new Map<string, unknown>();
  private appendedEntries: { customType: string; data?: unknown }[] = [];

  private state = {
    activeToolNames: null as string[] | null,
    setActiveToolsCalls: [] as string[][],
  };

  build(): ExtensionAPI & CapturedExtension {
    const state = this.state;
    return {
      handlers: this.handlers,
      tools: this.tools,
      commands: this.commands,
      renderers: this.renderers,
      appendedEntries: this.appendedEntries,
      get activeToolNames() {
        return state.activeToolNames;
      },
      set activeToolNames(value: string[] | null) {
        state.activeToolNames = value;
      },
      setActiveToolsCalls: state.setActiveToolsCalls,
      on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
        this.handlers.set(event, handler);
      }),
      registerTool: mock((tool: unknown) => {
        this.tools.push(
          tool as { name: string; execute: (...args: unknown[]) => unknown; parameters: unknown }
        );
      }),
      registerCommand: mock((name: string, opts: unknown) => {
        this.commands.set(name, opts);
      }),
      registerMessageRenderer: mock((type: string, renderer: unknown) => {
        this.renderers.set(type, renderer);
      }),
      appendEntry: mock((customType: string, data?: unknown) => {
        this.appendedEntries.push({ customType, data });
      }),
      getActiveTools: mock(() => {
        if (state.activeToolNames === null) {
          return this.tools.map((t) => t.name);
        }
        return this.tools.filter((t) => state.activeToolNames!.includes(t.name)).map((t) => t.name);
      }),
      setActiveTools: mock((names: string[]) => {
        state.activeToolNames = names;
        state.setActiveToolsCalls.push(names);
      }),
    } as unknown as ExtensionAPI & CapturedExtension;
  }
}
