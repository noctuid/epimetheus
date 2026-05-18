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
  type ToolName,
  validateConfig,
} from "../src/config";
import { HINDSIGHT_ENV_KEYS, saveEnvKeys } from "./fixtures";

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
  autoRecallShowDateTime: true,
  autoRecallDisplay: false,
  autoRecallPersist: false,
  recallMaxQueryChars: 800,
  autoRecallTypes: ["observation"] as ("world" | "experience" | "observation")[] | null,
  autoRecallTags: null,
  autoRecallTagsMatch: "any",
  autoRecallTagGroups: null,
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
  observationScopes: [["{session}"]] as string[][],
  statusHealthy: "🧠",
  retainSessionsByDefault: true,
  statusUnhealthy: "🤯",
};

// Temp directory for file loading tests
const TEST_DIR = "/tmp/pi-hindsight-config-test";

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = saveEnvKeys(HINDSIGHT_ENV_KEYS);

  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  restoreEnv();

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

  it("errors when bankId is missing", () => {
    const config = { ...validConfig, bankId: "" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "bankId is required (set in config.json or PI_HINDSIGHT_BANK_ID env var)"
    );
  });

  it("warns when toolsEnabled array contains invalid tool names", () => {
    const config = {
      ...validConfig,
      toolsEnabled: ["retain", "invalid"] as ToolName[],
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("invalid values"))).toBe(true);
  });

  it("accepts toolsEnabled as empty array (no tools, equivalent to false)", () => {
    const config = { ...validConfig, toolsEnabled: [] as ToolName[] };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("warns when toolsEnabled array has duplicates", () => {
    const config = {
      ...validConfig,
      toolsEnabled: ["retain", "retain"] as ToolName[],
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("duplicate values"))).toBe(true);
  });

  it("accepts toolsEnabled as boolean true", () => {
    const config = { ...validConfig, toolsEnabled: true };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("accepts toolsEnabled as valid array", () => {
    const config = { ...validConfig, toolsEnabled: ["retain", "reflect"] as ["retain", "reflect"] };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
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

  it("warns when autoRecallDisplay is true but autoRecallPersist is false", () => {
    const config = { ...validConfig, autoRecallDisplay: true, autoRecallPersist: false };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain(
      "autoRecallDisplay: true will not show new recall messages when autoRecallPersist: false (new recalls are ephemeral and not added to chat; only the most recent is available via /hindsight popup). However, autoRecallDisplay still affects rendering of previously persisted recall messages in session files (e.g. when enabled: false)."
    );
  });

  it("does not warn when autoRecallDisplay is true and autoRecallPersist is true", () => {
    const config = { ...validConfig, autoRecallDisplay: true, autoRecallPersist: true };
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

  it("allows empty string for hindsightContextPrefix", () => {
    const config = { ...validConfig, hindsightContextPrefix: "" };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("allows hindsightContextMaxLength of 0", () => {
    const config = { ...validConfig, hindsightContextMaxLength: 0 };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
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

  it("errors when autoRecallTypes has duplicates", () => {
    const config = {
      ...validConfig,
      autoRecallTypes: ["observation", "observation"] as
        | ("world" | "experience" | "observation")[]
        | null,
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("autoRecallTypes contains duplicate values");
  });

  it("allows null autoRecallTypes (means all types)", () => {
    const config = {
      ...validConfig,
      autoRecallTypes: null,
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

  it("rejects projectName in config file (PI_HINDSIGHT_PROJECT_NAME is env-only)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        projectName: "my-project",
      })
    );

    const { warning } = loadConfig(TEST_DIR);
    expect(warning).toContain("Unknown config key in file: projectName");
  });

  it("uses defaults when no config file exists", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.apiUrl).toBe("");
    expect(config.apiKey).toBe("");
    expect(config.bankId).toBe("");
    expect(config.enabled).toBe(true);
  });

  it("autoRecallDisplay defaults to false", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallDisplay).toBe(false);
  });

  it("autoRecallDisplay can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallDisplay: true,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallDisplay).toBe(true);
  });

  it("autoRecallDisplay can be set via PI_HINDSIGHT_AUTO_RECALL_DISPLAY env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_DISPLAY = "true";

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallDisplay).toBe(true);
  });

  it("autoRecallPersist defaults to false", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallPersist).toBe(false);
  });

  it("autoRecallPersist can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallPersist: true,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallPersist).toBe(true);
  });

  it("autoRecallPersist can be set via PI_HINDSIGHT_AUTO_RECALL_PERSIST env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_PERSIST = "true";

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallPersist).toBe(true);
  });

  // ============================================
  // toolsEnabled tests
  // ============================================

  it("toolsEnabled defaults to true", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.toolsEnabled).toBe(true);
  });

  it("toolsEnabled can be set to false via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        toolsEnabled: false,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.toolsEnabled).toBe(false);
  });

  it("toolsEnabled can be set to array of tool names via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        toolsEnabled: ["retain", "recall"],
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.toolsEnabled).toEqual(["retain", "recall"]);
  });

  it("toolsEnabled can be set to array via PI_HINDSIGHT_TOOLS_ENABLED env var", () => {
    process.env.PI_HINDSIGHT_TOOLS_ENABLED = '["retain"]';

    const { config } = loadConfig(TEST_DIR);
    expect(config.toolsEnabled).toEqual(["retain"]);
  });

  it("toolsEnabled env var supports boolean string", () => {
    process.env.PI_HINDSIGHT_TOOLS_ENABLED = "false";

    const { config } = loadConfig(TEST_DIR);
    expect(config.toolsEnabled).toBe(false);
  });

  it("warns on invalid tool names in toolsEnabled array via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        toolsEnabled: ["retain", "invalid"],
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(warning).toContain("invalid tool names");
    expect(config.toolsEnabled).toBe(true); // falls back to default
  });

  it("warns on invalid toolsEnabled env var JSON", () => {
    process.env.PI_HINDSIGHT_TOOLS_ENABLED = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(warning).toContain("invalid JSON");
    expect(config.toolsEnabled).toBe(true); // falls back to default
  });

  it("warns on empty string toolsEnabled env var", () => {
    process.env.PI_HINDSIGHT_TOOLS_ENABLED = "";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(warning).toBeDefined();
    expect(config.toolsEnabled).toBe(true); // falls back to default
  });

  it("toolsEnabled env var empty array is equivalent to false", () => {
    process.env.PI_HINDSIGHT_TOOLS_ENABLED = "[]";

    const { config } = loadConfig(TEST_DIR);
    expect(config.toolsEnabled).toEqual([]);
  });

  it("toolsEnabled config file null falls back to default with warning", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        toolsEnabled: null,
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(warning).toBeDefined();
    expect(config.toolsEnabled).toBe(true); // falls back to default
  });

  it('autoRecallTypes defaults to ["observation"]', () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["observation"]);
  });

  it("autoRecallTypes can be set to null via config file (means all types)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTypes: null,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toBeNull();
  });

  it("autoRecallTypes empty array via config file (means all types)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTypes: [],
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toBeNull();
  });

  it("warns on invalid autoRecallTypes in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTypes: ["invalid", "observation"],
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toContain("autoRecallTypes contains invalid values");
  });

  it("autoRecallTypes can be set to null via env var (means all types)", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TYPES = "null";

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toBeNull();
  });

  it("autoRecallTypes empty array means all types (via env var)", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TYPES = "[]";

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toBeNull();
  });

  it("autoRecallTypes can be set to an array via env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TYPES = '["world","experience"]';

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["world", "experience"]);
  });

  it("warns on invalid autoRecallTypes values", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TYPES = '["invalid", "observation"]';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("autoRecallTypes contains invalid values");
  });

  // Backward compatibility: old config file key names should still work
  it("falls back to old config file key recallTypes", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallTypes: ["world"],
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["world"]);
    expect(warning).toBeUndefined();
  });

  it("falls back to old config file key recallShowDateTime", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallShowDateTime: false,
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallShowDateTime).toBe(false);
    expect(warning).toBeUndefined();
  });

  it("prioritizes new config key over old config key when both are present", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallTypes: ["world"],
        autoRecallTypes: ["experience"],
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["experience"]);
  });

  // Backward compatibility: old env var names should still work
  it("falls back to old env var PI_HINDSIGHT_RECALL_TYPES", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = '["world", "experience"]';

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["world", "experience"]);
  });

  it("falls back to old env var PI_HINDSIGHT_RECALL_SHOW_DATETIME", () => {
    process.env.PI_HINDSIGHT_RECALL_SHOW_DATETIME = "false";

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallShowDateTime).toBe(false);
  });

  it("prioritizes new env var PI_HINDSIGHT_AUTO_RECALL_TYPES over old PI_HINDSIGHT_RECALL_TYPES", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TYPES = '["world"]';
    process.env.PI_HINDSIGHT_RECALL_TYPES = '["experience"]';

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["world"]);
  });

  it("prioritizes new env var PI_HINDSIGHT_AUTO_RECALL_SHOW_DATETIME over old PI_HINDSIGHT_RECALL_SHOW_DATETIME", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_SHOW_DATETIME = "true";
    process.env.PI_HINDSIGHT_RECALL_SHOW_DATETIME = "false";

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallShowDateTime).toBe(true);
  });

  it("prioritizes new config key autoRecallShowDateTime over old recallShowDateTime", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallShowDateTime: false,
        autoRecallShowDateTime: true,
      })
    );

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallShowDateTime).toBe(true);
  });

  it("includes old env var name in envVars when old env var is used", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = '["world"]';

    const { envVars } = loadConfig(TEST_DIR);
    expect(envVars).toContain("PI_HINDSIGHT_RECALL_TYPES");
  });

  it("includes old env var name but not new when only old is set", () => {
    process.env.PI_HINDSIGHT_RECALL_SHOW_DATETIME = "false";

    const { envVars } = loadConfig(TEST_DIR);
    expect(envVars).toContain("PI_HINDSIGHT_RECALL_SHOW_DATETIME");
    expect(envVars).not.toContain("PI_HINDSIGHT_AUTO_RECALL_SHOW_DATETIME");
  });

  it("warns on invalid recallTypes value through backward compat config file key", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallTypes: ["invalid", "observation"],
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toContain("autoRecallTypes contains invalid values");
  });

  it("warns on invalid recallShowDateTime value through backward compat config file key", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallShowDateTime: "yes",
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallShowDateTime).toBe(true); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("Invalid boolean value");
  });

  it("warns on invalid PI_HINDSIGHT_RECALL_TYPES value through backward compat", () => {
    process.env.PI_HINDSIGHT_RECALL_TYPES = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toContain("autoRecallTypes contains invalid JSON");
  });

  it("warns on invalid PI_HINDSIGHT_RECALL_SHOW_DATETIME value through backward compat", () => {
    process.env.PI_HINDSIGHT_RECALL_SHOW_DATETIME = "yes";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallShowDateTime).toBe(true); // Falls back to default
    expect(warning).toContain("Invalid boolean value");
  });

  it("old env var overrides old config file key (env vars always override files)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallTypes: ["world"],
      })
    );
    process.env.PI_HINDSIGHT_RECALL_TYPES = '["experience"]';

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["experience"]);
  });

  it("old env var overrides new config file key (env vars always override files)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTypes: ["world"],
      })
    );
    process.env.PI_HINDSIGHT_RECALL_TYPES = '["experience"]';

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["experience"]);
  });

  it("new env var overrides old config file key (env vars always override files)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        recallTypes: ["world"],
      })
    );
    process.env.PI_HINDSIGHT_AUTO_RECALL_TYPES = '["experience"]';

    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["experience"]);
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

  it("hindsightContextPrefix can be set to empty string via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        hindsightContextPrefix: "",
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.hindsightContextPrefix).toBe("");
    expect(warning).toBeUndefined();
  });

  it("hindsightContextPrefix can be set to empty string via env var", () => {
    process.env.PI_HINDSIGHT_CONTEXT_PREFIX = "";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.hindsightContextPrefix).toBe("");
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

  // autoRecallTypes JSON parsing warning tests
  it("warns on invalid JSON in autoRecallTypes via env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TYPES = "not-json";

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("autoRecallTypes contains invalid JSON");
  });

  it("warns on non-array JSON in autoRecallTypes via env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TYPES = '"not-an-array"';

    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTypes).toEqual(["observation"]); // Falls back to default
    expect(warning).toBeDefined();
    expect(warning).toContain("autoRecallTypes must be a JSON array");
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

  it("warns on invalid toolFilter type in config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        toolFilter: 42,
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    // Falls back to default
    expect((config.toolFilter.toolCall as { exclude: string[] }).exclude).toContain("grep");
    expect(warning).toContain("toolFilter must be an object, got number");
  });

  it("does not warn on null toolFilter (might be intentional)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        toolFilter: null,
      })
    );

    const { config, warning } = loadConfig(TEST_DIR);
    // null is ignored, keeps default
    expect((config.toolFilter.toolCall as { exclude: string[] }).exclude).toContain("grep");
    // null should not produce a warning (consistent with retainContent/strip)
    // If warning is defined, it must not mention toolFilter
    if (warning) {
      expect(warning).not.toContain("toolFilter");
    }
  });

  it("empty toolFilter means no filtering", () => {
    loadConfig(TEST_DIR);
    // Default has values; test empty override
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        bankId: "test-bank",
        observationScopes: [["{session}"]],
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
  it("defaults to null (invalid — must be set)", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
    const { valid, errors } = validateConfig(config);
    expect(valid).toBe(false);
    expect(errors).toContain(
      "observationScopes: is required (must be a preset string or an array of tag arrays)"
    );
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

  it("rejects null from config file (loadConfig warns, validateConfig errors)", () => {
    writeFileSync(
      join(TEST_DIR, "config.jsonc"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        observationScopes: null,
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
    expect(warning).toContain("observationScopes is required");
    const { valid, errors } = validateConfig(config);
    expect(valid).toBe(false);
    expect(errors).toContain(
      "observationScopes: is required (must be a preset string or an array of tag arrays)"
    );
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

  it("rejects null from env var (loadConfig warns, validateConfig errors)", () => {
    process.env.PI_HINDSIGHT_OBSERVATION_SCOPES = "null";
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.observationScopes).toBe(null);
    expect(warning).toContain("observationScopes is required");
    const { valid, errors } = validateConfig(config);
    expect(valid).toBe(false);
    expect(errors).toContain(
      "observationScopes: is required (must be a preset string or an array of tag arrays)"
    );
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

  it("rejects null observationScopes", () => {
    const result = validateConfig({
      ...validConfig,
      observationScopes: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "observationScopes: is required (must be a preset string or an array of tag arrays)"
    );
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

  it("rejects non-string/array value", () => {
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

  it("expands {cwd} placeholder", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{cwd}"]], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/project",
    });
    expect(result).toEqual([["cwd:/home/user/project"]]);
  });

  it("preserves {cwd} when sessionCwd is not provided", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{cwd}"]], {
      sessionId: "abc-123",
    });
    expect(result).toEqual([["{cwd}"]]);
  });

  it("expands {cwd} alongside other placeholders", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{session}", "{cwd}"]], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/project",
    });
    expect(result).toEqual([["session:abc-123", "cwd:/home/user/project"]]);
  });

  it("expands {basedir} placeholder", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{basedir}"]], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual([["basedir:myapp"]]);
  });

  it("preserves {basedir} when sessionCwd is not provided", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{basedir}"]], {
      sessionId: "abc-123",
    });
    expect(result).toEqual([["{basedir}"]]);
  });

  it("expands {project} placeholder with projectName", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{project}"]], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
      projectName: "custom-project",
    });
    expect(result).toEqual([["project:custom-project"]]);
  });

  it("expands {project} placeholder falling back to cwd basename when projectName is not provided", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{project}"]], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual([["project:myapp"]]);
  });

  it("preserves {project} when neither projectName nor sessionCwd is provided", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{project}"]], {
      sessionId: "abc-123",
    });
    expect(result).toEqual([["{project}"]]);
  });

  it("expands {basedir} and {project} alongside other placeholders", () => {
    const { expandScopePlaceholders } = require("../src/config");
    const result = expandScopePlaceholders([["{session}", "{basedir}", "{project}"]], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
      projectName: "custom-project",
    });
    expect(result).toEqual([["session:abc-123", "basedir:myapp", "project:custom-project"]]);
  });
});

