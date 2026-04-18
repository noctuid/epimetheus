/**
 * Configuration loading for pi-hindsight extension.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { Budget } from "@vectorize-io/hindsight-client";

export interface RetainContent {
  assistant: ("text" | "thinking" | "toolCall")[];
  user: ("text" | "image")[];
  toolResult: ("text")[];
}

export interface StripConfig {
  topLevel: string[];
  message: string[];
}

export interface EntityInput {
  /** The entity name/text (e.g., "John") */
  text: string;
  /** Optional entity type (e.g., "PERSON", "ORG", "CONCEPT") */
  type?: string;
}

export type MemoryType = "world" | "experience" | "observation";

export interface HindsightConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  bankId: string;
  toolsEnabled: boolean;
  autoRecallEnabled: boolean;
  autoRecallBudget: Budget;
  autoRetainEnabled: boolean;
  hindsightContextPrefix: string;
  hindsightContextMaxLength: number;
  maxRecallTokens: number | null;
  recallPromptPreamble: string;
  recallShowDateTime: boolean;
  recallDisplay: boolean;
  recallPersist: boolean;
  recallMaxQueryChars: number;
  recallTypes: MemoryType[] | null;
  constantTags: string[];
  retainContent: RetainContent;
  strip: StripConfig;
  flushOnCompact: boolean;
  entities: EntityInput[];
}

const VALID_MEMORY_TYPES = ["world", "experience", "observation"] as const;

const DEFAULT_CONFIG: HindsightConfig = {
  enabled: true,
  apiUrl: "",
  apiKey: "",
  bankId: "pi-default",
  toolsEnabled: true,
  autoRecallEnabled: true,
  autoRecallBudget: "mid",
  autoRetainEnabled: true,
  hindsightContextPrefix: "pi: ",
  hindsightContextMaxLength: 100,
  maxRecallTokens: null,
  recallPromptPreamble:
    "[System note: The following is recalled memory context, NOT new user input. Prioritize recent when conflicting. Only use memories that are directly useful to continue this conversation; ignore the rest]",
  recallShowDateTime: true,
  recallDisplay: false,
  recallPersist: false,
  recallMaxQueryChars: 800,
  recallTypes: ["observation"],
  constantTags: ["harness:pi"],
  retainContent: {
    assistant: ["text", "thinking", "toolCall"],
    user: ["text"],
    toolResult: ["text"],
  },
  strip: {
    topLevel: ["type", "id", "parentId"],
    message: ["api", "provider", "model", "usage", "cost", "stopReason", "timestamp", "responseId"],
  },
  flushOnCompact: false,
  entities: [],
};

// Config keys that can be set via env vars or config file
const VALID_CONFIG_KEYS = new Set<keyof HindsightConfig>([
  "enabled", "apiUrl", "apiKey", "bankId", "toolsEnabled", "autoRecallEnabled", "autoRecallBudget",
  "autoRetainEnabled", "hindsightContextPrefix", "hindsightContextMaxLength", "maxRecallTokens",
  "recallPromptPreamble", "recallShowDateTime", "recallDisplay", "recallPersist", "recallMaxQueryChars", "recallTypes",
  "constantTags", "retainContent", "strip", "flushOnCompact", "entities",
]);

function parseBoolean(value: string | undefined, defaultValue: boolean): { value: boolean; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  const lower = value.toLowerCase();
  if (lower === "true") return { value: true };
  if (lower === "false") return { value: false };
  return {
    value: defaultValue,
    warning: `Invalid boolean value "${value}", expected "true" or "false". Using default: ${defaultValue}`,
  };
}

function parseJsonArray(value: string | undefined, defaultValue: string[], fieldName: string): { value: string[]; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return { value: parsed };
    return {
      value: defaultValue,
      warning: `${fieldName} must be a JSON array, got ${typeof parsed}. Using default.`,
    };
  } catch {
    return {
      value: defaultValue,
      warning: `${fieldName} contains invalid JSON. Using default.`,
    };
  }
}

