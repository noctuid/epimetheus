/**
 * Configuration loading for the epimetheus extension.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  Budget,
  TagGroupAndInput,
  TagGroupLeaf,
  TagGroupNotInput,
  TagGroupOrInput,
} from "@vectorize-io/hindsight-client";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { prefixLog } from "./constants";
import { getDataDir } from "./data-dir";
import { offsetToLineColumn } from "./utils";

export interface RetainContent {
  assistant: ("text" | "thinking" | "toolCall")[];
  user: ("text" | "image")[];
  toolResult: "text"[];
}

export type ToolFilterMode = { include: string[] } | { exclude: string[] };

export interface ToolFilter {
  toolCall?: ToolFilterMode;
  toolResult?: ToolFilterMode;
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

/** Observation scopes for controlling how observations are consolidated. */
export type ObservationScopes = "per_tag" | "combined" | "all_combinations" | string[][] | null;

/** Placeholder patterns supported in observation_scopes arrays. */
const SCOPE_PLACEHOLDERS: Record<string, string> = {
  "{session}": "session",
  "{parent}": "parent",
  "{cwd}": "cwd",
  "{basedir}": "basedir",
  "{project}": "project",
};

/** Tag match strategy for recall filtering. Derived from Hindsight SDK's RecallRequest. */
export type TagsMatch = NonNullable<
  Required<import("@vectorize-io/hindsight-client").RecallRequest>["tags_match"]
>;

/** Compound tag group types from Hindsight SDK for recursive boolean tag expressions. */
export type {
  TagGroupAndInput,
  TagGroupLeaf,
  TagGroupNotInput,
  TagGroupOrInput,
} from "@vectorize-io/hindsight-client";

/** Union of all tag group input types. */
export type TagGroupInput = TagGroupLeaf | TagGroupAndInput | TagGroupOrInput | TagGroupNotInput;

/** Role used when injecting auto-recall messages into the LLM context. */
export type AutoRecallRole = "user" | "assistant";

export type ToolName = "retain" | "recall" | "reflect" | "set_extra_context" | "get_extra_context";

const VALID_TOOL_NAMES: ToolName[] = [
  "retain",
  "recall",
  "reflect",
  "set_extra_context",
  "get_extra_context",
];

export interface HindsightConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  bankId: string;
  toolsEnabled: ToolName[] | boolean;
  autoRecallEnabled: boolean;
  autoRecallBudget: Budget;
  autoRetainEnabled: boolean;
  hindsightContextPrefix: string;
  hindsightContextMaxLength: number;
  maxRecallTokens: number | null;
  recallPromptPreamble: string;
  autoRecallShowDateTime: boolean;
  autoRecallDisplay: boolean;
  autoRecallPersist: boolean;
  autoRecallRole: AutoRecallRole;
  recallMaxQueryChars: number;
  autoRecallTypes: MemoryType[] | null;
  autoRecallTags: string[] | null;
  autoRecallTagsMatch: TagsMatch;
  autoRecallTagGroups: TagGroupInput[] | null;
  constantTags: string[];
  retainContent: RetainContent;
  strip: StripConfig;
  toolFilter: ToolFilter;
  retainSessionsByDefault: boolean;
  /** When true, auto-flush events are blocked (warn instead) until extra context is set via /hindsight set-extra-context or the hindsight_set_extra_context tool. Default: false. */
  requireExtraContextBeforeFlush: boolean;
  /** When true, enable debug logging: active tool visibility checks, parse timing, etc. Default: false. */
  debug: boolean;
  entities: EntityInput[];
  observationScopes: ObservationScopes;
  statusHealthy: string;
  statusUnhealthy: string;
  /** Auto-flush the current session when these lifecycle events occur. */
  autoFlushSessionOn: Array<"switch" | "fork" | "reload" | "compact" | "quit" | "tree">;
  /** Auto-flush pending work beyond the current active session when these events occur. Currently supports "quit" and "startup". */
  autoFlushPendingOn: Array<"quit" | "startup">;
}

const VALID_MEMORY_TYPES = ["world", "experience", "observation"] as const;
const VALID_AUTO_FLUSH_SESSION_EVENTS = [
  "switch",
  "fork",
  "reload",
  "compact",
  "quit",
  "tree",
] as const;
const VALID_AUTO_FLUSH_PENDING_EVENTS = ["quit", "startup"] as const;

type AutoFlushSessionEvent = (typeof VALID_AUTO_FLUSH_SESSION_EVENTS)[number];
type AutoFlushPendingEvent = (typeof VALID_AUTO_FLUSH_PENDING_EVENTS)[number];

const DEFAULT_CONFIG: HindsightConfig = {
  enabled: true,
  apiUrl: "",
  apiKey: "",
  bankId: "",
  toolsEnabled: true,
  autoRecallEnabled: true,
  autoRecallBudget: "mid",
  autoRetainEnabled: true,
  hindsightContextPrefix: "pi: ",
  hindsightContextMaxLength: 100,
  maxRecallTokens: null,
  recallPromptPreamble:
    "[System note: The following is recalled memory context, NOT new user or assistant input. Prioritize recent when conflicting. Only use memories that are directly useful to continue this conversation; ignore the rest]",
  autoRecallShowDateTime: true,
  autoRecallDisplay: false,
  autoRecallPersist: false,
  autoRecallRole: "user",
  recallMaxQueryChars: 800,
  autoRecallTypes: ["observation"],
  autoRecallTags: null,
  autoRecallTagsMatch: "any",
  autoRecallTagGroups: null,
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
  toolFilter: {
    toolCall: { exclude: ["grep", "find", "ls", "read", "hindsight_retain"] },
    toolResult: {
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
    },
  },
  autoFlushSessionOn: ["switch", "fork", "reload"],
  autoFlushPendingOn: ["quit"],
  retainSessionsByDefault: true,
  requireExtraContextBeforeFlush: false,
  entities: [],
  observationScopes: null,
  statusHealthy: "🧠",
  statusUnhealthy: "🤯",
  debug: false,
};

// Config keys that can be set via env vars or config file
const VALID_CONFIG_KEYS = new Set<keyof HindsightConfig>([
  "enabled",
  "apiUrl",
  "apiKey",
  "bankId",
  "toolsEnabled",
  "autoRecallEnabled",
  "autoRecallBudget",
  "autoRetainEnabled",
  "hindsightContextPrefix",
  "hindsightContextMaxLength",
  "maxRecallTokens",
  "recallPromptPreamble",
  "autoRecallShowDateTime",
  "autoRecallDisplay",
  "autoRecallPersist",
  "autoRecallRole",
  "recallMaxQueryChars",
  "autoRecallTypes",
  "autoRecallTags",
  "autoRecallTagsMatch",
  "autoRecallTagGroups",
  "constantTags",
  "retainContent",
  "strip",
  "toolFilter",
  "retainSessionsByDefault",
  "requireExtraContextBeforeFlush",
  "debug",
  "entities",
  "observationScopes",
  "statusHealthy",
  "statusUnhealthy",
  "autoFlushSessionOn",
  "autoFlushPendingOn",
]);

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean
): { value: boolean; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  const lower = value.toLowerCase();
  if (lower === "true") return { value: true };
  if (lower === "false") return { value: false };
  return {
    value: defaultValue,
    warning: `Invalid boolean value "${value}", expected "true" or "false". Using default: ${defaultValue}`,
  };
}

/**
 * Validate a tag_groups array value (recursive structure).
 * Returns true if valid, undefined if invalid.
 */
function validateTagGroups(value: unknown[]): true | undefined {
  for (const item of value) {
    if (!validateTagGroupItem(item)) return undefined;
  }
  return true;
}

/**
 * Validate a single tag group item (leaf, and, or, not).
 * Returns true if valid, false if invalid.
 */
function validateTagGroupItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  if ("tags" in obj) {
    // TagGroupLeaf: { tags: string[], match?: TagsMatch }
    if (
      !Array.isArray(obj.tags) ||
      obj.tags.length === 0 ||
      !obj.tags.every((t: unknown) => typeof t === "string")
    )
      return false;
    if ("match" in obj) {
      const validMatches: TagsMatch[] = ["any", "all", "any_strict", "all_strict"];
      if (!validMatches.includes(obj.match as TagsMatch)) return false;
    }
    // Should only have tags/match keys
    const allowedKeys = new Set(["tags", "match"]);
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) return false;
    }
    return true;
  }
  if ("and" in obj) {
    // TagGroupAnd: { and: TagGroupInput[] }
    // Only 'and' key allowed (no mixing compound types)
    if (Object.keys(obj).length !== 1) return false;
    if (!Array.isArray(obj.and) || obj.and.length === 0) return false;
    return (obj.and as unknown[]).every((child: unknown) => validateTagGroupItem(child));
  }
  if ("or" in obj) {
    // TagGroupOr: { or: TagGroupInput[] }
    // Only 'or' key allowed (no mixing compound types)
    if (Object.keys(obj).length !== 1) return false;
    if (!Array.isArray(obj.or) || obj.or.length === 0) return false;
    return (obj.or as unknown[]).every((child: unknown) => validateTagGroupItem(child));
  }
  if ("not" in obj) {
    // TagGroupNot: { not: TagGroupInput }
    // Only 'not' key allowed (no mixing compound types)
    if (Object.keys(obj).length !== 1) return false;
    return validateTagGroupItem(obj.not);
  }
  return false;
}

function parseEventList<T extends string>(
  value: unknown,
  defaultValue: readonly T[],
  validEvents: readonly T[],
  fieldName: string
): { value: T[]; warning?: string } {
  if (Array.isArray(value)) {
    const invalid = value.filter(
      (item) => typeof item !== "string" || !validEvents.includes(item as T)
    );
    if (invalid.length > 0) {
      return {
        value: [...defaultValue],
        warning: `${fieldName} contains invalid values: ${invalid.map((v) => JSON.stringify(v)).join(", ")}. Valid: ${validEvents.join(", ")}. Using default.`,
      };
    }
    return { value: [...new Set(value)] as T[] };
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return {
          value: [...defaultValue],
          warning: `${fieldName} must be a JSON array. Using default.`,
        };
      }
      const invalid = parsed.filter(
        (item: unknown) => typeof item !== "string" || !validEvents.includes(item as T)
      );
      if (invalid.length > 0) {
        return {
          value: [...defaultValue],
          warning: `${fieldName} contains invalid values: ${invalid.map((v: unknown) => JSON.stringify(v)).join(", ")}. Valid: ${validEvents.join(", ")}. Using default.`,
        };
      }
      return { value: [...new Set(parsed)] as T[] };
    } catch {
      return {
        value: [...defaultValue],
        warning: `${fieldName} contains invalid JSON. Using default.`,
      };
    }
  }
  return {
    value: [...defaultValue],
    warning: `${fieldName} must be an array. Using default.`,
  };
}

function parseBudget(
  value: string | undefined,
  defaultValue: Budget
): { value: Budget; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  const valid: Budget[] = ["low", "mid", "high"];
  const lower = value.toLowerCase();
  if (valid.includes(lower as Budget)) return { value: lower as Budget };
  return {
    value: defaultValue,
    warning: `Invalid budget "${value}", expected "low", "mid", or "high". Using default: ${defaultValue}`,
  };
}

function parseNumber(
  value: string | undefined,
  defaultValue: number | null,
  fieldName: string
): { value: number | null; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  const num = parseInt(value, 10);
  if (!Number.isNaN(num)) return { value: num };
  const defaultDesc = defaultValue === null ? "null" : defaultValue;
  return {
    value: defaultValue,
    warning: `Invalid number for ${fieldName}: "${value}". Using default: ${defaultDesc}`,
  };
}

/**
 * Set a config key value, handling the union type assignment.
 * Avoids per-call biome-ignore comments for cross-type assignment.
 */
function setConfigKey(config: HindsightConfig, key: keyof HindsightConfig, value: unknown): void {
  // biome-ignore lint/suspicious/noExplicitAny: config key assignment requires any due to union type
  (config as any)[key] = value;
}

/**
 * Set an object-type config field from a raw value (config file or env var string).
 * The value is applied raw (parsed first if it's a JSON string) so validateConfig
 * can fail closed on any structural malformation — this function does not reset
 * to a default and returns no warning. Used by retainContent, strip, and
 * toolFilter which all accept JSON objects.
 *
 * @param config - The config object to mutate
 * @param key - The config key to set
 * @param value - The raw value (object from config file, or JSON string from env var)
 */
function setObjectField(
  config: HindsightConfig,
  key: keyof HindsightConfig,
  value: unknown
): string | undefined {
  // Direct object from config file — apply raw. validateConfig fails closed
  // on structural malformation (the single authority for these fields).
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    setConfigKey(config, key, value);
    return;
  }
  // String value from env var - parse as JSON and apply the parsed value
  // raw (even if it's not an object). validateConfig fails closed on
  // non-object structures, so no silent reset here. An unparseable string is
  // also applied raw so validateConfig catches it ("got string").
  if (typeof value === "string") {
    try {
      setConfigKey(config, key, JSON.parse(value));
      return;
    } catch {
      setConfigKey(config, key, value);
      return;
    }
  }
  // null might be intentional (e.g., unsetting config), don't warn
  if (value === null) {
    return;
  }
  // Non-object non-string value (e.g. array or number from a config file) —
  // apply raw so validateConfig can fail closed with a specific message.
  setConfigKey(config, key, value);
  return;
}

/**
 * Validate an entities array value.
 * Each entry must be an object with a string 'text' property.
 */
function validateEntities(items: unknown[]): boolean {
  return items.every(
    (e) =>
      typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).text === "string"
  );
}