describe("autoRecallTags", () => {
  it("defaults to null (no recall tag filtering)", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toBe(null);
  });

  it("autoRecallTagsMatch defaults to 'any'", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagsMatch).toBe("any");
  });

  it("autoRecallTags can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: ["project:myapp", "user:alice"],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toEqual(["project:myapp", "user:alice"]);
  });

  it("autoRecallTags can include placeholders", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: ["{project}", "user:alice"],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toEqual(["{project}", "user:alice"]);
  });

  it("autoRecallTags null from config file means no filtering", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: null,
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toBe(null);
  });

  it("autoRecallTags empty array means no filtering", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: [],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toBe(null);
  });

  it("autoRecallTags can be set via PI_HINDSIGHT_AUTO_RECALL_TAGS env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAGS = '["{project}","user:alice"]';
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toEqual(["{project}", "user:alice"]);
  });

  it("autoRecallTags null via env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAGS = "null";
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toBe(null);
  });

  it("autoRecallTags empty array via env var means no filtering", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAGS = "[]";
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toBe(null);
  });

  it("warns on invalid JSON in autoRecallTags env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAGS = "not-json";
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toBe(null);
    expect(warning).toContain("autoRecallTags contains invalid JSON");
  });

  it("warns on non-array autoRecallTags env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAGS = '"not-array"';
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toBe(null);
    expect(warning).toContain("autoRecallTags must be a JSON array");
  });

  it("autoRecallTagsMatch can be set via config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: ["project:myapp"],
        autoRecallTagsMatch: "all_strict",
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagsMatch).toBe("all_strict");
  });

  it("autoRecallTagsMatch can be set via PI_HINDSIGHT_AUTO_RECALL_TAGS_MATCH env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAGS_MATCH = "any_strict";
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagsMatch).toBe("any_strict");
  });

  it("warns on invalid autoRecallTagsMatch", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAGS_MATCH = "invalid";
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagsMatch).toBe("any"); // falls back to default
    expect(warning).toContain("Invalid autoRecallTagsMatch");
  });

  it("env var overrides config file for autoRecallTags", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: ["project:old"],
      })
    );
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAGS = '["project:new"]';
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toEqual(["project:new"]);
  });

  it("validates autoRecallTags with non-exact placeholder usage", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: ["{project}:extra", "user:alice"],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toEqual(["{project}:extra", "user:alice"]);
    const { warnings } = validateConfig(config);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("{project}");
    expect(warnings[0]).toContain("standalone");
  });

  it("warns on non-string items in autoRecallTags config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: ["project:myapp", 42],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTags).toBe(null);
    expect(warning).toContain("autoRecallTags must be a JSON array of strings");
  });

  it("validateConfig errors on invalid autoRecallTagsMatch", () => {
    const config = {
      ...validConfig,
      autoRecallTags: ["project:myapp"],
      autoRecallTagsMatch: "invalid" as unknown as import("../src/config").TagsMatch,
    };
    const { errors } = validateConfig(config);
    expect(errors).toContain(
      'autoRecallTagsMatch: invalid value "invalid". Expected one of: any, all, any_strict, all_strict'
    );
  });
});

