/**
 * Unit tests for config loading and validation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type HindsightConfig,
  loadConfig,
  type ObservationScopes,
  type ToolFilterMode,
  validateConfig,
} from "../src/config";

// Config for validateConfig tests — may differ from runtime defaults since
// these tests exercise validation logic, not runtime behavior.
const validConfig: HindsightConfig = {
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
  recallPromptPreamble: "Test",
  recallShowDateTime: true,
  recallDisplay: false,
  recallPersist: false,
  recallMaxQueryChars: 800,
  recallTypes: ["observation"] as ("world" | "experience" | "observation")[] | null,
  constantTags: ["test"],
  retainContent: {
    assistant: ["text"],
    user: ["text"],
    toolResult: [],
  },
  strip: {
    topLevel: ["type"],
    message: ["api"],
  },
  toolFilter: {},
  flushOnCompact: false,
  entities: [],
  observationScopes: null,
  statusHealthy: "🧠",
  retainSessionsByDefault: true,
  statusUnhealthy: "🤯",
};

// Temp directory for file loading tests
const TEST_DIR = "/tmp/pi-hindsight-config-test";

// Store original env values to restore after tests
const envKeys = [
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
  "PI_HINDSIGHT_RECALL_DISPLAY",
  "PI_HINDSIGHT_RECALL_PERSIST",
  "PI_HINDSIGHT_RECALL_MAX_QUERY_CHARS",
  "PI_HINDSIGHT_RECALL_TYPES",
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
];
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Save and clear env vars
  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }

  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  // Restore env vars
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }

  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("validateConfig", () => {
  it("returns valid for correct config", () => {
    const result = validateConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("errors when apiUrl is missing", () => {
    const config = { ...validConfig, apiUrl: "" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "apiUrl is required (set in config.json or HINDSIGHT_API_URL env var)"
    );
  });

  it("errors when apiKey is missing", () => {
    const config = { ...validConfig, apiKey: "" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "apiKey is required (set in config.json or HINDSIGHT_API_KEY env var)"
    );
  });

  it("errors when retainContent.user is empty", () => {
    const config = {
      ...validConfig,
      retainContent: { ...validConfig.retainContent, user: [] },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "retainContent.user cannot be empty (at least one content type required)"
    );
  });

  it("errors when retainContent.assistant is empty", () => {
    const config = {
      ...validConfig,
      retainContent: { ...validConfig.retainContent, assistant: [] },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "retainContent.assistant cannot be empty (at least one content type required)"
    );
  });

  it("allows empty retainContent.toolResult", () => {
    const config = {
      ...validConfig,
      retainContent: { ...validConfig.retainContent, toolResult: [] },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("warns when recallDisplay is true but recallPersist is false", () => {
    const config = { ...validConfig, recallDisplay: true, recallPersist: false };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain(
      "recallDisplay: true has no effect when recallPersist: false (context event never shows in TUI)"
    );
  });

  it("does not warn when recallDisplay is true and recallPersist is true", () => {
    const config = { ...validConfig, recallDisplay: true, recallPersist: true };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("errors when hindsightContextMaxLength is negative", () => {
    const config = { ...validConfig, hindsightContextMaxLength: -1 };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("hindsightContextMaxLength must be >= 0");
  });

  it("errors when retainContent has duplicates", () => {
    const config = {
      ...validConfig,
      retainContent: {
        assistant: ["text", "text"] as ("text" | "thinking" | "toolCall")[],
        user: ["text"] as ("text" | "image")[],
        toolResult: [],
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("retainContent.assistant contains duplicate values");
  });

  it("errors when strip has duplicates", () => {
    const config = {
      ...validConfig,
      strip: {
        topLevel: ["type", "type"],
        message: ["api"],
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("strip.topLevel contains duplicate values");
    expect(result.warnings).toHaveLength(0);
  });

  it("errors when recallTypes has duplicates", () => {
    const config = {
      ...validConfig,
      recallTypes: ["observation", "observation"] as
        | ("world" | "experience" | "observation")[]
        | null,
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("recallTypes contains duplicate values");
  });

  it("allows null recallTypes (means all types)", () => {
    const config = {
      ...validConfig,
      recallTypes: null,
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });
});

describe("loadConfig", () => {
  it("loads from .json file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://from-json.test",
        apiKey: "json-key",
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.apiUrl).toBe("https://from-json.test");
    expect(config.apiKey).toBe("json-key");
  });

  it("loads from .jsonc file with comments and trailing commas", () => {
    const jsoncContent = `{
			// API configuration
			"apiUrl": "https://from-jsonc.test",
			"apiKey": "jsonc-key", /* inline comment */
			"bankId": "test-bank",
		}`;
    writeFileSync(join(TEST_DIR, "config.jsonc"), jsoncContent);

    const { config } = loadConfig(TEST_DIR);
    expect(config.apiUrl).toBe("https://from-jsonc.test");
    expect(config.apiKey).toBe("jsonc-key");
    expect(config.bankId).toBe("test-bank");
  });

  it("prefers .jsonc over .json", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://from-json.test",
        apiKey: "json-key",
      })
    );

    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://from-jsonc.test",
        apiKey: "jsonc-key",
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.apiUrl).toBe("https://from-jsonc.test");
    expect(config.apiKey).toBe("jsonc-key");
  });

  it("returns warning for malformed JSONC", () => {
    writeFileSync(join(TEST_DIR, "config.jsonc"), "{ invalid json }");

    const { warning } = loadConfig(TEST_DIR);
    expect(warning).toBeDefined();
    expect(warning).toContain("Failed to parse config file");
  });

  it("returns warning for unknown config keys", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        unknownKey: "value",
      })
    );

    const { warning } = loadConfig(TEST_DIR);
    expect(warning).toContain("Unknown config key in file: unknownKey");
  });

  it("uses defaults when no config file exists", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.apiUrl).toBe("");
    expect(config.apiKey).toBe("");
    expect(config.bankId).toBe("pi-default");
    expect(config.enabled).toBe(true);
  });

  it("recallDisplay defaults to false", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.recallDisplay).toBe(false);
  });

  it("recallDisplay can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallDisplay: true,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallDisplay).toBe(true);
  });

  it("recallDisplay can be set via PI_HINDSIGHT_RECALL_DISPLAY env var", () => {
    process.env.PI_HINDSIGHT_RECALL_DISPLAY = "true";

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallDisplay).toBe(true);
  });

  it("recallPersist defaults to false", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.recallPersist).toBe(false);
  });

  it("recallPersist can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallPersist: true,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallPersist).toBe(true);
  });

  it("recallPersist can be set via PI_HINDSIGHT_RECALL_PERSIST env var", () => {
    process.env.PI_HINDSIGHT_RECALL_PERSIST = "true";

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallPersist).toBe(true);
  });

  it('recallTypes defaults to ["observation"]', () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toEqual(["observation"]);
  });

  it("recallTypes can be set to null via config file (means all types)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallTypes: null,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toBeNull();
  });

  it("recallTypes empty array via config file (means all types)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallTypes: [],
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toBeNull();
  });

  it("warns on invalid recallTypes in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallTypes: ["invalid", "observation"],
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toContain("recallTypes contains invalid values");
  });

  it("recallTypes can be set to null via env var (means all types)", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = "null";

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toBeNull();
  });

  it("recallTypes empty array means all types (via env var)", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = "[]";

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toBeNull();
  });

  it("recallTypes can be set to an array via env var", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = '["world","experience"]';

    const { config } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toEqual(["world", "experience"]);
  });

  it("warns on invalid recallTypes values", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = '["invalid", "observation"]';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("recallTypes contains invalid values");
  });

  // Boolean fallback warning tests
  it("warns on invalid boolean value via env var", () => {
    process.env.PI_HINDSIGHT_ENABLED = "yes";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.enabled).toBe(true); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("Invalid boolean value");
    expect(warning).toContain('expected "true" or "false"');
  });

  it("warns on invalid boolean value in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        enabled: "yes",
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.enabled).toBe(true); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("Invalid boolean value");
  });

  it("does not warn on valid boolean false", () => {
    process.env.PI_HINDSIGHT_ENABLED = "false";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.enabled).toBe(false);
    expect(warning).toBeUndefined();
  });

  it("does not warn on valid boolean true", () => {
    process.env.PI_HINDSIGHT_ENABLED = "true";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.enabled).toBe(true);
    expect(warning).toBeUndefined();
  });

  // Budget fallback warning tests
  it("warns on invalid budget value via env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_BUDGET = "extreme";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallBudget).toBe("mid"); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("Invalid budget");
    expect(warning).toContain('expected "low", "mid", or "high"');
  });

  it("warns on invalid budget value in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallBudget: "extreme",
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallBudget).toBe("mid"); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("Invalid budget");
  });

  it("does not warn on valid budget values", () => {
    for (const budget of ["low", "mid", "high"] as const) {
      process.env.PI_HINDSIGHT_AUTO_RECALL_BUDGET = budget;

      const { config, warning } = loadConfig(TEST_DIR);
      expect(config.autoRecallBudget).toBe(budget);
      expect(warning).toBeUndefined();

      delete process.env.PI_HINDSIGHT_AUTO_RECALL_BUDGET;
    }
  });

  // Number fallback warning tests
  it("warns on invalid number value via env var", () => {
    process.env.PI_HINDSIGHT_CONTEXT_MAX_LENGTH = "abc";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.hindsightContextMaxLength).toBe(100); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("Invalid number for hindsightContextMaxLength");
  });

  it("warns on invalid number value in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        hindsightContextMaxLength: "not-a-number",
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.hindsightContextMaxLength).toBe(100); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("Invalid number for hindsightContextMaxLength");
  });

  it("warns on invalid maxRecallTokens value", () => {
    process.env.PI_HINDSIGHT_MAX_RECALL_TOKENS = "invalid";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.maxRecallTokens).toBeNull(); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("Invalid number for maxRecallTokens");
  });

  it("does not warn on valid number", () => {
    process.env.PI_HINDSIGHT_CONTEXT_MAX_LENGTH = "200";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.hindsightContextMaxLength).toBe(200);
    expect(warning).toBeUndefined();
  });

  // JsonArray fallback warning tests
  it("warns on invalid JSON in constantTags via env var", () => {
    process.env.PI_HINDSIGHT_CONSTANT_TAGS = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.constantTags).toEqual(["harness:pi"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("constantTags contains invalid JSON");
  });

  it("warns on non-array JSON in constantTags via env var", () => {
    process.env.PI_HINDSIGHT_CONSTANT_TAGS = '"not-an-array"';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.constantTags).toEqual(["harness:pi"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("constantTags must be a JSON array");
  });

  it("warns on invalid JSON in constantTags in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        constantTags: "not-json",
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.constantTags).toEqual(["harness:pi"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("constantTags contains invalid JSON");
  });

  it("does not warn on valid JSON array for constantTags", () => {
    process.env.PI_HINDSIGHT_CONSTANT_TAGS = '["tag1", "tag2"]';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.constantTags).toEqual(["tag1", "tag2"]);
    expect(warning).toBeUndefined();
  });

  // recallTypes JSON parsing warning tests
  it("warns on invalid JSON in recallTypes via env var", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("recallTypes contains invalid JSON");
  });

  it("warns on non-array JSON in recallTypes via env var", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = '"not-an-array"';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.recallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("recallTypes must be a JSON array");
  });

  // entities env var warning tests
  it("warns on invalid JSON in entities via env var", () => {
    process.env.PI_HINDSIGHT_ENTITIES = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.entities).toEqual([]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("entities contains invalid JSON");
  });

  it("warns on non-array JSON in entities via env var", () => {
    process.env.PI_HINDSIGHT_ENTITIES = '"not-an-array"';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.entities).toEqual([]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("entities must be a JSON array");
  });

  it("does not warn on valid JSON array for entities", () => {
    process.env.PI_HINDSIGHT_ENTITIES = '[{"text": "John", "type": "PERSON"}]';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.entities).toEqual([{ text: "John", type: "PERSON" }]);
    expect(warning).toBeUndefined();
  });

  // retainContent warning tests
  it("warns on non-object retainContent in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        retainContent: "invalid",
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.retainContent).toEqual({
      assistant: ["text", "thinking", "toolCall"],
      user: ["text"],
      toolResult: ["text"],
    }); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("retainContent contains invalid JSON");
  });

  it("does not warn on null retainContent (might be intentional)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        retainContent: null,
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    // null is ignored, keeps default
    expect(config.retainContent).toEqual({
      assistant: ["text", "thinking", "toolCall"],
      user: ["text"],
      toolResult: ["text"],
    });
    expect(warning).toBeUndefined();
  });

  it("does not warn on valid retainContent object", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        retainContent: {
          assistant: ["text"],
          user: ["text", "image"],
          toolResult: [],
        },
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.retainContent).toEqual({
      assistant: ["text"],
      user: ["text", "image"],
      toolResult: [],
    });
    expect(warning).toBeUndefined();
  });

  // strip warning tests
  it("warns on non-object strip in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        strip: ["invalid"],
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.strip).toEqual({
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
    }); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("strip must be an object, got array");
  });

  it("does not warn on null strip (might be intentional)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        strip: null,
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    // null is ignored, keeps default
    expect(config.strip).toEqual({
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
    });
    expect(warning).toBeUndefined();
  });

  it("does not warn on valid strip object", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        strip: {
          topLevel: ["type"],
          message: ["api"],
        },
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.strip).toEqual({
      topLevel: ["type"],
      message: ["api"],
    });
    expect(warning).toBeUndefined();
  });

  // retainContent env var tests
  it("retainContent can be set via PI_HINDSIGHT_RETAIN_CONTENT env var as JSON string", () => {
    process.env.PI_HINDSIGHT_RETAIN_CONTENT =
      '{"assistant":["text"],"user":["text","image"],"toolResult":[]}';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.retainContent).toEqual({
      assistant: ["text"],
      user: ["text", "image"],
      toolResult: [],
    });
    expect(warning).toBeUndefined();
  });

  it("warns on invalid JSON in PI_HINDSIGHT_RETAIN_CONTENT env var", () => {
    process.env.PI_HINDSIGHT_RETAIN_CONTENT = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.retainContent).toEqual({
      assistant: ["text", "thinking", "toolCall"],
      user: ["text"],
      toolResult: ["text"],
    }); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("retainContent contains invalid JSON");
  });

  it("warns on non-object JSON in PI_HINDSIGHT_RETAIN_CONTENT env var", () => {
    process.env.PI_HINDSIGHT_RETAIN_CONTENT = '["not-an-object"]';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.retainContent).toEqual({
      assistant: ["text", "thinking", "toolCall"],
      user: ["text"],
      toolResult: ["text"],
    }); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("retainContent must be a JSON object");
  });

  it("warns on null JSON in PI_HINDSIGHT_RETAIN_CONTENT env var", () => {
    process.env.PI_HINDSIGHT_RETAIN_CONTENT = "null";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.retainContent).toEqual({
      assistant: ["text", "thinking", "toolCall"],
      user: ["text"],
      toolResult: ["text"],
    }); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("retainContent must be a JSON object, got null");
  });

  it("env var overrides config file for retainContent", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        retainContent: {
          assistant: ["text"],
          user: ["text"],
          toolResult: [],
        },
      })
    );
    process.env.PI_HINDSIGHT_RETAIN_CONTENT =
      '{"assistant":["text","thinking"],"user":["text"],"toolResult":["text"]}';

    const { config } = loadConfig(TEST_DIR);
    expect(config.retainContent).toEqual({
      assistant: ["text", "thinking"],
      user: ["text"],
      toolResult: ["text"],
    });
  });

  // strip env var tests
  it("strip can be set via PI_HINDSIGHT_STRIP env var as JSON string", () => {
    process.env.PI_HINDSIGHT_STRIP = '{"topLevel":[],"message":["toolCallId"]}';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.strip).toEqual({
      topLevel: [],
      message: ["toolCallId"],
    });
    expect(warning).toBeUndefined();
  });

  it("warns on invalid JSON in PI_HINDSIGHT_STRIP env var", () => {
    process.env.PI_HINDSIGHT_STRIP = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.strip).toEqual({
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
    }); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("strip contains invalid JSON");
  });

  it("warns on non-object JSON in PI_HINDSIGHT_STRIP env var", () => {
    process.env.PI_HINDSIGHT_STRIP = "42";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.strip).toEqual({
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
    }); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("strip must be a JSON object");
  });

  it("env var overrides config file for strip", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        strip: {
          topLevel: ["type"],
          message: ["api"],
        },
      })
    );
    process.env.PI_HINDSIGHT_STRIP = '{"topLevel":[],"message":[]}';

    const { config } = loadConfig(TEST_DIR);
    expect(config.strip).toEqual({
      topLevel: [],
      message: [],
    });
  });

  // Return shape tests: configPath and envVars
  it("returns configPath when config file exists", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
      })
    );

    const { configPath } = loadConfig(TEST_DIR);
    expect(configPath).toBe(join(TEST_DIR, "config.json"));
  });

  it("returns configPath: undefined when no config file exists", () => {
    const { configPath } = loadConfig(TEST_DIR);
    expect(configPath).toBeUndefined();
  });

  it("returns envVars listing env vars that are set", () => {
    process.env.HINDSIGHT_API_URL = "https://env.test";
    process.env.HINDSIGHT_API_KEY = "env-key";

    const { envVars } = loadConfig(TEST_DIR);
    expect(envVars).toContain("HINDSIGHT_API_URL");
    expect(envVars).toContain("HINDSIGHT_API_KEY");
  });

  it("returns envVars: [] when no env vars are set", () => {
    const { envVars } = loadConfig(TEST_DIR);
    expect(envVars).toEqual([]);
  });

  it("returns configPath and envVars together correctly", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
      })
    );
    process.env.HINDSIGHT_API_URL = "https://override.test";

    const { configPath, envVars, config } = loadConfig(TEST_DIR);
    expect(configPath).toBe(join(TEST_DIR, "config.json"));
    expect(envVars).toContain("HINDSIGHT_API_URL");
    expect(config.apiUrl).toBe("https://override.test"); // env overrides file
  });

  // statusHealthy / statusUnhealthy config tests
  it("statusHealthy defaults to 🧠", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.statusHealthy).toBe("🧠");
  });

  it("statusUnhealthy defaults to 🤯", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.statusUnhealthy).toBe("🤯");
  });

  it("statusHealthy can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        statusHealthy: "✅",
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.statusHealthy).toBe("✅");
  });

  it("statusUnhealthy can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        retainSessionsByDefault: true,
        statusUnhealthy: "❌",
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.statusUnhealthy).toBe("❌");
  });

  it("statusHealthy can be set via PI_HINDSIGHT_STATUS_HEALTHY env var", () => {
    process.env.PI_HINDSIGHT_STATUS_HEALTHY = "✅";

    const { config } = loadConfig(TEST_DIR);
    expect(config.statusHealthy).toBe("✅");
  });

  it("statusUnhealthy can be set via PI_HINDSIGHT_STATUS_UNHEALTHY env var", () => {
    process.env.PI_HINDSIGHT_STATUS_UNHEALTHY = "❌";

    const { config } = loadConfig(TEST_DIR);
    expect(config.statusUnhealthy).toBe("❌");
  });

  // retainSessionsByDefault tests
  it("retainSessionsByDefault defaults to true", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.retainSessionsByDefault).toBe(true);
  });

  it("retainSessionsByDefault can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        retainSessionsByDefault: false,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.retainSessionsByDefault).toBe(false);
  });

  it("retainSessionsByDefault can be set via PI_HINDSIGHT_RETAIN_SESSIONS_BY_DEFAULT env var", () => {
    process.env.PI_HINDSIGHT_RETAIN_SESSIONS_BY_DEFAULT = "false";

    const { config } = loadConfig(TEST_DIR);
    expect(config.retainSessionsByDefault).toBe(false);
  });

  it("warns on invalid boolean value for retainSessionsByDefault via env var", () => {
    process.env.PI_HINDSIGHT_RETAIN_SESSIONS_BY_DEFAULT = "yes";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.retainSessionsByDefault).toBe(true); // Falls back to default
    expect(warning).toContain("Invalid boolean value");
  });

  // toolFilter tests
  it("toolFilter defaults to conservative exclude lists", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.toolFilter).toBeDefined();
    expect(config.toolFilter.toolCall).toEqual({
      exclude: ["grep", "find", "ls", "read", "hindsight_retain"],
    });
    expect(config.toolFilter.toolResult).toEqual({
      exclude: [
        "grep",
        "find",
        "ls",
        "write",
        "edit",
        "hindsight_retain",
        "hindsight_recall",
        "hindsight_reflect",
      ],
    });
  });

  it("toolFilter can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        toolFilter: {
          toolCall: { include: ["hindsight_retain"] },
          toolResult: { exclude: ["bash"] },
        },
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.toolFilter.toolCall).toEqual({ include: ["hindsight_retain"] });
    expect(config.toolFilter.toolResult).toEqual({ exclude: ["bash"] });
  });

  it("toolFilter can be set via PI_HINDSIGHT_TOOL_FILTER env var", () => {
    process.env.PI_HINDSIGHT_TOOL_FILTER = JSON.stringify({
      toolCall: { exclude: ["bash"] },
    });

    const { config } = loadConfig(TEST_DIR);
    expect(config.toolFilter.toolCall).toEqual({ exclude: ["bash"] });
  });

  it("warns on invalid JSON for toolFilter env var", () => {
    process.env.PI_HINDSIGHT_TOOL_FILTER = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(warning).toContain("toolFilter contains invalid JSON");
    // Falls back to default (not empty {}) on parse errors
    expect((config.toolFilter.toolCall as { exclude: string[] }).exclude).toContain("grep");
    expect((config.toolFilter.toolResult as { exclude: string[] }).exclude).toContain("grep");
  });

  it("toolFilter with both include and exclude is a validation error", () => {
    const config: HindsightConfig = {
      ...validConfig,
      toolFilter: {
        toolCall: { include: ["bash"], exclude: ["read"] } as unknown as ToolFilterMode,
      },
    };

    const { errors } = validateConfig(config);
    expect(errors).toContain("toolFilter.toolCall cannot have both 'include' and 'exclude'");
  });

  it("toolFilter with empty include list is a validation error", () => {
    const config: HindsightConfig = {
      ...validConfig,
      toolFilter: {
        toolCall: { include: [] },
      },
    };

    const { errors } = validateConfig(config);
    expect(errors).toContain(
      "toolFilter.toolCall.include cannot be empty (use exclude instead, or remove the filter)"
    );
  });

  it("toolFilter with empty exclude list is a validation error", () => {
    const config: HindsightConfig = {
      ...validConfig,
      toolFilter: {
        toolResult: { exclude: [] },
      },
    };

    const { errors } = validateConfig(config);
    expect(errors).toContain(
      "toolFilter.toolResult.exclude cannot be empty (use include instead, or remove the filter)"
    );
  });

  it("toolFilter with unknown keys is a validation error", () => {
    const config: HindsightConfig = {
      ...validConfig,
      toolFilter: {
        toolCall: { blocklist: ["bash"] } as unknown as ToolFilterMode,
      },
    };

    const { errors } = validateConfig(config);
    expect(errors).toContain(
      "toolFilter.toolCall has unknown key 'blocklist' (only 'include' and 'exclude' are allowed)"
    );
  });

  it("toolFilter sub-object without include or exclude is a validation error", () => {
    const config: HindsightConfig = {
      ...validConfig,
      toolFilter: {
        toolCall: {} as unknown as ToolFilterMode,
      },
    };

    const { errors } = validateConfig(config);
    expect(errors).toContain("toolFilter.toolCall must have either 'include' or 'exclude'");
  });

  it("empty toolFilter means no filtering", () => {
    loadConfig(TEST_DIR);
    // Default has values; test empty override
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        toolFilter: {},
      })
    );

    const configResult = loadConfig(TEST_DIR);
    expect(configResult.config.toolFilter).toEqual({});
    const { valid } = validateConfig(configResult.config);
    expect(valid).toBe(true);
  });
});

describe("observationScopes", () => {
  it("defaults to null", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
  });

  it("accepts preset string from config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: "per_tag",
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe("per_tag");
  });

  it("accepts array of tag arrays from config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: [["session:abc", "user:alice"], ["project:foo"]],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toEqual([["session:abc", "user:alice"], ["project:foo"]]);
  });

  it("accepts null from config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: null,
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
  });

  it("accepts preset string from env var", () => {
    process.env.PI_HINDSIGHT_OBSERVATION_SCOPES = "combined";
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe("combined");
  });

  it("accepts JSON array from env var", () => {
    process.env.PI_HINDSIGHT_OBSERVATION_SCOPES = JSON.stringify([["session:abc"]]);
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toEqual([["session:abc"]]);
  });

  it("accepts null JSON from env var", () => {
    process.env.PI_HINDSIGHT_OBSERVATION_SCOPES = "null";
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
  });

  it("falls back to default for invalid env var", () => {
    process.env.PI_HINDSIGHT_OBSERVATION_SCOPES = "invalid_value";
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
    expect(warning).toContain("observationScopes");
  });

  it("supports placeholder syntax in arrays", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: [["{session}", "{parent}"], ["user:alice"]],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    // Placeholders are stored as-is in config, expanded at retain time
    expect(config.observationScopes).toEqual([["{session}", "{parent}"], ["user:alice"]]);
  });

  it("env var overrides config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: "per_tag",
      })
    );
    process.env.PI_HINDSIGHT_OBSERVATION_SCOPES = "combined";
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe("combined");
  });

  it("rejects empty top-level array", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: [],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
    expect(warning).toContain("observationScopes");
  });

  it("rejects empty inner array", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: [["session:abc"], []],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
    expect(warning).toContain("observationScopes");
  });

  it("rejects non-array inner values", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: ["not-an-array"],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
    expect(warning).toContain("observationScopes");
  });

  it("warns on non-exact placeholder in tag string", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: [["{session}:extra", "user:alice"]],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    // Config value is accepted without warning from loadConfig
    expect(config.observationScopes).toEqual([["{session}:extra", "user:alice"]]);
    // Warning comes from validateConfig
    const { warnings } = validateConfig(config);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("{session}");
    expect(warnings[0]).toContain("standalone");
  });
});

describe("validateConfig for observationScopes", () => {
  it("accepts null observationScopes", () => {
    const result = validateConfig({ ...validConfig, observationScopes: null });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts preset string observationScopes", () => {
    for (const preset of ["per_tag", "combined", "all_combinations"]) {
      const result = validateConfig({
        ...validConfig,
        observationScopes: preset as ObservationScopes,
      });
      expect(result.valid).toBe(true);
    }
  });

  it("accepts valid array observationScopes", () => {
    const result = validateConfig({
      ...validConfig,
      observationScopes: [["session:abc", "user:alice"], ["project:foo"]],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty top-level array", () => {
    const result = validateConfig({
      ...validConfig,
      observationScopes: [] as HindsightConfig["observationScopes"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("observationScopes: array must not be empty");
  });

  it("rejects empty inner array", () => {
    const result = validateConfig({
      ...validConfig,
      observationScopes: [["session:abc"], []] as HindsightConfig["observationScopes"],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid preset string", () => {
    const result = validateConfig({
      ...validConfig,
      observationScopes: "invalid" as unknown as HindsightConfig["observationScopes"],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects non-null/string/array value", () => {
    const result = validateConfig({
      ...validConfig,
      observationScopes: 42 as unknown as HindsightConfig["observationScopes"],
    });
    expect(result.valid).toBe(false);
  });

  it("warns on non-exact placeholder in tag string", () => {
    const result = validateConfig({
      ...validConfig,
      observationScopes: [["{session}:extra", "user:alice"]],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("{session}");
    expect(result.warnings[0]).toContain("standalone");
  });
});

describe("expandScopePlaceholders", () => {
  it("returns null unchanged", () => {
    const { expandScopePlaceholders } = require("../src/config");
    expect(expandScopePlaceholders(null, { sessionId: "abc-123" })).toBe(null);
  });

  it("returns preset strings unchanged", () => {
    const { expandScopePlaceholders } = require("../src/config");
    expect(expandScopePlaceholders("per_tag", { sessionId: "abc-123" })).toBe("per_tag");
    expect(expandScopePlaceholders("combined", { sessionId: "abc-123" })).toBe("combined");
    expect(expandScopePlaceholders("all_combinations", { sessionId: "abc-123" })).toBe(
      "all_combinations"
    );
  });

  it("expands {session} placeholder", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{session}"]], { sessionId: "abc-123" });
    expect(result).toEqual([["session:abc-123"]]);
  });

  it("expands {parent} placeholder", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{parent}"]], {
      sessionId: "abc-123",
      parentSessionId: "parent-456",
    });
    expect(result).toEqual([["parent:parent-456"]]);
  });

  it("falls back to session ID when parent is not available", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{parent}"]], { sessionId: "abc-123" });
    expect(result).toEqual([["parent:abc-123"]]);
  });

  it("expands both {session} and {parent} in the same group", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{session}", "{parent}"]], {
      sessionId: "abc-123",
      parentSessionId: "parent-456",
    });
    expect(result).toEqual([["session:abc-123", "parent:parent-456"]]);
  });

  it("expands placeholders across multiple groups", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{session}"], ["{parent}", "user:alice"]], {
      sessionId: "abc-123",
      parentSessionId: "parent-456",
    });
    expect(result).toEqual([["session:abc-123"], ["parent:parent-456", "user:alice"]]);
  });

  it("preserves non-placeholder tags unchanged", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["user:alice", "project:foo"]], {
      sessionId: "abc-123",
    });
    expect(result).toEqual([["user:alice", "project:foo"]]);
  });

  it("handles mixed placeholder and non-placeholder tags", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{session}", "topic:billing"]], {
      sessionId: "abc-123",
    });
    expect(result).toEqual([["session:abc-123", "topic:billing"]]);
  });

  it("does not expand partial placeholder in a tag string", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{session}:extra"]], { sessionId: "abc-123" });
    expect(result).toEqual([["{session}:extra"]]);
  });

  it("does not expand non-exact placeholder like {session}:{parent}", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{session}:{parent}"]], {
      sessionId: "abc-123",
      parentSessionId: "parent-456",
    });
    expect(result).toEqual([["{session}:{parent}"]]);
  });
});
