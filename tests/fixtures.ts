/**
 * Shared test fixtures and helpers for pi-hindsight tests.
 *
 * Centralizes config objects, mock factories, and common types
 * to avoid duplication across test files.
 */

import { mock } from "bun:test";
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
  recallDisplay: false,
  recallPersist: false,
  recallMaxQueryChars: 800,
  recallTypes: ["observation"],
  constantTags: ["test"],
  retainContent: { assistant: ["text"], user: ["text"], toolResult: [] },
  strip: { topLevel: ["type"], message: ["api"] },
  toolFilter: {},
  flushOnCompact: false,
  entities: [],
  observationScopes: null,
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
// Types
// ============================================

/** Captured state from a mock ExtensionAPI. */
export interface CapturedExtension {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  tools: Array<{ name: string; execute: (...args: unknown[]) => unknown; parameters: unknown }>;
  commands: Map<string, unknown>;
  renderers: Map<string, unknown>;
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

  build(): ExtensionAPI & CapturedExtension {
    return {
      handlers: this.handlers,
      tools: this.tools,
      commands: this.commands,
      renderers: this.renderers,
      appendedEntries: this.appendedEntries,
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
    } as unknown as ExtensionAPI & CapturedExtension;
  }
}