function parseMemoryTypes(
  value: string | undefined,
  defaultValue: MemoryType[] | null
): { value: MemoryType[] | null; warning?: string } {
  if (value === undefined) return { value: defaultValue };
  try {
    const parsed = JSON.parse(value);
    if (parsed === null) return { value: null }; // JSON null ("null" string or actual null)
    if (!Array.isArray(parsed)) {
      return {
        value: defaultValue,
        warning: `autoRecallTypes must be a JSON array, got ${typeof parsed}. Using default.`,
      };
    }
    if (parsed.length === 0) return { value: null }; // Empty array means all types
    // Validate each type
    const valid = parsed.every((t) => VALID_MEMORY_TYPES.includes(t));
    if (!valid) {
      return {
        value: defaultValue,
        warning: `autoRecallTypes contains invalid values. Valid types: ${VALID_MEMORY_TYPES.join(", ")}`,
      };
    }
    return { value: parsed as MemoryType[] };
  } catch {
    return {
      value: defaultValue,
      warning: `autoRecallTypes contains invalid JSON. Using default.`,
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
  value: unknown
): string | undefined {
  switch (key) {
    case "toolsEnabled": {
      // Accept boolean for backward compat (true = all, false = none) or array of tool names
      if (typeof value === "boolean") {
        config[key] = value;
        return;
      }
      if (Array.isArray(value)) {
        const validTools = VALID_TOOL_NAMES;
        const invalid = value.filter(
          (t) => typeof t !== "string" || !validTools.includes(t as ToolName)
        );
        if (invalid.length > 0) {
          config[key] = DEFAULT_CONFIG[key] as ToolName[] | boolean;
          return `toolsEnabled: invalid tool names: ${invalid.join(", ")}. Valid: ${validTools.join(", ")}. Using default.`;
        }
        config[key] = value as ToolName[];
        return;
      }
      // String value from env var
      const strVal = String(value);
      const lower = strVal.toLowerCase();
      if (lower === "true") {
        config[key] = true;
        return;
      }
      if (lower === "false") {
        config[key] = false;
        return;
      }
      // Try parsing as JSON array
      try {
        const parsed = JSON.parse(strVal);
        if (Array.isArray(parsed)) {
          const validTools = VALID_TOOL_NAMES;
          const invalid = parsed.filter(
            (t: unknown) => typeof t !== "string" || !validTools.includes(t as ToolName)
          );
          if (invalid.length > 0) {
            config[key] = DEFAULT_CONFIG[key] as ToolName[] | boolean;
            return `toolsEnabled: invalid tool names: ${invalid.join(", ")}. Valid: ${validTools.join(", ")}. Using default.`;
          }
          config[key] = parsed as ToolName[];
          return;
        }
        config[key] = DEFAULT_CONFIG[key] as ToolName[] | boolean;
        return `toolsEnabled must be a boolean or array of tool names. Using default.`;
      } catch {
        config[key] = DEFAULT_CONFIG[key] as ToolName[] | boolean;
        return `toolsEnabled contains invalid JSON. Using default.`;
      }
    }
    case "enabled":
    case "autoRecallEnabled":
    case "autoRetainEnabled":
    case "autoRecallShowDateTime":
    case "autoRecallDisplay":
    case "autoRecallPersist":
    case "retainSessionsByDefault":
    case "requireExtraContextBeforeFlush":
    case "debug": {
      if (typeof value === "boolean") {
        config[key] = value;
        return;
      }
      const result = parseBoolean(String(value), DEFAULT_CONFIG[key] as boolean);
      config[key] = result.value;
      return result.warning;
    }
    case "autoFlushSessionOn": {
      const parsed = parseEventList<AutoFlushSessionEvent>(
        value,
        DEFAULT_CONFIG[key],
        VALID_AUTO_FLUSH_SESSION_EVENTS as unknown as readonly AutoFlushSessionEvent[],
        "autoFlushSessionOn"
      );
      config[key] = parsed.value;
      return parsed.warning;
    }
    case "autoFlushPendingOn": {
      const parsed = parseEventList<AutoFlushPendingEvent>(
        value,
        DEFAULT_CONFIG[key],
        VALID_AUTO_FLUSH_PENDING_EVENTS as unknown as readonly AutoFlushPendingEvent[],
        "autoFlushPendingOn"
      );
      config[key] = parsed.value;
      return parsed.warning;
    }
    case "autoRecallBudget": {
      if (typeof value === "string") {
        const result = parseBudget(value, DEFAULT_CONFIG[key] as Budget);
        config[key] = result.value;
        return result.warning;
      }
      const result = parseBudget(String(value), DEFAULT_CONFIG[key] as Budget);
      config[key] = result.value;
      return (
        result.warning ?? `autoRecallBudget must be a string, got ${typeof value}. Using default.`
      );
    }
    case "hindsightContextMaxLength":
    case "recallMaxQueryChars": {
      if (typeof value === "number" && Number.isFinite(value)) {
        config[key] = value;
        return;
      }
      const result = parseNumber(String(value), DEFAULT_CONFIG[key] as number, key);
      config[key] = result.value ?? (DEFAULT_CONFIG[key] as number);
      return result.warning;
    }
    case "maxRecallTokens": {
      if (typeof value === "number" && Number.isFinite(value)) {
        config[key] = value;
        return;
      }
      const result = parseNumber(String(value), DEFAULT_CONFIG[key] as number | null, key);
      config[key] = result.value;
      return result.warning;
    }
    case "autoRecallRole": {
      const validRoles: AutoRecallRole[] = ["user", "assistant"];
      if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (validRoles.includes(lower as AutoRecallRole)) {
          config[key] = lower as AutoRecallRole;
          return;
        }
      }
      config[key] = DEFAULT_CONFIG[key] as AutoRecallRole;
      return `Invalid autoRecallRole "${value}", expected "user" or "assistant". Using default: ${DEFAULT_CONFIG[key]}.`;
    }
    case "autoRecallTypes":
      if (value === null || (Array.isArray(value) && value.length === 0)) {
        config[key] = null;
        return;
      }
      if (Array.isArray(value)) {
        // Validate each type
        const valid = value.every((t) => VALID_MEMORY_TYPES.includes(t));
        if (!valid) {
          config[key] = DEFAULT_CONFIG[key];
          return `autoRecallTypes contains invalid values. Valid types: ${VALID_MEMORY_TYPES.join(", ")}`;
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
    case "autoRecallTags": {
      if (value === null || value === undefined || value === "") {
        config[key] = null;
        return;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) {
          config[key] = null;
          return;
        }
        if (value.every((item) => typeof item === "string")) {
          config[key] = value;
          return;
        }
        config[key] = DEFAULT_CONFIG[key];
        return "autoRecallTags must be a JSON array of strings. Using default.";
      }
      // String value from env var - parse as JSON
      {
        const strVal = String(value);
        try {
          const parsed = JSON.parse(strVal);
          if (parsed === null) {
            config[key] = null;
            return;
          }
          if (!Array.isArray(parsed)) {
            config[key] = DEFAULT_CONFIG[key];
            return `autoRecallTags must be a JSON array, got ${typeof parsed}. Using default.`;
          }
          if (parsed.length === 0) {
            config[key] = null;
            return;
          }
          if (parsed.every((item: unknown) => typeof item === "string")) {
            config[key] = parsed;
            return;
          }
          config[key] = DEFAULT_CONFIG[key];
          return "autoRecallTags must be a JSON array of strings. Using default.";
        } catch {
          config[key] = DEFAULT_CONFIG[key];
          return "autoRecallTags contains invalid JSON. Using default.";
        }
      }
    }
    case "autoRecallTagsMatch": {
      const validMatches: TagsMatch[] = ["any", "all", "any_strict", "all_strict"];
      if (typeof value === "string" && validMatches.includes(value as TagsMatch)) {
        config[key] = value as TagsMatch;
        return;
      }
      // Try stringifying (for non-string values from config file)
      const strValue = String(value);
      if (validMatches.includes(strValue as TagsMatch)) {
        config[key] = strValue as TagsMatch;
        return;
      }
      config[key] = DEFAULT_CONFIG[key] as TagsMatch;
      return `Invalid autoRecallTagsMatch "${strValue}", expected one of: ${validMatches.join(", ")}. Using default.`;
    }
    case "autoRecallTagGroups": {
      if (value === null || value === undefined || value === "") {
        config[key] = null;
        return;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) {
          config[key] = null;
          return;
        }
        const validation = validateTagGroups(value);
        if (validation !== undefined) {
          config[key] = value as TagGroupInput[];
          return;
        }
        config[key] = DEFAULT_CONFIG[key] as TagGroupInput[] | null;
        return "autoRecallTagGroups must be an array of tag group objects. Using default.";
      }
      // String value from env var - parse as JSON
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          if (parsed === null) {
            config[key] = null;
            return;
          }
          if (!Array.isArray(parsed)) {
            config[key] = DEFAULT_CONFIG[key] as TagGroupInput[] | null;
            return `autoRecallTagGroups must be a JSON array, got ${typeof parsed}. Using default.`;
          }
          if (parsed.length === 0) {
            config[key] = null;
            return;
          }
          const validation = validateTagGroups(parsed);
          if (validation !== undefined) {
            config[key] = parsed as TagGroupInput[];
            return;
          }
          config[key] = DEFAULT_CONFIG[key] as TagGroupInput[] | null;
          return "autoRecallTagGroups must be an array of tag group objects. Using default.";
        } catch {
          config[key] = DEFAULT_CONFIG[key] as TagGroupInput[] | null;
          return "autoRecallTagGroups contains invalid JSON. Using default.";
        }
      }
      // Non-string, non-array, non-null value (e.g. object from config file)
      config[key] = DEFAULT_CONFIG[key] as TagGroupInput[] | null;
      return "autoRecallTagGroups must be an array of tag group objects. Using default.";
    }
    case "constantTags": {
      if (Array.isArray(value)) {
        config[key] = value;
        return;
      }
      // String value from env var - parse JSON and apply raw. validateConfig
      // fails closed on non-array or non-string elements. An unparseable
      // string is also applied raw so validateConfig catches it ("got string").
      try {
        config[key] = JSON.parse(String(value));
        return;
      } catch {
        config[key] = value as string[];
        return;
      }
    }
    case "entities": {
      if (Array.isArray(value)) {
        config[key] = value;
        return;
      }
      // String value from env var - parse JSON and apply raw. validateConfig
      // fails closed on non-array or malformed entries. An unparseable string
      // is applied raw so validateConfig catches it ("got string").
      try {
        config[key] = JSON.parse(String(value));
        return;
      } catch {
        config[key] = value as typeof DEFAULT_CONFIG.entities;
        return;
      }
    }
    case "retainContent":
    case "strip":
    case "toolFilter":
      // Replace entirely (not merge) - user must provide complete object
      return setObjectField(config, key, value);
    case "observationScopes": {
      if (value === null || value === undefined || value === "") {
        config[key] = null;
        return;
      }
      // String preset values are valid as-is. Other strings (e.g. a JSON
      // array from an env var) are parsed so an array value flows through.
      // Non-string values (arrays/objects from a config file) are applied raw.
      // validateConfig fails closed on any structural malformation.
      if (typeof value === "string") {
        const presetValues = ["per_tag", "combined", "all_combinations"];
        if (presetValues.includes(value)) {
          config[key] = value as ObservationScopes;
          return;
        }
        try {
          config[key] = JSON.parse(value) as ObservationScopes;
          return;
        } catch {
          // Unparseable non-preset string: no value to validate. validateConfig
          // will fail closed on the raw string (not a preset, not an array).
          config[key] = value as ObservationScopes;
          return;
        }
      }
      config[key] = value as ObservationScopes;
      return;
    }
    case "apiUrl":
    case "apiKey":
    case "bankId":
    case "recallPromptPreamble":
    case "statusHealthy":
    case "statusUnhealthy":
      config[key] = String(value);
      return;
    case "hindsightContextPrefix":
      // Apply raw (no String() coercion) so validateConfig fails closed on
      // non-string values from a config file. Env vars are already strings.
      config[key] = value as string;
      return;
    default: {
      // This should never happen if VALID_CONFIG_KEYS is correct
      const _exhaustive: never = key;
      throw new Error(`Unexpected config key: ${_exhaustive}`);
    }
  }
}

