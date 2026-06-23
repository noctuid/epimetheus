/**
 * Project-local config: cwd-local project-name overrides for project-aware
 * flush tags and `{project}` auto-recall filters.
 *
 * Resolution order (see `docs/architecture/config.md`):
 *
 * 1. If the session is marked `usesProjectConfig: true` (in its latest
 *    `hindsight-meta` entry), a project config file MUST exist and be valid
 *    at `<session header cwd>/.pi/epimetheus/config.jsonc` (or, for git
 *    worktrees, the main repo's via the git commondir).
 *    Missing/invalid (or a removed cwd) → fail closed.
 * 2. Otherwise (not marked), derive a default project name:
 *    - if `<cwd>/.git` exists, resolve the git common dir so worktrees
 *      share the main repo name (e.g. `/repo` and `/repo/worktrees/foo` both → `repo`)
 *    - else `basename(cwd)`
 *
 * Config lookup checks the cwd first, then falls back to the git commondir's
 * parent (the main repo root) when `<cwd>/.git` exists. This lets git worktrees
 * share the main repo's `.pi/epimetheus/config.jsonc` without needing their own
 * `.pi` directory, while still allowing worktrees to override with a cwd-local
 * config. No ancestor walk beyond this git-aware fallback is performed.
 *
 * The schema initially supports only `projectName`; unknown keys warn and are
 * ignored. Invalid/missing required project config fails closed: flushes are
 * skipped and auto-recall is skipped for the active session.
 *
 * Default derivation (detached / unmarked-with-no-file) is git common dir →
 * basename (see {@link ./utils.ts deriveDefaultProjectName}). Env-var overrides
 * were removed because env vars do not track Pi session switching.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { deriveDefaultProjectName, offsetToLineColumn, resolveGitCommonDirParent } from "./utils";

/** The single supported project-config schema: a stable project name. */
export interface ProjectConfig {
  projectName: string;
}

/** Directory (relative to cwd) where the cwd-local project config lives. */
const PROJECT_CONFIG_DIR = join(".pi", "epimetheus");

/**
 * Where the resolved project name came from. Used by `/hindsight config`
 * diagnostics. Not stored anywhere; latest flush resolution wins.
 */
export type ProjectNameSource = "project-local-config" | "git" | "basename";

/**
 * Success result: the resolved project name and its source.
 */
export interface ProjectNameResolutionSuccess {
  ok: true;
  projectName: string;
  source: ProjectNameSource;
}

/**
 * Failure result: flush cannot proceed. The caller should leave pending work
 * queued (do NOT clear the pending marker) and notify clearly.
 */
export interface ProjectNameResolutionFailure {
  ok: false;
  error: string;
  recovery?: ProjectNameRecovery;
  /** Path of the malformed/invalid config, when one was found. */
  configPath?: string;
}

export type ProjectNameResolution = ProjectNameResolutionSuccess | ProjectNameResolutionFailure;

/**
 * Success: a valid cwd-local project config was loaded.
 */
export interface ProjectConfigLoadSuccess {
  ok: true;
  config: ProjectConfig;
  /** Path of the loaded config file. */
  path: string;
  warnings: string[];
}

/**
 * Failure: config missing, malformed, or structurally invalid.
 */
export interface ProjectConfigLoadFailure {
  ok: false;
  error: string;
  /** Path of the malformed/invalid config, when one was found on disk. */
  path?: string;
  warnings: string[];
}

export type ProjectConfigLoadResult = ProjectConfigLoadSuccess | ProjectConfigLoadFailure;

/**
 * Build candidate config paths for a base directory (cwd or commondir parent).
 * `.jsonc` has precedence over `.json`.
 */
function configCandidatesFor(base: string): string[] {
  return [
    join(base, PROJECT_CONFIG_DIR, "config.jsonc"),
    join(base, PROJECT_CONFIG_DIR, "config.json"),
  ];
}