function parseBudget(value: string | undefined, defaultValue: Budget): { value: Budget; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  const valid: Budget[] = ["low", "mid", "high"];
  const lower = value.toLowerCase();
  if (valid.includes(lower as Budget)) return { value: lower as Budget };
  return {
    value: defaultValue,
    warning: `Invalid budget "${value}", expected "low", "mid", or "high". Using default: ${defaultValue}`,
  };
}

function parseNumber(value: string | undefined, defaultValue: number | null, fieldName: string): { value: number | null; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  const num = parseInt(value, 10);
  if (!isNaN(num)) return { value: num };
  const defaultDesc = defaultValue === null ? "null" : defaultValue;
  return {
    value: defaultValue,
    warning: `Invalid number for ${fieldName}: "${value}". Using default: ${defaultDesc}`,
  };
}

function parseMemoryTypes(value: string | undefined, defaultValue: MemoryType[] | null): { value: MemoryType[] | null; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  try {
    const parsed = JSON.parse(value);
    if (parsed === null) return { value: null }; // JSON null ("null" string or actual null)
    if (!Array.isArray(parsed)) {
      return {
        value: defaultValue,
        warning: `recallTypes must be a JSON array, got ${typeof parsed}. Using default.`,
      };
    }
    if (parsed.length === 0) return { value: null }; // Empty array means all types
    // Validate each type
    const valid = parsed.every((t) => VALID_MEMORY_TYPES.includes(t));
    if (!valid) {
      return {
        value: defaultValue,
        warning: `recallTypes contains invalid values. Valid types: ${VALID_MEMORY_TYPES.join(", ")}`,
      };
    }
    return { value: parsed as MemoryType[] };
  } catch {
    return {
      value: defaultValue,
      warning: `recallTypes contains invalid JSON. Using default.`,
    };
  }
}

/**
 * Set a config value with type coercion.
 * Returns a warning string if the value was invalid and fallback was used.
 */
