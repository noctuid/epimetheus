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
  recallTypes: null,
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

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
}

function parseJsonArray(value: string | undefined, defaultValue: string[]): string[] {
  if (value === undefined) return defaultValue;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

function parseBudget(value: string | undefined, defaultValue: Budget): Budget {
  if (value === undefined) return defaultValue;
  const valid = ["low", "mid", "high"];
  const lower = value.toLowerCase();
  return valid.includes(lower) ? (lower as "low" | "mid" | "high") : defaultValue;
}

function parseNumber(value: string | undefined, defaultValue: number | null): number | null {
  if (value === undefined) return defaultValue;
  const num = parseInt(value, 10);
  return isNaN(num) ? defaultValue : num;
}

function parseMemoryTypes(value: string | undefined, defaultValue: MemoryType[] | null): MemoryType[] | null {
  if (value === undefined) return defaultValue;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return defaultValue;
    if (parsed.length === 0) return null; // Empty array means all types
    // Validate each type
    const valid = parsed.every((t) => VALID_MEMORY_TYPES.includes(t));
    if (!valid) return defaultValue;
    return parsed as MemoryType[];
  } catch {
    return defaultValue;
  }
}

/**
 * Set a config value with type coercion.
 */
function setConfigValue(
  config: HindsightConfig,
  key: keyof HindsightConfig,
  value: unknown,
): void {
  switch (key) {
    case "enabled":
    case "toolsEnabled":
    case "autoRecallEnabled":
    case "autoRetainEnabled":
    case "recallShowDateTime":
    case "recallDisplay":
    case "recallPersist":
    case "flushOnCompact":
      config[key] = typeof value === "boolean" ? value : parseBoolean(String(value), DEFAULT_CONFIG[key] as boolean);
      break;
    case "autoRecallBudget":
      config[key] = typeof value === "string" ? parseBudget(value, DEFAULT_CONFIG[key] as Budget) : DEFAULT_CONFIG[key];
      break;
    case "hindsightContextMaxLength":
    case "recallMaxQueryChars":
      config[key] = typeof value === "number" ? value : parseNumber(String(value), DEFAULT_CONFIG[key] as number) ?? DEFAULT_CONFIG[key];
      break;
    case "maxRecallTokens":
      config[key] = typeof value === "number" ? value : parseNumber(String(value), DEFAULT_CONFIG[key] as number | null);
      break;
    case "recallTypes":
      config[key] = Array.isArray(value) || value === null
        ? (value as MemoryType[] | null)
        : parseMemoryTypes(String(value), DEFAULT_CONFIG[key] as MemoryType[] | null);
      break;
    case "constantTags":
      config[key] = Array.isArray(value) ? value : parseJsonArray(String(value), DEFAULT_CONFIG[key] as string[]);
      break;
    case "entities":
      config[key] = Array.isArray(value) ? value : DEFAULT_CONFIG[key];
      break;
    case "retainContent":
    case "strip":
      // Replace entirely (not merge) - user must provide complete object
      if (typeof value === "object" && value !== null) {
        Object.assign(config, { [key]: value });
      }
      break;
    case "apiUrl":
    case "apiKey":
    case "bankId":
    case "hindsightContextPrefix":
    case "recallPromptPreamble":
      config[key] = String(value);
      break;
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
          setConfigValue(config, key as keyof HindsightConfig, value);
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
      // Special handling for entities (JSON array of objects)
      if (configKey === "entities") {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            config.entities = parsed;
          }
        } catch {
          // Invalid JSON, keep default
        }
      } else {
        setConfigValue(config, configKey, value);
      }
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

  // Warn if recallDisplay is true but recallPersist is false
  if (config.recallDisplay && !config.recallPersist) {
    warnings.push("recallDisplay: true has no effect when recallPersist: false (context event never shows in TUI)");
  }

  return { valid: errors.length === 0, errors, warnings };
}