/**
 * Locate the project config file. `.jsonc` has precedence over `.json`.
 *
 * Checks the cwd first, then falls back to the git commondir's parent (the
 * main repo root) when `<cwd>/.git` exists. This lets git worktrees share the
 * main repo's project config without needing their own `.pi` directory, while
 * still allowing worktrees to override with a cwd-local config.
 *
 * Hardened against unreadable / non-file paths: if a candidate path exists on
 * disk but cannot be read (e.g. it is a directory, or lacks read permission),
 * returns `{ path, content: undefined, readError }` instead of throwing. Callers
 * decide how to surface that (typically as a fail-closed "invalid config").
 */
function locateProjectConfig(cwd: string): {
  path: string | undefined;
  content: string | undefined;
  /** Set when a file exists on disk but could not be read. */
  readError?: string;
} {
  // Build the full candidate list: cwd-local first, then commondir fallback.
  const candidates = configCandidatesFor(cwd);
  if (existsSync(join(cwd, ".git"))) {
    const commonDirParent = resolveGitCommonDirParent(cwd);
    if (commonDirParent && commonDirParent !== cwd) {
      candidates.push(...configCandidatesFor(commonDirParent));
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // existsSync is true for directories too; guard against non-files so a
    // directory named config.jsonc doesn't crash readFileSync.
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) {
        return { path: candidate, content: undefined, readError: "not a regular file" };
      }
    } catch (e) {
      return { path: candidate, content: undefined, readError: errMsg(e) };
    }
    try {
      return { path: candidate, content: readFileSync(candidate, "utf-8") };
    } catch (e) {
      return { path: candidate, content: undefined, readError: errMsg(e) };
    }
  }
  return { path: undefined, content: undefined };
}

/** Best-effort error-message extraction for caught values. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Path of the project config file if it exists on disk (`.jsonc` preferred
 * over `.json`). Checks cwd first, then falls back to the git commondir's
 * parent (main repo root) when `<cwd>/.git` exists. Returns `null` when no
 * config is found in either location.
 *
 * Read-only diagnostic helper for `/hindsight config`. Hardened: never throws,
 * even if the candidate path exists but is unreadable or a non-file.
 */
export function findProjectConfigFile(cwd: string): string | null {
  try {
    return locateProjectConfig(cwd).path ?? null;
  } catch {
    // Defensive: locateProjectConfig is already hardened, but guard the public
    // entrypoint against any unexpected throw so /hindsight config never crashes.
    return null;
  }
}

/**
 * Load and validate the project config.
 *
 * `.jsonc` is preferred over `.json`. Checks cwd first, then falls back to
 * the git commondir's parent (main repo root) when `<cwd>/.git` exists. The
 * schema currently supports only `projectName` (non-empty string). Unknown
 * keys produce warnings and are ignored. Malformed JSON, missing/invalid
 * `projectName`, a non-object document, or an unreadable/non-file path all
 * fail closed.
 *
 * Hardened: never throws — read/stat errors are surfaced as `ok:false` results.
 */
export function resolveProjectConfig(cwd: string): ProjectConfigLoadResult {
  let located: ReturnType<typeof locateProjectConfig>;
  try {
    located = locateProjectConfig(cwd);
  } catch (e) {
    // Defensive: locateProjectConfig is hardened, but guard the public entrypoint.
    return { ok: false, error: `could not locate project config: ${errMsg(e)}`, warnings: [] };
  }
  if (located.readError) {
    return {
      ok: false,
      error: `could not read project config ${located.path}: ${located.readError}`,
      path: located.path,
      warnings: [],
    };
  }
  const { path, content } = located;
  if (path === undefined || content === undefined) {
    return { ok: false, error: "no project config file found", warnings: [] };
  }

  const warnings: string[] = [];

  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const details = errors
      .map((e) => {
        const { line, character } = offsetToLineColumn(content, e.offset);
        return `line ${line}, character ${character}: ${printParseErrorCode(e.error)}`;
      })
      .join("; ");
    return {
      ok: false,
      error: `project config is not valid JSON: ${details}`,
      path,
      warnings,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return {
      ok: false,
      error: `project config must be a JSON object (got ${kind})`,
      path,
      warnings,
    };
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "projectName") {
      warnings.push(`unknown key "${key}" ignored (only "projectName" is supported)`);
    }
  }

  if (typeof obj.projectName !== "string") {
    const kind =
      obj.projectName === undefined
        ? "missing"
        : Array.isArray(obj.projectName)
          ? "array"
          : typeof obj.projectName;
    return {
      ok: false,
      error: `project config requires "projectName" to be a string (got ${kind})`,
      path,
      warnings,
    };
  }

  const trimmed = obj.projectName.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: `project config "projectName" must not be empty/whitespace`,
      path,
      warnings,
    };
  }

  return { ok: true, config: { projectName: trimmed }, path, warnings };
}