describe("expandAutoRecallTags", () => {
  it("returns null unchanged", () => {
    const { expandAutoRecallTags } = require("../src/config");
    expect(expandAutoRecallTags(null, { sessionId: "abc-123" })).toBe(null);
  });

  it("expands {project} placeholder", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{project}"], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual(["project:myapp"]);
  });

  it("expands {project} with explicit projectName", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{project}"], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
      projectName: "custom-project",
    });
    expect(result).toEqual(["project:custom-project"]);
  });

  it("expands {cwd} placeholder", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{cwd}"], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual(["cwd:/home/user/myapp"]);
  });

  it("expands {basedir} placeholder", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{basedir}"], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual(["basedir:myapp"]);
  });

  it("expands {session} placeholder", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{session}"], {
      sessionId: "abc-123",
    });
    expect(result).toEqual(["session:abc-123"]);
  });

  it("expands multiple placeholders and literal tags", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{project}", "user:alice", "{cwd}"], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual(["project:myapp", "user:alice", "cwd:/home/user/myapp"]);
  });

  it("leaves literal tags unchanged", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["project:myapp", "user:alice"], {
      sessionId: "abc-123",
    });
    expect(result).toEqual(["project:myapp", "user:alice"]);
  });

  it("keeps unresolvable placeholders as-is", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{cwd}", "{project}"], {
      sessionId: "abc-123",
      // no sessionCwd
    });
    expect(result).toEqual(["{cwd}", "{project}"]);
  });

  it("expands {parent} placeholder", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{parent}"], {
      sessionId: "abc-123",
      parentSessionId: "parent-456",
    });
    expect(result).toEqual(["parent:parent-456"]);
  });

  it("{parent} falls back to session ID", () => {
    const { expandAutoRecallTags } = require("../src/config");
    const result = expandAutoRecallTags(["{parent}"], {
      sessionId: "abc-123",
    });
    expect(result).toEqual(["parent:abc-123"]);
  });
});