/**
 * Check if observation_scopes array tags contain placeholder patterns
 * that aren't exact matches. Returns warning messages.
 */
function checkScopePlaceholderWarnings(scopes: string[][]): string[] {
  const warnings: string[] = [];
  const placeholderPatterns = Object.keys(SCOPE_PLACEHOLDERS);
  for (const group of scopes) {
    for (const tag of group) {
      for (const placeholder of placeholderPatterns) {
        if (tag !== placeholder && tag.includes(placeholder)) {
          warnings.push(
            `observationScopes tag "${tag}" contains placeholder ${placeholder} but is not an exact match; placeholders must be used as standalone tags (e.g. ["${placeholder}"] not "${tag}")`
          );
        }
      }
    }
  }
  return warnings;
}

/** Parameters for placeholder expansion. */
export interface PlaceholderParams {
  sessionId: string;
  parentSessionId?: string;
  sessionCwd?: string;
  projectName?: string;
}

/**
 * Expand a single placeholder tag.
 * Returns the expanded tag (e.g. "session:abc-123") or the original tag if it's not a placeholder or can't be resolved.
 */
function expandPlaceholder(tag: string, params: PlaceholderParams): string {
  const prefix = SCOPE_PLACEHOLDERS[tag];
  if (!prefix) return tag;

  if (prefix === "cwd") {
    return params.sessionCwd ? `cwd:${params.sessionCwd}` : tag;
  }
  if (prefix === "basedir") {
    return params.sessionCwd ? `basedir:${basename(params.sessionCwd)}` : tag;
  }
  if (prefix === "project") {
    const name =
      params.projectName || (params.sessionCwd ? basename(params.sessionCwd) : undefined);
    return name ? `project:${name}` : tag;
  }
  const id = prefix === "parent" ? (params.parentSessionId ?? params.sessionId) : params.sessionId;
  return `${prefix}:${id}`;
}

/**
 * Expand placeholder patterns in observation_scopes arrays.
 * E.g. ["{session}"] -> ["session:<sessionId>"], ["{parent}"] -> ["parent:<parentId>"]
 * Only applies to string[][] (custom scope groups), not preset strings like "per_tag".
 * Only exact placeholder matches are expanded (e.g. "{session}" but not "{session}:extra").
 */
export function expandScopePlaceholders(
  scopes: ObservationScopes,
  params: PlaceholderParams
): ObservationScopes {
  if (scopes === null || typeof scopes === "string") return scopes;

  return scopes.map((group) => group.map((tag) => expandPlaceholder(tag, params)));
}

/**
 * Expand observation scope placeholders for a specific session.
 * Returns undefined when observationScopes is null (not configured).
 */
export function expandSessionObservationScopes(
  config: Pick<HindsightConfig, "observationScopes">,
  sessionId: string,
  parentSessionId?: string,
  sessionCwd?: string,
  projectName?: string
): Exclude<ObservationScopes, null> | undefined {
  if (!config.observationScopes) return undefined;
  return expandScopePlaceholders(config.observationScopes, {
    sessionId,
    parentSessionId,
    sessionCwd,
    projectName,
  }) as Exclude<ObservationScopes, null>;
}

/**
 * Expand placeholder patterns in auto-recall tags array.
 * E.g. ["{project}"] -> ["project:myapp"], ["{cwd}"] -> ["cwd:/path/to/dir"]
 * Only exact placeholder matches are expanded.
 * Returns null when tags is null (no recall tag filtering).
 */
export function expandAutoRecallTags(
  tags: string[] | null,
  params: PlaceholderParams
): string[] | null {
  if (!tags) return null;
  return tags.map((tag) => expandPlaceholder(tag, params));
}

/**
 * Recursively validate placeholder usage in tag_groups.
 * Warns on non-exact placeholder matches in any leaf tag array.
 */
function validateTagGroupsPlaceholders(
  groups: TagGroupInput[],
  placeholderPatterns: string[],
  warnings: string[]
): void {
  for (const group of groups) {
    validateTagGroupItemPlaceholders(group, placeholderPatterns, warnings);
  }
}

function validateTagGroupItemPlaceholders(
  item: TagGroupInput,
  placeholderPatterns: string[],
  warnings: string[]
): void {
  if ("tags" in item) {
    // TagGroupLeaf
    for (const tag of item.tags) {
      for (const placeholder of placeholderPatterns) {
        if (tag !== placeholder && tag.includes(placeholder)) {
          warnings.push(
            `autoRecallTagGroups tag "${tag}" contains placeholder ${placeholder} but is not an exact match; placeholders must be used as standalone tags (e.g. "${placeholder}" not "${tag}")`
          );
        }
      }
    }
  } else if ("and" in item) {
    for (const child of item.and) {
      validateTagGroupItemPlaceholders(child, placeholderPatterns, warnings);
    }
  } else if ("or" in item) {
    for (const child of item.or) {
      validateTagGroupItemPlaceholders(child, placeholderPatterns, warnings);
    }
  } else if ("not" in item) {
    validateTagGroupItemPlaceholders(item.not, placeholderPatterns, warnings);
  }
}

/**
 * Expand placeholder patterns in auto-recall tag_groups.
 * E.g. ["{project}"] -> ["project:myapp"] in leaf tag arrays.
 * Only exact placeholder matches are expanded.
 * Returns null when tagGroups is null (no recall tag group filtering).
 */
export function expandAutoRecallTagGroups(
  tagGroups: TagGroupInput[] | null,
  params: PlaceholderParams
): TagGroupInput[] | null {
  if (!tagGroups) return null;
  return tagGroups.map((group) => expandTagGroupItem(group, params));
}

function expandTagGroupItem(item: TagGroupInput, params: PlaceholderParams): TagGroupInput {
  if ("tags" in item) {
    // TagGroupLeaf
    return {
      ...item,
      tags: item.tags.map((tag) => expandPlaceholder(tag, params)),
    };
  }
  if ("and" in item) {
    return { and: item.and.map((child) => expandTagGroupItem(child, params)) };
  }
  if ("or" in item) {
    return { or: item.or.map((child) => expandTagGroupItem(child, params)) };
  }
  if ("not" in item) {
    return { not: expandTagGroupItem(item.not, params) };
  }
  return item;
}