function setConfigValue(
  config: HindsightConfig,
  key: keyof HindsightConfig,
  value: unknown,
): string | undefined {
  switch (key) {
    case "enabled":
    case "toolsEnabled":
    case "autoRecallEnabled":
    case "autoRetainEnabled":
    case "recallShowDateTime":
    case "recallDisplay":
    case "recallPersist":
    case "flushOnCompact": {
      if (typeof value === "boolean") {
        config[key] = value;
        return;
      }
      const result = parseBoolean(String(value), DEFAULT_CONFIG[key] as boolean);
      config[key] = result.value;
      return result.warning;
    }
    case "autoRecallBudget": {
      if (typeof value === "string") {
        const result = parseBudget(value, DEFAULT_CONFIG[key] as Budget);
        config[key] = result.value;
        return result.warning;
      }
      config[key] = DEFAULT_CONFIG[key];
      return;
    }
    case "hindsightContextMaxLength":
    case "recallMaxQueryChars": {
      if (typeof value === "number") {
        config[key] = value;
        return;
      }
      const result = parseNumber(String(value), DEFAULT_CONFIG[key] as number, key);
      config[key] = result.value ?? DEFAULT_CONFIG[key] as number;
      return result.warning;
    }
    case "maxRecallTokens": {
      if (typeof value === "number") {
        config[key] = value;
        return;
      }
      const result = parseNumber(String(value), DEFAULT_CONFIG[key] as number | null, key);
      config[key] = result.value;
      return result.warning;
    }
    case "recallTypes":
      if (value === null || (Array.isArray(value) && value.length === 0)) {
        config[key] = null;
        return;
      }
      if (Array.isArray(value)) {
        // Validate each type
        const valid = value.every((t) => VALID_MEMORY_TYPES.includes(t));
        if (!valid) {
          config[key] = DEFAULT_CONFIG[key];
          return `recallTypes contains invalid values. Valid types: ${VALID_MEMORY_TYPES.join(", ")}`;
        }
        config[key] = value;
        return;
      }
      // String value from env var - parse and check for warning
      {
        const result = parseMemoryTypes(String(value), DEFAULT_CONFIG[key] as MemoryType[] | null);
        config[key] = result.value;
        return result.warning;
      }
    case "constantTags": {
      if (Array.isArray(value)) {
        config[key] = value;
        return;
      }
      const result = parseJsonArray(String(value), DEFAULT_CONFIG[key] as string[], "constantTags");
      config[key] = result.value;
      return result.warning;
    }
    case "entities": {
      if (Array.isArray(value)) {
        config[key] = value;
        return;
      }
      // String value from env var - parse and check for warning
      try {
        const parsed = JSON.parse(String(value));
        if (Array.isArray(parsed)) {
          config[key] = parsed;
          return;
        }
        config[key] = DEFAULT_CONFIG[key];
        return `entities must be a JSON array, got ${typeof parsed}. Using default.`;
      } catch {
        config[key] = DEFAULT_CONFIG[key];
        return "entities contains invalid JSON. Using default.";
      }
    }
    case "retainContent":
    case "strip":
      // Replace entirely (not merge) - user must provide complete object
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        Object.assign(config, { [key]: value });
        return;
      }
      // null might be intentional (e.g., unsetting config), don't warn
      if (value === null) {
        return;
      }
      config[key] = DEFAULT_CONFIG[key];
      return `${key} must be an object, got ${Array.isArray(value) ? "array" : typeof value}. Using default.`;
    case "apiUrl":
    case "apiKey":
    case "bankId":
    case "hindsightContextPrefix":
    case "recallPromptPreamble":
      config[key] = String(value);
      return;
    default: {
      // This should never happen if VALID_CONFIG_KEYS is correct
      const _exhaustive: never = key;
      throw new Error(`Unexpected config key: ${_exhaustive}`);
    }
  }
}