describe("autoRecallTagGroups", () => {
  it("defaults to null (no tag group filtering)", () => {
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
  });

  it("can be set via config file with leaf groups", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [
          { tags: ["project:myapp"], match: "any_strict" },
          { tags: ["user:alice"], match: "all" },
        ],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toEqual([
      { tags: ["project:myapp"], match: "any_strict" },
      { tags: ["user:alice"], match: "all" },
    ]);
  });

  it("can be set via config file with nested and/or/not", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [
          {
            or: [
              { tags: ["project:myapp"], match: "any_strict" },
              { tags: ["user:alice"], match: "any_strict" },
            ],
          },
          { not: { tags: ["session:abc-123"], match: "any_strict" } },
        ],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toEqual([
      {
        or: [
          { tags: ["project:myapp"], match: "any_strict" },
          { tags: ["user:alice"], match: "any_strict" },
        ],
      },
      { not: { tags: ["session:abc-123"], match: "any_strict" } },
    ]);
  });

  it("can include placeholders", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [
          { tags: ["{project}"], match: "any_strict" },
          { not: { tags: ["{session}"], match: "any_strict" } },
        ],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toEqual([
      { tags: ["{project}"], match: "any_strict" },
      { not: { tags: ["{session}"], match: "any_strict" } },
    ]);
  });

  it("null from config file means no filtering", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: null,
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
  });

  it("empty array means no filtering", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
  });

  it("can be set via PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS =
      '[{"tags":["project:myapp"],"match":"any_strict"}]';
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toEqual([{ tags: ["project:myapp"], match: "any_strict" }]);
  });

  it("null via env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS = "null";
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
  });

  it("empty array via env var means no filtering", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS = "[]";
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
  });

  it("warns on invalid JSON in env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS = "not-json";
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups contains invalid JSON");
  });

  it("warns on non-array JSON in env var", () => {
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS = '"not-array"';
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be a JSON array");
  });

  it("warns on non-array value from config file (e.g. bare object)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: { tags: ["a"] },
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("warns on invalid tag group structure", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ invalid: true }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("warns on non-array tags in leaf", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: "not-an-array" }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("warns on non-string items in tags array", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: ["valid", 42] }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("warns on invalid match value in leaf", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: ["valid"], match: "invalid" }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("warns on empty and/or arrays in compound groups", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ and: [] }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("warns on invalid child in compound group", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ and: [{ invalid: true }] }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("env var overrides config file", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: ["old"] }],
      })
    );
    process.env.PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS = '[{"tags":["new"],"match":"any_strict"}]';
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toEqual([{ tags: ["new"], match: "any_strict" }]);
  });

  it("validates non-exact placeholder usage in tag groups", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: ["{project}:extra"] }],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toEqual([{ tags: ["{project}:extra"] }]);
    const { warnings } = validateConfig(config);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("{project}");
    expect(warnings[0]).toContain("standalone");
  });

  it("validates non-exact placeholder in nested not group", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ not: { tags: ["{session}:extra"] } }],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    const { warnings } = validateConfig(config);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("{session}");
  });

  it("warns when both autoRecallTags and autoRecallTagGroups are set", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTags: ["project:myapp"],
        autoRecallTagGroups: [{ tags: ["project:myapp"], match: "any_strict" }],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    const { warnings } = validateConfig(config);
    expect(
      warnings.some((w) => w.includes("Both autoRecallTags and autoRecallTagGroups are set"))
    ).toBe(true);
  });

  it("no warning when only autoRecallTagGroups is set", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: ["project:myapp"], match: "any_strict" }],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    const { warnings } = validateConfig(config);
    expect(
      warnings.some((w) => w.includes("Both autoRecallTags and autoRecallTagGroups are set"))
    ).toBe(false);
  });

  it("accepts leaf without match field (match is optional)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: ["project:myapp"] }],
      })
    );
    const { config } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toEqual([{ tags: ["project:myapp"] }]);
  });

  it("warns on extra keys in leaf", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: ["valid"], extra: true }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("warns on empty tags array in leaf", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ tags: [] }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });

  it("warns on mixed compound keys (and + or)", () => {
    writeFileSync(
      join(TEST_DIR, "config.json"),
      JSON.stringify({
        apiUrl: "https://test.test",
        apiKey: "test-key",
        autoRecallTagGroups: [{ and: [{ tags: ["a"] }], or: [{ tags: ["b"] }] }],
      })
    );
    const { config, warning } = loadConfig(TEST_DIR);
    expect(config.autoRecallTagGroups).toBe(null);
    expect(warning).toContain("autoRecallTagGroups must be an array of tag group objects");
  });
});