/**
 * Recovery hints for a failed project-name resolution.
 */
export const ProjectNameRecovery = {
  DetachOrFix: "detach-or-fix",
  FixConfig: "fix-config",
} as const;

export type ProjectNameRecovery = (typeof ProjectNameRecovery)[keyof typeof ProjectNameRecovery];

/**
 * Shared decision core for the tristate project-config matrix.
 *
 * Both {@link resolveProjectName} (flush/auto-recall path) and
 * {@link evaluateActiveSessionProjectState} (session_start readiness latch)
 * delegate to this so the "loaded config + flag → what happens?" matrix lives in
 * exactly one place. Callers keep the cases that genuinely differ:
 * - the `false` (detached) short-circuit (each adapter has its own success shape);
 * - the cwd-existence pre-check (messages and undefined-cwd handling differ);
 * - how a successful/default result is shaped for the caller.
 *
 * Only called with `flag !== false` (detach is resolved by callers first), so
 * `flag` is `true | undefined` here.
 */
type ProjectNameDecision =
  | { kind: "config"; projectName: string; configPath: string }
  | { kind: "default" }
  | { kind: "fail"; error: string; recovery: ProjectNameRecovery; configPath?: string };

function decideFromLoadedConfig(
  loaded: ProjectConfigLoadResult,
  flag: true | undefined
): ProjectNameDecision {
  if (loaded.ok) {
    return { kind: "config", projectName: loaded.config.projectName, configPath: loaded.path };
  }
  // A file exists on disk but is invalid/unreadable → fail closed (this covers
  // both `true` and unmarked so an invalid config never silently falls back to a
  // derived name and allows ingestion under a wrong project identity).
  if (loaded.path !== undefined) {
    return {
      kind: "fail",
      error: `project config ${loaded.path} is invalid: ${loaded.error}`,
      recovery: ProjectNameRecovery.FixConfig,
      configPath: loaded.path,
    };
  }
  // No file present on disk.
  if (flag === true) {
    return {
      kind: "fail",
      error:
        "session is marked as using project-local config, but no project config file is present",
      recovery: ProjectNameRecovery.DetachOrFix,
    };
  }
  // Unmarked, no file → default derivation (caller resolves the name/source).
  return { kind: "default" };
}

/**
 * Resolve the project name to use for a session whose cwd is `cwd`.
 *
 * `usesProjectConfig` is a tristate (`true` | `false` | `undefined`):
 * - `false` (detached): ignore the project config entirely; default derivation
 *   (git → basename). A cwd that no longer exists is non-fatal here.
 * - `true`: a valid cwd-local project config is required (fail closed when the
 *   cwd is gone, the file is missing, or the file is invalid). The config's
 *   `projectName` is authoritative.
 * - `undefined` (unmarked): if a project config file is present on disk, it
 *   signals user intent — a valid one is used, an invalid one fails closed
 *   (no silent fallback). With no file present, default derivation is used.
 *
 * Returns a discrete failure only when the session genuinely cannot produce a
 * trustworthy project name for an upsert. Callers should leave pending work
 * queued on failure and notify clearly.
 */