export function loadConfig(extensionsDir?: string): { config: HindsightConfig; warning?: string } {
  // Deep copy to avoid mutating DEFAULT_CONFIG
  // Note: retainContent and strip are replaced entirely (not merged) in setConfigValue
  const config: HindsightConfig = {
    ...DEFAULT_CONFIG,
    retainContent: { ...DEFAULT_CONFIG.retainContent },
    strip: { ...DEFAULT_CONFIG.strip },
  };
  const warnings: string[] = [];

  // Load from config file (prefer .jsonc over .json)
  const dir = extensionsDir ?? join(getAgentDir(), "extensions");
  const jsoncPath = join(dir, "pi-hindsight.jsonc");
  const jsonPath = join(dir, "pi-hindsight.json");

  const configPath = existsSync(jsoncPath) ? jsoncPath : (existsSync(jsonPath) ? jsonPath : null);

  if (configPath) {
    try {
      const fileContent = readFileSync(configPath, "utf-8");
      const errors: ParseError[] = [];
      const fileConfig = parseJsonc(fileContent, errors, { allowTrailingComma: true });

      if (errors.length > 0) {
        warnings.push(`Failed to parse config file ${configPath}: ${errors.length} parse error(s). Using defaults.`);
      } else {
        for (const [key, value] of Object.entries(fileConfig as object)) {
          if (!VALID_CONFIG_KEYS.has(key as keyof HindsightConfig)) {
            warnings.push(`Unknown config key in file: ${key}`);
            continue;
          }
          const warning = setConfigValue(config, key as keyof HindsightConfig, value);
          if (warning) warnings.push(warning);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      warnings.push(`Failed to load config file ${configPath}: ${message}. Using defaults.`);
    }
  }

  // Override with environment variables
  const envMappings: Record<string, keyof HindsightConfig> = {
    PI_HINDSIGHT_ENABLED: "enabled",
    HINDSIGHT_API_URL: "apiUrl",
    HINDSIGHT_API_KEY: "apiKey",
    PI_HINDSIGHT_BANK_ID: "bankId",
    PI_HINDSIGHT_TOOLS_ENABLED: "toolsEnabled",
    PI_HINDSIGHT_AUTO_RECALL_ENABLED: "autoRecallEnabled",
    PI_HINDSIGHT_AUTO_RECALL_BUDGET: "autoRecallBudget",
    PI_HINDSIGHT_AUTO_RETAIN_ENABLED: "autoRetainEnabled",
    PI_HINDSIGHT_CONTEXT_PREFIX: "hindsightContextPrefix",
    PI_HINDSIGHT_CONTEXT_MAX_LENGTH: "hindsightContextMaxLength",
    PI_HINDSIGHT_MAX_RECALL_TOKENS: "maxRecallTokens",
    PI_HINDSIGHT_RECALL_PROMPT_PREAMBLE: "recallPromptPreamble",
    PI_HINDSIGHT_RECALL_SHOW_DATETIME: "recallShowDateTime",
    PI_HINDSIGHT_RECALL_DISPLAY: "recallDisplay",
    PI_HINDSIGHT_RECALL_PERSIST: "recallPersist",
    PI_HINDSIGHT_RECALL_MAX_QUERY_CHARS: "recallMaxQueryChars",
    PI_HINDSIGHT_RECALL_TYPES: "recallTypes",
    PI_HINDSIGHT_CONSTANT_TAGS: "constantTags",
    PI_HINDSIGHT_FLUSH_ON_COMPACT: "flushOnCompact",
    PI_HINDSIGHT_ENTITIES: "entities",
  };

  for (const [envVar, configKey] of Object.entries(envMappings)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      const warning = setConfigValue(config, configKey, value);
      if (warning) warnings.push(warning);
    }
  }

  return { config, warning: warnings.length > 0 ? warnings.join("; ") : undefined };
}

export function validateConfig(config: HindsightConfig): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.apiUrl) {
    errors.push("apiUrl is required (set in pi-hindsight.json or HINDSIGHT_API_URL env var)");
  }

  if (!config.apiKey) {
    errors.push("apiKey is required (set in pi-hindsight.json or HINDSIGHT_API_KEY env var)");
  }

  if (config.hindsightContextMaxLength < 0) {
    errors.push("hindsightContextMaxLength must be >= 0");
  }

  if (config.recallMaxQueryChars < 1) {
    errors.push("recallMaxQueryChars must be >= 1");
  }

  // Validate retainContent - user and assistant must have at least one content type
  if (config.retainContent.user.length === 0) {
    errors.push("retainContent.user cannot be empty (at least one content type required)");
  }

  if (config.retainContent.assistant.length === 0) {
    errors.push("retainContent.assistant cannot be empty (at least one content type required)");
  }

  // Check for duplicates in retainContent
  for (const role of ["user", "assistant", "toolResult"] as const) {
    const items = config.retainContent[role];
    const unique = new Set(items);
    if (unique.size !== items.length) {
      errors.push(`retainContent.${role} contains duplicate values`);
    }
  }

  // Check for duplicates in strip
  for (const field of ["topLevel", "message"] as const) {
    const items = config.strip[field];
    const unique = new Set(items);
    if (unique.size !== items.length) {
      errors.push(`strip.${field} contains duplicate values`);
    }
  }

  // Check for duplicates in recallTypes (null means all types, no validation needed)
  if (config.recallTypes !== null) {
    const unique = new Set(config.recallTypes);
    if (unique.size !== config.recallTypes.length) {
      errors.push("recallTypes contains duplicate values");
    }
  }

  // Warn if recallDisplay is true but recallPersist is false
  if (config.recallDisplay && !config.recallPersist) {
    warnings.push("recallDisplay: true has no effect when recallPersist: false (context event never shows in TUI)");
  }

  return { valid: errors.length === 0, errors, warnings };
}