export function loadConfig(extensionsDir?: string): {
  config: HindsightConfig;
  configPath?: string;
  warning?: string;
  envVars: string[];
} {
  // Deep copy to avoid mutating DEFAULT_CONFIG
  // Note: retainContent and strip are replaced entirely (not merged) in setConfigValue
  const config: HindsightConfig = {
    ...DEFAULT_CONFIG,
    retainContent: {
      assistant: [...DEFAULT_CONFIG.retainContent.assistant],
      user: [...DEFAULT_CONFIG.retainContent.user],
      toolResult: [...DEFAULT_CONFIG.retainContent.toolResult],
    },
    strip: {
      topLevel: [...DEFAULT_CONFIG.strip.topLevel],
      message: [...DEFAULT_CONFIG.strip.message],
    },
    toolFilter: {
      ...DEFAULT_CONFIG.toolFilter,
      toolCall: DEFAULT_CONFIG.toolFilter.toolCall
        ? { ...DEFAULT_CONFIG.toolFilter.toolCall }
        : undefined,
      toolResult: DEFAULT_CONFIG.toolFilter.toolResult
        ? { ...DEFAULT_CONFIG.toolFilter.toolResult }
        : undefined,
    },
  };
  const warnings: string[] = [];

  // Load from config file (prefer .jsonc over .json)
  const dir = extensionsDir ?? getDataDir();
  const jsoncPath = join(dir, "config.jsonc");
  const jsonPath = join(dir, "config.json");

  const configPath = existsSync(jsoncPath) ? jsoncPath : existsSync(jsonPath) ? jsonPath : null;

  if (configPath) {
    try {
      const fileContent = readFileSync(configPath, "utf-8");
      const errors: ParseError[] = [];
      const fileConfig = parseJsonc(fileContent, errors, { allowTrailingComma: true });

      if (errors.length > 0) {
        const details = errors
          .map((e) => {
            const { line, character } = offsetToLineColumn(fileContent, e.offset);
            return `line ${line}, character ${character}: ${printParseErrorCode(e.error)}`;
          })
          .join("; ");
        warnings.push(
          `Failed to parse config file ${configPath}: ${errors.length} parse error(s). Using defaults. Details: ${details}`
        );
      } else {
        // Backward compatibility: map old config key names to new names
        const fileEntries = Object.entries(fileConfig as object) as [string, unknown][];
        const fileKeys = new Set(fileEntries.map(([k]) => k));
        // Old "recallShowDateTime" -> new "autoRecallShowDateTime"
        if (fileKeys.has("recallShowDateTime") && !fileKeys.has("autoRecallShowDateTime")) {
          // biome-ignore lint/complexity/useLiteralKeys: we need dynamic key access for the old name
          const oldValue = (fileConfig as Record<string, unknown>)["recallShowDateTime"];
          const warning = setConfigValue(config, "autoRecallShowDateTime", oldValue);
          if (warning) warnings.push(warning);
        }
        // Old "recallTypes" -> new "autoRecallTypes"
        if (fileKeys.has("recallTypes") && !fileKeys.has("autoRecallTypes")) {
          // biome-ignore lint/complexity/useLiteralKeys: we need dynamic key access for the old name
          const oldValue = (fileConfig as Record<string, unknown>)["recallTypes"];
          const warning = setConfigValue(config, "autoRecallTypes", oldValue);
          if (warning) warnings.push(warning);
        }
        for (const [key, value] of fileEntries) {
          if (!VALID_CONFIG_KEYS.has(key as keyof HindsightConfig)) {
            if (key !== "recallShowDateTime" && key !== "recallTypes") {
              warnings.push(`Unknown config key in file: ${key} (value: ${JSON.stringify(value)})`);
            }
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

  // Override with environment variables.
  //
  // Precedence per config key: (1) new `EPIMETHEUS_*` env var if set,
  // (2) old `PI_HINDSIGHT_*` fallback if the new var is not set,
  // (3) config file / defaults (already loaded into `config` above).
  //
  // `HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY` are the official Hindsight service
  // vars and are intentionally NOT renamed — they have a single env var and no
  // `PI_HINDSIGHT_*` fallback alias. Every other (plugin-specific) var has a
  // new `EPIMETHEUS_*` preferred name plus one or more legacy `PI_HINDSIGHT_*`
  // fallback names. `envVars` records whichever env var was actually used.
  const envMappings: {
    configKey: keyof HindsightConfig;
    preferred: string;
    legacy?: string[];
  }[] = [
    { configKey: "enabled", preferred: "EPIMETHEUS_ENABLED", legacy: ["PI_HINDSIGHT_ENABLED"] },
    // Official Hindsight service vars — single name, no rename, no fallback.
    { configKey: "apiUrl", preferred: "HINDSIGHT_API_URL" },
    { configKey: "apiKey", preferred: "HINDSIGHT_API_KEY" },
    { configKey: "bankId", preferred: "EPIMETHEUS_BANK_ID", legacy: ["PI_HINDSIGHT_BANK_ID"] },
    {
      configKey: "toolsEnabled",
      preferred: "EPIMETHEUS_TOOLS_ENABLED",
      legacy: ["PI_HINDSIGHT_TOOLS_ENABLED"],
    },
    {
      configKey: "autoRecallEnabled",
      preferred: "EPIMETHEUS_AUTO_RECALL_ENABLED",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_ENABLED"],
    },
    {
      configKey: "autoRecallBudget",
      preferred: "EPIMETHEUS_AUTO_RECALL_BUDGET",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_BUDGET"],
    },
    {
      configKey: "autoRetainEnabled",
      preferred: "EPIMETHEUS_AUTO_RETAIN_ENABLED",
      legacy: ["PI_HINDSIGHT_AUTO_RETAIN_ENABLED"],
    },
    {
      configKey: "hindsightContextPrefix",
      preferred: "EPIMETHEUS_CONTEXT_PREFIX",
      legacy: ["PI_HINDSIGHT_CONTEXT_PREFIX"],
    },
    {
      configKey: "hindsightContextMaxLength",
      preferred: "EPIMETHEUS_CONTEXT_MAX_LENGTH",
      legacy: ["PI_HINDSIGHT_CONTEXT_MAX_LENGTH"],
    },
    {
      configKey: "maxRecallTokens",
      preferred: "EPIMETHEUS_MAX_RECALL_TOKENS",
      legacy: ["PI_HINDSIGHT_MAX_RECALL_TOKENS"],
    },
    {
      configKey: "recallPromptPreamble",
      preferred: "EPIMETHEUS_RECALL_PROMPT_PREAMBLE",
      legacy: ["PI_HINDSIGHT_RECALL_PROMPT_PREAMBLE"],
    },
    {
      configKey: "autoRecallShowDateTime",
      preferred: "EPIMETHEUS_AUTO_RECALL_SHOW_DATETIME",
      // Two legacy fallbacks: the renamed `AUTO_RECALL_*` form, then the older
      // bare `RECALL_*` form (kept for pre-rename users).
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_SHOW_DATETIME", "PI_HINDSIGHT_RECALL_SHOW_DATETIME"],
    },
    {
      configKey: "autoRecallDisplay",
      preferred: "EPIMETHEUS_AUTO_RECALL_DISPLAY",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_DISPLAY"],
    },
    {
      configKey: "autoRecallPersist",
      preferred: "EPIMETHEUS_AUTO_RECALL_PERSIST",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_PERSIST"],
    },
    {
      configKey: "autoRecallRole",
      preferred: "EPIMETHEUS_AUTO_RECALL_ROLE",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_ROLE"],
    },
    {
      configKey: "recallMaxQueryChars",
      preferred: "EPIMETHEUS_RECALL_MAX_QUERY_CHARS",
      legacy: ["PI_HINDSIGHT_RECALL_MAX_QUERY_CHARS"],
    },
    {
      configKey: "autoRecallTypes",
      preferred: "EPIMETHEUS_AUTO_RECALL_TYPES",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_TYPES", "PI_HINDSIGHT_RECALL_TYPES"],
    },
    {
      configKey: "autoRecallTags",
      preferred: "EPIMETHEUS_AUTO_RECALL_TAGS",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_TAGS"],
    },
    {
      configKey: "autoRecallTagsMatch",
      preferred: "EPIMETHEUS_AUTO_RECALL_TAGS_MATCH",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_TAGS_MATCH"],
    },
    {
      configKey: "autoRecallTagGroups",
      preferred: "EPIMETHEUS_AUTO_RECALL_TAG_GROUPS",
      legacy: ["PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS"],
    },
    {
      configKey: "constantTags",
      preferred: "EPIMETHEUS_CONSTANT_TAGS",
      legacy: ["PI_HINDSIGHT_CONSTANT_TAGS"],
    },
    {
      configKey: "retainSessionsByDefault",
      preferred: "EPIMETHEUS_RETAIN_SESSIONS_BY_DEFAULT",
      legacy: ["PI_HINDSIGHT_RETAIN_SESSIONS_BY_DEFAULT"],
    },
    {
      configKey: "requireExtraContextBeforeFlush",
      preferred: "EPIMETHEUS_REQUIRE_EXTRA_CONTEXT_BEFORE_FLUSH",
      legacy: ["PI_HINDSIGHT_REQUIRE_EXTRA_CONTEXT_BEFORE_FLUSH"],
    },
    {
      configKey: "retainContent",
      preferred: "EPIMETHEUS_RETAIN_CONTENT",
      legacy: ["PI_HINDSIGHT_RETAIN_CONTENT"],
    },
    { configKey: "strip", preferred: "EPIMETHEUS_STRIP", legacy: ["PI_HINDSIGHT_STRIP"] },
    {
      configKey: "toolFilter",
      preferred: "EPIMETHEUS_TOOL_FILTER",
      legacy: ["PI_HINDSIGHT_TOOL_FILTER"],
    },
    {
      configKey: "entities",
      preferred: "EPIMETHEUS_ENTITIES",
      legacy: ["PI_HINDSIGHT_ENTITIES"],
    },
    {
      configKey: "observationScopes",
      preferred: "EPIMETHEUS_OBSERVATION_SCOPES",
      legacy: ["PI_HINDSIGHT_OBSERVATION_SCOPES"],
    },
    {
      configKey: "statusHealthy",
      preferred: "EPIMETHEUS_STATUS_HEALTHY",
      legacy: ["PI_HINDSIGHT_STATUS_HEALTHY"],
    },
    {
      configKey: "statusUnhealthy",
      preferred: "EPIMETHEUS_STATUS_UNHEALTHY",
      legacy: ["PI_HINDSIGHT_STATUS_UNHEALTHY"],
    },
    {
      configKey: "autoFlushSessionOn",
      preferred: "EPIMETHEUS_AUTO_FLUSH_SESSION_ON",
      legacy: ["PI_HINDSIGHT_AUTO_FLUSH_SESSION_ON"],
    },
    {
      configKey: "autoFlushPendingOn",
      preferred: "EPIMETHEUS_AUTO_FLUSH_PENDING_ON",
      legacy: ["PI_HINDSIGHT_AUTO_FLUSH_PENDING_ON"],
    },
    { configKey: "debug", preferred: "EPIMETHEUS_DEBUG", legacy: ["PI_HINDSIGHT_DEBUG"] },
  ];

  const envVars: string[] = [];
  for (const { configKey, preferred, legacy } of envMappings) {
    // Preferred name first (new EPIMETHEUS_* or the official HINDSIGHT_API_*).
    const preferredValue = process.env[preferred];
    if (preferredValue !== undefined) {
      envVars.push(preferred);
      const warning = setConfigValue(config, configKey, preferredValue);
      if (warning) warnings.push(warning);
      continue;
    }
    // Then each legacy fallback in order; first one set wins.
    if (legacy) {
      for (const legacyVar of legacy) {
        const legacyValue = process.env[legacyVar];
        if (legacyValue !== undefined) {
          envVars.push(legacyVar);
          const warning = setConfigValue(config, configKey, legacyValue);
          if (warning) warnings.push(warning);
          break;
        }
      }
    }
  }

  return {
    config,
    configPath: configPath ?? undefined,
    warning: warnings.length > 0 ? warnings.map(prefixLog).join("; ") : undefined,
    envVars,
  };
}

/**
 * Validate and fix a loaded config. Mutates the config object to reset invalid
 * values to their defaults and returns the validation result.
 *
 * Fail-closed policy: any malformed setting affecting the retention pipeline
 * (apiUrl/apiKey/bankId, retainContent, strip, toolFilter, constantTags,
 * entities, hindsightContextPrefix, hindsightContextMaxLength,
 * observationScopes) produces an error — the extension enters degraded mode
 * and all retention is blocked until the config is fixed. Duplicate values
 * and other non-malformation issues produce warnings.
 */
export function validateConfig(config: HindsightConfig): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.apiUrl) {
    errors.push("apiUrl is required (set in config.json or HINDSIGHT_API_URL env var)");
  }

  if (!config.apiKey) {
    errors.push("apiKey is required (set in config.json or HINDSIGHT_API_KEY env var)");
  }

  if (!config.bankId) {
    errors.push("bankId is required (set in config.json or EPIMETHEUS_BANK_ID env var)");
  }

  // Validate toolsEnabled - reset to default on invalid values, deduplicate on duplicates
  if (Array.isArray(config.toolsEnabled)) {
    const validTools = VALID_TOOL_NAMES;
    const invalid = config.toolsEnabled.filter((t) => !validTools.includes(t));
    if (invalid.length > 0) {
      config.toolsEnabled = DEFAULT_CONFIG.toolsEnabled as ToolName[] | boolean;
      warnings.push(
        `toolsEnabled contains invalid values: ${invalid.join(", ")}. Valid: ${validTools.join(", ")}. Using default: ${JSON.stringify(DEFAULT_CONFIG.toolsEnabled)}.`
      );
    } else {
      // Only check duplicates if we didn't reset (array is still valid)
      const unique = new Set(config.toolsEnabled);
      if (unique.size !== config.toolsEnabled.length) {
        config.toolsEnabled = [...unique] as ToolName[];
        warnings.push("toolsEnabled contains duplicate values. Using deduplicated value.");
      }
    }
  }

  // Validate hindsightContextPrefix - fail closed on non-string values.
  // (setConfigValue no longer String()-coerces, so a non-string from a config
  // file reaches this check.) The length-overflow info warning below stays.
  if (typeof config.hindsightContextPrefix !== "string") {
    errors.push(
      `hindsightContextPrefix must be a string, got ${typeof config.hindsightContextPrefix}. Using default: "${DEFAULT_CONFIG.hindsightContextPrefix}".`
    );
    config.hindsightContextPrefix = DEFAULT_CONFIG.hindsightContextPrefix;
  }
  // Validate hindsightContextMaxLength - fail closed on malformed values
  // (non-number, NaN, or negative). Reset to default so the in-memory value is
  // never the malformed one.
  if (
    typeof config.hindsightContextMaxLength !== "number" ||
    Number.isNaN(config.hindsightContextMaxLength) ||
    config.hindsightContextMaxLength < 0
  ) {
    errors.push(
      `hindsightContextMaxLength must be a non-negative number. Using default: ${DEFAULT_CONFIG.hindsightContextMaxLength}.`
    );
    config.hindsightContextMaxLength = DEFAULT_CONFIG.hindsightContextMaxLength;
  }
  if (config.hindsightContextPrefix.length > config.hindsightContextMaxLength) {
    warnings.push(
      `hindsightContextPrefix ("${config.hindsightContextPrefix}", ${config.hindsightContextPrefix.length} chars) is longer than hindsightContextMaxLength (${config.hindsightContextMaxLength}). Auto-derived session names will not be truncated. Consider increasing hindsightContextMaxLength.`
    );
  }

  // Validate recallMaxQueryChars - reset to default if out of range
  if (config.recallMaxQueryChars < 1) {
    warnings.push(
      `recallMaxQueryChars must be >= 1. Using default: ${DEFAULT_CONFIG.recallMaxQueryChars}.`
    );
    config.recallMaxQueryChars = DEFAULT_CONFIG.recallMaxQueryChars;
  }

  // Valid content types per retainContent role
  const VALID_RETAIN_CONTENT: Record<string, string[]> = {
    user: ["text", "image"],
    assistant: ["text", "thinking", "toolCall"],
    toolResult: ["text"],
  };

  // Validate retainContent - ensure all sub-properties exist and are valid
  // arrays of allowed types. Structural malformation fails closed; duplicates
  // are deduplicated and warned (redundant, not malformed).
  if (
    typeof config.retainContent !== "object" ||
    config.retainContent === null ||
    Array.isArray(config.retainContent)
  ) {
    errors.push(
      `retainContent must be an object. Using default: ${JSON.stringify(DEFAULT_CONFIG.retainContent)}.`
    );
    config.retainContent = {
      user: [...DEFAULT_CONFIG.retainContent.user],
      assistant: [...DEFAULT_CONFIG.retainContent.assistant],
      toolResult: [...DEFAULT_CONFIG.retainContent.toolResult],
    };
  } else {
    for (const role of ["user", "assistant", "toolResult"] as const) {
      const items = config.retainContent[role];
      if (!items || !Array.isArray(items)) {
        errors.push(
          `retainContent.${role} is missing or not an array. Using default: ${JSON.stringify(DEFAULT_CONFIG.retainContent[role])}.`
        );
        // biome-ignore lint/suspicious/noExplicitAny: retainContent role assignment requires any due to union tuple types
        config.retainContent[role] = [...DEFAULT_CONFIG.retainContent[role]] as any;
      } else if (items.length === 0 && (role === "user" || role === "assistant")) {
        errors.push(
          `retainContent.${role} cannot be empty. Using default: ${JSON.stringify(DEFAULT_CONFIG.retainContent[role])}.`
        );
        // biome-ignore lint/suspicious/noExplicitAny: retainContent role assignment requires any due to union tuple types
        config.retainContent[role] = [...DEFAULT_CONFIG.retainContent[role]] as any;
      } else {
        const allowed = VALID_RETAIN_CONTENT[role] as string[];
        const invalid = items.filter((item) => typeof item !== "string" || !allowed.includes(item));
        if (invalid.length > 0) {
          errors.push(
            `retainContent.${role} contains invalid values: ${invalid.map((v) => JSON.stringify(v)).join(", ")}. Valid: ${allowed.join(", ")}. Using default: ${JSON.stringify(DEFAULT_CONFIG.retainContent[role])}.`
          );
          // biome-ignore lint/suspicious/noExplicitAny: retainContent role assignment requires any due to union tuple types
          config.retainContent[role] = [...DEFAULT_CONFIG.retainContent[role]] as any;
        } else {
          // Duplicates are redundant but valid — warn + dedupe.
          const unique = new Set(items);
          if (unique.size !== items.length) {
            // biome-ignore lint/suspicious/noExplicitAny: Set dedup requires any cast due to union tuple types
            config.retainContent[role] = [...unique] as any;
            warnings.push(
              `retainContent.${role} contains duplicate values. Using deduplicated value.`
            );
          }
        }
      }
    }
  }

  // Validate strip - ensure all sub-properties exist and are valid string
  // arrays. Structural malformation fails closed; duplicates are warned.
  if (typeof config.strip !== "object" || config.strip === null || Array.isArray(config.strip)) {
    errors.push(`strip must be an object. Using default: ${JSON.stringify(DEFAULT_CONFIG.strip)}.`);
    config.strip = {
      topLevel: [...DEFAULT_CONFIG.strip.topLevel],
      message: [...DEFAULT_CONFIG.strip.message],
    };
  } else {
    for (const field of ["topLevel", "message"] as const) {
      const items = config.strip[field];
      if (!items || !Array.isArray(items)) {
        errors.push(
          `strip.${field} is missing or not an array. Using default: ${JSON.stringify(DEFAULT_CONFIG.strip[field])}.`
        );
        config.strip[field] = [...DEFAULT_CONFIG.strip[field]];
      } else {
        const invalid = items.filter((item) => typeof item !== "string");
        if (invalid.length > 0) {
          errors.push(
            `strip.${field} contains non-string values. Using default: ${JSON.stringify(DEFAULT_CONFIG.strip[field])}.`
          );
          config.strip[field] = [...DEFAULT_CONFIG.strip[field]];
        } else {
          const unique = new Set(items);
          if (unique.size !== items.length) {
            config.strip[field] = [...unique] as typeof items;
            warnings.push(`strip.${field} contains duplicate values. Using deduplicated value.`);
          }
        }
      }
    }
  }

  // Validate toolFilter - fail closed on any structural issue.
  if (
    typeof config.toolFilter !== "object" ||
    config.toolFilter === null ||
    Array.isArray(config.toolFilter)
  ) {
    errors.push(
      `toolFilter must be an object. Using default: ${JSON.stringify(DEFAULT_CONFIG.toolFilter)}.`
    );
    config.toolFilter = {
      ...DEFAULT_CONFIG.toolFilter,
      toolCall: DEFAULT_CONFIG.toolFilter.toolCall
        ? { ...DEFAULT_CONFIG.toolFilter.toolCall }
        : undefined,
      toolResult: DEFAULT_CONFIG.toolFilter.toolResult
        ? { ...DEFAULT_CONFIG.toolFilter.toolResult }
        : undefined,
    };
  } else {
    for (const subKey of ["toolCall", "toolResult"] as const) {
      const filter = config.toolFilter[subKey];
      // null or non-object sub-filters are invalid — reset to default
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
        if (filter !== undefined) {
          const defaultFilter = DEFAULT_CONFIG.toolFilter[subKey];
          if (defaultFilter) {
            config.toolFilter[subKey] = structuredClone(defaultFilter);
          } else {
            delete config.toolFilter[subKey];
          }
          errors.push(
            `toolFilter.${subKey} must be an object. Using default: ${JSON.stringify(defaultFilter)}.`
          );
        }
        continue;
      }

      const reasons: string[] = [];
      const hasInclude = "include" in filter;
      const hasExclude = "exclude" in filter;

      // Must have at least one of include/exclude
      if (!hasInclude && !hasExclude) {
        reasons.push(`toolFilter.${subKey} must have either 'include' or 'exclude'`);
      }

      if (hasInclude && hasExclude) {
        reasons.push(`toolFilter.${subKey} cannot have both 'include' and 'exclude'`);
      }

      // Check for empty or non-array include/exclude, or non-string elements
      if (hasInclude) {
        if (!Array.isArray(filter.include)) {
          reasons.push(`toolFilter.${subKey}.include must be a string array`);
        } else if (filter.include.length === 0) {
          reasons.push(`toolFilter.${subKey}.include cannot be empty`);
        } else if (!filter.include.every((v) => typeof v === "string")) {
          reasons.push(`toolFilter.${subKey}.include must contain only strings`);
        }
      }
      if (hasExclude) {
        if (!Array.isArray(filter.exclude)) {
          reasons.push(`toolFilter.${subKey}.exclude must be a string array`);
        } else if (filter.exclude.length === 0) {
          reasons.push(`toolFilter.${subKey}.exclude cannot be empty`);
        } else if (!filter.exclude.every((v) => typeof v === "string")) {
          reasons.push(`toolFilter.${subKey}.exclude must contain only strings`);
        }
      }

      // Check for unknown keys
      const allowedKeys = new Set(["include", "exclude"]);
      for (const key of Object.keys(filter)) {
        if (!allowedKeys.has(key)) {
          reasons.push(`toolFilter.${subKey} has unknown key '${key}'`);
        }
      }

      if (reasons.length > 0) {
        const defaultFilter = DEFAULT_CONFIG.toolFilter[subKey];
        if (defaultFilter) {
          config.toolFilter[subKey] = structuredClone(defaultFilter);
        } else {
          delete config.toolFilter[subKey];
        }
        for (const reason of reasons) {
          errors.push(`${reason}. Using default: ${JSON.stringify(defaultFilter)}.`);
        }
      }
    }
  }

  // Validate constantTags - fail closed on non-array or non-string elements.
  // Duplicates are deduplicated and warned (redundant, not malformed).
  if (!Array.isArray(config.constantTags)) {
    errors.push(
      `constantTags must be a string array, got ${typeof config.constantTags}. Using default: ${JSON.stringify(DEFAULT_CONFIG.constantTags)}.`
    );
    config.constantTags = [...DEFAULT_CONFIG.constantTags];
  } else {
    const invalid = config.constantTags.filter((item) => typeof item !== "string");
    if (invalid.length > 0) {
      errors.push(
        `constantTags must contain only strings. Invalid: ${invalid.map((v) => JSON.stringify(v)).join(", ")}. Using default: ${JSON.stringify(DEFAULT_CONFIG.constantTags)}.`
      );
      config.constantTags = [...DEFAULT_CONFIG.constantTags];
    } else {
      const unique = new Set(config.constantTags);
      if (unique.size !== config.constantTags.length) {
        config.constantTags = [...unique];
        warnings.push("constantTags contains duplicate values. Using deduplicated value.");
      }
    }
  }

  // Validate entities - fail closed on non-array or malformed entries
  // (each entry must be an object with a string 'text' property).
  if (!Array.isArray(config.entities)) {
    errors.push(
      `entities must be an array of objects with a string 'text' property, got ${typeof config.entities}. Using default: ${JSON.stringify(DEFAULT_CONFIG.entities)}.`
    );
    config.entities = [...DEFAULT_CONFIG.entities];
  } else if (!validateEntities(config.entities)) {
    errors.push(
      `entities must be an array of objects with a string 'text' property. Using default: ${JSON.stringify(DEFAULT_CONFIG.entities)}.`
    );
    config.entities = [...DEFAULT_CONFIG.entities];
  }

  // Check for duplicates in autoRecallTypes (null means all types, no validation needed)
  if (config.autoRecallTypes !== null) {
    // Also validate type values
    const invalid = config.autoRecallTypes.filter((t) => !VALID_MEMORY_TYPES.includes(t));
    if (invalid.length > 0) {
      warnings.push(
        `autoRecallTypes contains invalid values: ${invalid.join(", ")}. Valid types: ${VALID_MEMORY_TYPES.join(", ")}. Using default: ${JSON.stringify(DEFAULT_CONFIG.autoRecallTypes)}.`
      );
      config.autoRecallTypes = DEFAULT_CONFIG.autoRecallTypes
        ? [...DEFAULT_CONFIG.autoRecallTypes]
        : null;
    } else {
      const unique = new Set(config.autoRecallTypes);
      if (unique.size !== config.autoRecallTypes.length) {
        config.autoRecallTypes = [...unique] as MemoryType[];
        warnings.push("autoRecallTypes contains duplicate values. Using deduplicated value.");
      }
    }
  }

  // Validate observationScopes - invalid values reset to null, then null triggers error
  let observationScopesInvalid = false;
  let observationScopesReason = "";

  if (typeof config.observationScopes === "string") {
    const validPresets = ["per_tag", "combined", "all_combinations"];
    if (!validPresets.includes(config.observationScopes)) {
      observationScopesInvalid = true;
      observationScopesReason = `observationScopes: invalid preset "${config.observationScopes}". Expected "per_tag", "combined", or "all_combinations"`;
    }
  } else if (Array.isArray(config.observationScopes)) {
    if (config.observationScopes.length === 0) {
      observationScopesInvalid = true;
      observationScopesReason = "observationScopes: array must not be empty";
    } else {
      for (let i = 0; i < config.observationScopes.length; i++) {
        const group = config.observationScopes[i];
        if (!Array.isArray(group)) {
          observationScopesInvalid = true;
          observationScopesReason = `observationScopes[${i}]: must be an array of strings`;
          break;
        }
        if (group.length === 0) {
          observationScopesInvalid = true;
          observationScopesReason = `observationScopes[${i}]: must not be empty`;
          break;
        }
        for (let j = 0; j < group.length; j++) {
          if (typeof group[j] !== "string") {
            observationScopesInvalid = true;
            observationScopesReason = `observationScopes[${i}][${j}]: must be a string`;
            break;
          }
        }
        if (observationScopesInvalid) break;
      }
    }
    // Warn on non-exact placeholder usage (informational only, not invalid)
    if (!observationScopesInvalid) {
      const placeholderWarnings = checkScopePlaceholderWarnings(config.observationScopes);
      for (const w of placeholderWarnings) {
        warnings.push(w);
      }
    }
  } else if (config.observationScopes !== null) {
    observationScopesInvalid = true;
    observationScopesReason =
      "observationScopes: must be a preset string or an array of tag arrays";
  }

  if (observationScopesInvalid) {
    errors.push(`${observationScopesReason}. Using default (null).`);
    config.observationScopes = DEFAULT_CONFIG.observationScopes;
  } else if (config.observationScopes === null) {
    // Only push the generic "is required" error when it was genuinely unset,
    // not when a specific reason was already surfaced above.
    errors.push(
      "observationScopes is required (must be a preset string or an array of tag arrays)"
    );
  }

  // Validate autoRecallRole
  {
    const validRoles: AutoRecallRole[] = ["user", "assistant"];
    if (typeof config.autoRecallRole === "string") {
      const lower = config.autoRecallRole.toLowerCase();
      if (validRoles.includes(lower as AutoRecallRole)) {
        config.autoRecallRole = lower as AutoRecallRole;
      } else {
        warnings.push(
          `autoRecallRole: invalid value "${config.autoRecallRole}". Expected "user" or "assistant". Using default: ${DEFAULT_CONFIG.autoRecallRole}.`
        );
        config.autoRecallRole = DEFAULT_CONFIG.autoRecallRole;
      }
    } else {
      warnings.push(
        `autoRecallRole: expected a string, got ${typeof config.autoRecallRole}. Using default: ${DEFAULT_CONFIG.autoRecallRole}.`
      );
      config.autoRecallRole = DEFAULT_CONFIG.autoRecallRole;
    }
  }

  // Validate autoRecallTagsMatch (always, not conditional on autoRecallTags)
  {
    const validMatches: TagsMatch[] = ["any", "all", "any_strict", "all_strict"];
    if (!validMatches.includes(config.autoRecallTagsMatch)) {
      warnings.push(
        `autoRecallTagsMatch: invalid value "${config.autoRecallTagsMatch}". Expected one of: ${validMatches.join(", ")}. Using default: ${DEFAULT_CONFIG.autoRecallTagsMatch}.`
      );
      config.autoRecallTagsMatch = DEFAULT_CONFIG.autoRecallTagsMatch;
    }
  }

  // Validate autoRecallTags
  if (config.autoRecallTags !== null) {
    // Check for non-exact placeholder usage in recall tags (informational, not invalid)
    const placeholderPatterns = Object.keys(SCOPE_PLACEHOLDERS);
    for (const tag of config.autoRecallTags) {
      for (const placeholder of placeholderPatterns) {
        if (tag !== placeholder && tag.includes(placeholder)) {
          warnings.push(
            `autoRecallTags tag "${tag}" contains placeholder ${placeholder} but is not an exact match; placeholders must be used as standalone tags (e.g. "${placeholder}" not "${tag}")`
          );
        }
      }
    }
  }

  // Validate autoRecallTagGroups
  if (config.autoRecallTagGroups !== null) {
    const placeholderPatterns = Object.keys(SCOPE_PLACEHOLDERS);
    validateTagGroupsPlaceholders(config.autoRecallTagGroups, placeholderPatterns, warnings);
    // Warn if both autoRecallTags and autoRecallTagGroups are set (both are combined at recall time)
    if (config.autoRecallTags !== null) {
      warnings.push(
        "Both autoRecallTags and autoRecallTagGroups are set. Both will be sent to the recall API — tags/tagsMatch and tag_groups are combined. Consider using only autoRecallTagGroups if you want all tag logic in one place."
      );
    }
  }

  // Validate autoFlushSessionOn / autoFlushPendingOn
  {
    const validateEventList = <T extends string>(
      fieldName: keyof HindsightConfig,
      value: T[],
      validEvents: readonly T[],
      defaultValue: readonly T[]
    ): void => {
      if (!Array.isArray(value)) {
        warnings.push(
          `${fieldName} must be an array. Using default: ${JSON.stringify(defaultValue)}.`
        );
        (config as unknown as Record<string, T[]>)[fieldName] = [...defaultValue];
        return;
      }
      const invalid = value.filter((item) => !validEvents.includes(item));
      if (invalid.length > 0) {
        warnings.push(
          `${fieldName} contains invalid values: ${invalid.join(", ")}. Valid: ${validEvents.join(", ")}. Using default: ${JSON.stringify(defaultValue)}.`
        );
        (config as unknown as Record<string, T[]>)[fieldName] = [...defaultValue];
      } else {
        const unique = new Set(value);
        if (unique.size !== value.length) {
          (config as unknown as Record<string, T[]>)[fieldName] = [...unique] as T[];
          warnings.push(`${fieldName} contains duplicate values. Using deduplicated value.`);
        }
      }
    };
    validateEventList(
      "autoFlushSessionOn",
      config.autoFlushSessionOn,
      VALID_AUTO_FLUSH_SESSION_EVENTS as unknown as AutoFlushSessionEvent[],
      DEFAULT_CONFIG.autoFlushSessionOn
    );
    validateEventList(
      "autoFlushPendingOn",
      config.autoFlushPendingOn,
      VALID_AUTO_FLUSH_PENDING_EVENTS as unknown as AutoFlushPendingEvent[],
      DEFAULT_CONFIG.autoFlushPendingOn
    );

    // Overlap: "quit" may appear in both. Pending flush takes precedence to
    // avoid double-flushing; the active-session quit flush is skipped.
    if (config.autoFlushSessionOn.includes("quit") && config.autoFlushPendingOn.includes("quit")) {
      warnings.push(
        '"quit" is present in both autoFlushSessionOn and autoFlushPendingOn; the pending flush takes precedence and the active-session quit flush is skipped to avoid duplicate work.'
      );
    }
  }

  // Warn if autoRecallDisplay is true but autoRecallPersist is false
  if (config.autoRecallDisplay && !config.autoRecallPersist) {
    warnings.push(
      "autoRecallDisplay: true will not show new recall messages when autoRecallPersist: false (new recalls are ephemeral and not added to chat; only the most recent is available via /hindsight popup). However, autoRecallDisplay still affects rendering of previously persisted recall messages in session files (e.g. when enabled: false)."
    );
  }

  const prefix = prefixLog;
  return { valid: errors.length === 0, errors: errors.map(prefix), warnings: warnings.map(prefix) };
}