describe("expandAutoRecallTagGroups", () => {
  it("returns null unchanged", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    expect(expandAutoRecallTagGroups(null, { sessionId: "abc-123" })).toBe(null);
  });

  it("expands {project} in leaf tags", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups([{ tags: ["{project}"], match: "any_strict" }], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual([{ tags: ["project:myapp"], match: "any_strict" }]);
  });

  it("expands {session} in nested not group", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups(
      [{ not: { tags: ["{session}"], match: "any_strict" } }],
      { sessionId: "abc-123" }
    );
    expect(result).toEqual([{ not: { tags: ["session:abc-123"], match: "any_strict" } }]);
  });

  it("expands {project} with explicit projectName", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups([{ tags: ["{project}"], match: "any_strict" }], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
      projectName: "custom-project",
    });
    expect(result).toEqual([{ tags: ["project:custom-project"], match: "any_strict" }]);
  });

  it("expands placeholders in or group", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups(
      [
        {
          or: [
            { tags: ["{project}"], match: "any_strict" },
            { tags: ["{cwd}"], match: "any_strict" },
          ],
        },
      ],
      { sessionId: "abc-123", sessionCwd: "/home/user/myapp" }
    );
    expect(result).toEqual([
      {
        or: [
          { tags: ["project:myapp"], match: "any_strict" },
          { tags: ["cwd:/home/user/myapp"], match: "any_strict" },
        ],
      },
    ]);
  });

  it("expands placeholders in and group", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups(
      [
        {
          and: [
            { tags: ["{project}"], match: "any_strict" },
            { not: { tags: ["{session}"], match: "any_strict" } },
          ],
        },
      ],
      { sessionId: "abc-123", sessionCwd: "/home/user/myapp" }
    );
    expect(result).toEqual([
      {
        and: [
          { tags: ["project:myapp"], match: "any_strict" },
          { not: { tags: ["session:abc-123"], match: "any_strict" } },
        ],
      },
    ]);
  });

  it("leaves literal tags unchanged", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups(
      [{ tags: ["project:myapp", "user:alice"], match: "any" }],
      { sessionId: "abc-123" }
    );
    expect(result).toEqual([{ tags: ["project:myapp", "user:alice"], match: "any" }]);
  });

  it("keeps unresolvable placeholders as-is", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups([{ tags: ["{cwd}", "{project}"], match: "any" }], {
      sessionId: "abc-123",
    });
    expect(result).toEqual([{ tags: ["{cwd}", "{project}"], match: "any" }]);
  });

  it("expands {parent} placeholder", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups([{ tags: ["{parent}"], match: "any_strict" }], {
      sessionId: "abc-123",
      parentSessionId: "parent-456",
    });
    expect(result).toEqual([{ tags: ["parent:parent-456"], match: "any_strict" }]);
  });

  it("expands {basedir} placeholder", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups([{ tags: ["{basedir}"], match: "any_strict" }], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual([{ tags: ["basedir:myapp"], match: "any_strict" }]);
  });

  it("preserves match field during expansion", () => {
    const { expandAutoRecallTagGroups } = require("../src/config");
    const result = expandAutoRecallTagGroups([{ tags: ["{project}"], match: "all_strict" }], {
      sessionId: "abc-123",
      sessionCwd: "/home/user/myapp",
    });
    expect(result).toEqual([{ tags: ["project:myapp"], match: "all_strict" }]);
  });
});