export function resolveProjectName(
  cwd: string,
  usesProjectConfig: boolean | undefined
): ProjectNameResolution {
  // Detached: explicit false ignores the project config entirely.
  if (usesProjectConfig === false) {
    return defaultProjectName(cwd);
  }

  // `true` requires the cwd to exist.
  if (usesProjectConfig === true && !existsSync(cwd)) {
    return {
      ok: false,
      error: `session is marked as using project-local config, but its cwd "${cwd}" no longer exists`,
      recovery: ProjectNameRecovery.DetachOrFix,
    };
  }

  const decision = decideFromLoadedConfig(resolveProjectConfig(cwd), usesProjectConfig);
  if (decision.kind === "config") {
    return { ok: true, projectName: decision.projectName, source: "project-local-config" };
  }
  if (decision.kind === "default") {
    return defaultProjectName(cwd);
  }
  return {
    ok: false,
    error: decision.error,
    recovery: decision.recovery,
    configPath: decision.configPath,
  };
}

/**
 * Default project-name derivation for detached / unmarked-with-no-config sessions.
 *
 * git common dir (so worktrees share the main repo name) → basename. A cwd
 * that no longer exists is non-fatal here (the git check simply does not apply
 * and basename is used as a stable fallback).
 */
function defaultProjectName(cwd: string): ProjectNameResolution {
  const derived = deriveDefaultProjectName(cwd);
  return { ok: true, projectName: derived.name, source: derived.source };
}

export interface ActiveProjectState {
  ready: boolean;
  reason?: string;
  recovery?: ProjectNameRecovery;
  /** Path of an invalid/unreadable config file found on disk, for diagnostics. */
  configPath?: string;
  /**
   * True when the active session is unmarked (`usesProjectConfig ===
   * undefined`) AND a valid cwd-local project config is present. `session_start`
   * uses this to append `usesProjectConfig: true` (latest-wins auto-mark).
   * Not set (false) when already marked `true`, detached, or in any failing state.
   */
  autoMark?: boolean;
}

/**
 * Evaluate the active session's project-local config state for the
 * `session_start` readiness gate.
 *
 * Rules (mirror {@link resolveProjectName}'s tristate semantics, sharing the
 * post-load decision core {@link decideFromLoadedConfig}):
 * - `usesProjectConfig === false` (detached) → always `ready:true` (the
 *   cwd-local project config is ignored; detach wins). No `autoMark`.
 * - `usesProjectConfig === true` (required) → ready only if the cwd
 *   exists AND a valid project config is present. Otherwise `ready:false`.
 * - `usesProjectConfig === undefined` (unmarked):
 *     - valid file present → `ready:true`, `autoMark:true`.
 *     - invalid/unreadable file present → `ready:false` (never silently fall
 *       back to default derivation; an invalid config is an error).
 *     - no file present → `ready:true` (default derivation applies).
 *
 * `existingMeta` is the latest `hindsight-meta` (or null); only its
 * `usesProjectConfig` field is consulted.
 */
export function evaluateActiveSessionProjectState(
  cwd: string | undefined,
  existingMeta: { usesProjectConfig?: boolean } | null
): ActiveProjectState {
  const flag = existingMeta?.usesProjectConfig;

  // Detached wins.
  if (flag === false) {
    return { ready: true };
  }

  // Required (true) needs the cwd to exist.
  if (flag === true && (!cwd || !existsSync(cwd))) {
    return {
      ready: false,
      reason: `session is marked as using project-local config, but its cwd "${cwd}" does not exist`,
      recovery: ProjectNameRecovery.DetachOrFix,
    };
  }

  if (!cwd) {
    // Unmarked with no cwd → default derivation (non-fatal).
    return { ready: true };
  }

  const decision = decideFromLoadedConfig(resolveProjectConfig(cwd), flag);
  if (decision.kind === "config") {
    // Auto-mark only when unmarked (undefined); when already `true`, no
    // auto-mark is needed.
    return flag !== true ? { ready: true, autoMark: true } : { ready: true };
  }
  if (decision.kind === "default") {
    return { ready: true };
  }
  return {
    ready: false,
    reason: decision.error,
    recovery: decision.recovery,
    configPath: decision.configPath,
  };
}
