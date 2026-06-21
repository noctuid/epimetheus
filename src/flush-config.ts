/**
 * Project-local flush config: cwd-local project-name overrides for flushing.
 *
 * Resolution order for a flush (see `docs/architecture/config.md`):
 *
 * 1. If the session is marked `usesProjectFlushConfig: true` (in its latest
 *    `hindsight-meta` entry), the cwd-local flush config file MUST exist and
 *    be valid at `<session header cwd>/.pi/epimetheus/flush-config.jsonc`.
 *    Missing/invalid (or a removed cwd) → fail closed.
 * 2. Otherwise (not marked), derive a default project name:
 *    - if `<cwd>/.git` exists, resolve the git common dir so worktrees
 *      share the main repo name (e.g. `/repo` and `/repo/worktrees/foo` both → `repo`)
 *    - else `basename(cwd)`
 *
 * Only cwd-local config is consulted — **no ancestor walk**. The schema
 * initially supports only `projectName`; unknown keys warn and are ignored.
 * Invalid/missing required flush config fails closed and flushes are skipped.
 *
 * Default derivation (detached / unmarked-with-no-file) is git common dir →
 * basename (see {@link ./utils.ts deriveDefaultProjectName}). Env-var overrides
 * were removed because env vars do not track Pi session switching.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { deriveDefaultProjectName, offsetToLineColumn } from "./utils";

/** The single supported flush-config schema: a stable project name. */
export interface FlushConfig {
  projectName: string;
}

/** Directory (relative to cwd) where the cwd-local flush config lives. */
const FLUSH_CONFIG_DIR = join(".pi", "epimetheus");

/**
 * Where the resolved project name came from. Used by `/hindsight config`
 * diagnostics. Not stored anywhere; latest flush resolution wins.
 */
export type ProjectNameSource = "flush-config" | "git" | "basename";

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
  /** Path of the malformed/invalid config, when one was found. */
  configPath?: string;
}

export type ProjectNameResolution = ProjectNameResolutionSuccess | ProjectNameResolutionFailure;

/**
 * Success: a valid cwd-local flush config was loaded.
 */
export interface FlushConfigLoadSuccess {
  ok: true;
  config: FlushConfig;
  /** Path of the loaded config file. */
  path: string;
  warnings: string[];
}

/**
 * Failure: config missing, malformed, or structurally invalid.
 */
export interface FlushConfigLoadFailure {
  ok: false;
  error: string;
  /** Path of the malformed/invalid config, when one was found on disk. */
  path?: string;
  warnings: string[];
}

export type FlushConfigLoadResult = FlushConfigLoadSuccess | FlushConfigLoadFailure;

/**
 * Locate the cwd-local flush config file. `.jsonc` has precedence over `.json`.
 * No ancestor walk is performed — only the exact cwd is checked.
 *
 * Hardened against unreadable / non-file paths: if a candidate path exists on
 * disk but cannot be read (e.g. it is a directory, or lacks read permission),
 * returns `{ path, content: undefined, readError }` instead of throwing. Callers
 * decide how to surface that (typically as a fail-closed "invalid config").
 */
function locateFlushConfig(cwd: string): {
  path: string | undefined;
  content: string | undefined;
  /** Set when a file exists on disk but could not be read. */
  readError?: string;
} {
  const candidates = [
    join(cwd, FLUSH_CONFIG_DIR, "flush-config.jsonc"),
    join(cwd, FLUSH_CONFIG_DIR, "flush-config.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // existsSync is true for directories too; guard against non-files so a
    // directory named flush-config.jsonc doesn't crash readFileSync.
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
 * Path of the cwd-local flush config file if it exists on disk (`.jsonc`
 * preferred over `.json`). Returns `null` when neither exists. No ancestor walk.
 *
 * Read-only diagnostic helper for `/hindsight config`. Hardened: never throws,
 * even if the candidate path exists but is unreadable or a non-file.
 */
export function findFlushConfigFile(cwd: string): string | null {
  try {
    return locateFlushConfig(cwd).path ?? null;
  } catch {
    // Defensive: locateFlushConfig is already hardened, but guard the public
    // entrypoint against any unexpected throw so /hindsight config never crashes.
    return null;
  }
}

/**
 * Load and validate the cwd-local flush config.
 *
 * `.jsonc` is preferred over `.json` (no ancestor walk). The schema currently
 * supports only `projectName` (non-empty string). Unknown keys produce warnings
 * and are ignored. Malformed JSON, missing/invalid `projectName`, a non-object
 * document, or an unreadable/non-file path all fail closed.
 *
 * Hardened: never throws — read/stat errors are surfaced as `ok:false` results.
 */
export function resolveFlushConfig(cwd: string): FlushConfigLoadResult {
  let located: ReturnType<typeof locateFlushConfig>;
  try {
    located = locateFlushConfig(cwd);
  } catch (e) {
    // Defensive: locateFlushConfig is hardened, but guard the public entrypoint.
    return { ok: false, error: `could not locate flush config: ${errMsg(e)}`, warnings: [] };
  }
  if (located.readError) {
    return {
      ok: false,
      error: `could not read flush config ${located.path}: ${located.readError}`,
      path: located.path,
      warnings: [],
    };
  }
  const { path, content } = located;
  if (path === undefined || content === undefined) {
    return { ok: false, error: "no cwd-local flush-config file found", warnings: [] };
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
      error: `flush config is not valid JSON: ${details}`,
      path,
      warnings,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return {
      ok: false,
      error: `flush config must be a JSON object (got ${kind})`,
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
      error: `flush config requires "projectName" to be a string (got ${kind})`,
      path,
      warnings,
    };
  }

  const trimmed = obj.projectName.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: `flush config "projectName" must not be empty/whitespace`,
      path,
      warnings,
    };
  }

  return { ok: true, config: { projectName: trimmed }, path, warnings };
}

/**
 * Resolve the project name to use when flushing a session whose cwd is `cwd`.
 *
 * `usesProjectFlushConfig` is a tristate (`true` | `false` | `undefined`):
 * - `false` (detached): ignore the flush config entirely; default derivation
 *   (git → basename). A cwd that no longer exists is non-fatal here.
 * - `true`: a valid cwd-local flush config is required (fail closed when the
 *   cwd is gone, the file is missing, or the file is invalid). The config's
 *   `projectName` is authoritative.
 * - `undefined` (unmarked): if a flush-config file is present on disk, it
 *   signals user intent — a valid one is used, an invalid one fails closed
 *   (no silent fallback). With no file present, default derivation is used.
 *
 * Returns a discrete failure only when the session genuinely cannot produce a
 * trustworthy project name for an upsert. Callers should leave pending work
 * queued on failure and notify clearly.
 */
export function resolveProjectNameForFlush(
  cwd: string,
  usesProjectFlushConfig: boolean | undefined
): ProjectNameResolution {
  // Detached: explicit false ignores the flush config entirely.
  if (usesProjectFlushConfig === false) {
    return defaultProjectName(cwd);
  }

  // `true` requires the cwd to exist.
  if (usesProjectFlushConfig === true && !existsSync(cwd)) {
    return {
      ok: false,
      error: `session is marked as using project-local flush config, but its cwd "${cwd}" no longer exists`,
    };
  }

  const loaded = resolveFlushConfig(cwd);
  if (loaded.ok) {
    // Valid config present → use it (works for both `true` and `undefined`).
    return { ok: true, projectName: loaded.config.projectName, source: "flush-config" };
  }

  // Not ok.
  if (loaded.path !== undefined) {
    // A file exists on disk but is invalid/unreadable → fail closed (this also
    // covers the unmarked case so an invalid config can never silently fall back
    // to env/git/basename and allow ingestion under a wrong project name).
    return {
      ok: false,
      error: `flush config ${loaded.path} is invalid: ${loaded.error}`,
      configPath: loaded.path,
    };
  }

  // No file present on disk.
  if (usesProjectFlushConfig === true) {
    return {
      ok: false,
      error:
        "session is marked as using project-local flush config, but no cwd-local flush-config file is present",
    };
  }

  // Unmarked, no file → default derivation.
  return defaultProjectName(cwd);
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

/**
 * Result of evaluating the *active* session's project-local flush-config state.
 *
 * This drives the per-active-session readiness latch (`activeSessionFlushReady`
 * in `runtime-state.ts`) at `session_start` time. It must agree with
 * {@link resolveProjectNameForFlush}'s ok/fail semantics so the latch (which
 * gates the retain tool + auto-retain) matches what a flush would actually do.
 */
export interface ActiveFlushState {
  ready: boolean;
  reason?: string;
  /** Path of an invalid/unreadable config file found on disk, for diagnostics. */
  configPath?: string;
  /**
   * True when the active session is unmarked (`usesProjectFlushConfig ===
   * undefined`) AND a valid cwd-local flush config is present. `session_start`
   * uses this to append `usesProjectFlushConfig: true` (latest-wins auto-mark).
   * Not set (false) when already marked `true`, detached, or in any failing state.
   */
  autoMark?: boolean;
}

/**
 * Evaluate the active session's project-local flush-config state for the
 * `session_start` readiness gate.
 *
 * Rules (mirror {@link resolveProjectNameForFlush}'s tristate semantics):
 * - `usesProjectFlushConfig === false` (detached) → always `ready:true` (the
 *   cwd-local flush config is ignored; detach wins). No `autoMark`.
 * - `usesProjectFlushConfig === true` (required) → ready only if the cwd
 *   exists AND a valid flush config is present. Otherwise `ready:false`.
 * - `usesProjectFlushConfig === undefined` (unmarked):
 *     - valid file present → `ready:true`, `autoMark:true`.
 *     - invalid/unreadable file present → `ready:false` (never silently fall
 *       back to default derivation; an invalid config is an error).
 *     - no file present → `ready:true` (default derivation applies).
 *
 * `existingMeta` is the latest `hindsight-meta` (or null); only its
 * `usesProjectFlushConfig` field is consulted.
 */
export function evaluateActiveSessionFlushState(
  cwd: string | undefined,
  existingMeta: { usesProjectFlushConfig?: boolean } | null
): ActiveFlushState {
  const flag = existingMeta?.usesProjectFlushConfig;

  // Detached wins.
  if (flag === false) {
    return { ready: true };
  }

  // Required (true) needs the cwd to exist.
  if (flag === true && (!cwd || !existsSync(cwd))) {
    return {
      ready: false,
      reason: `session is marked as using project-local flush config, but its cwd "${cwd}" does not exist`,
    };
  }

  if (!cwd) {
    // Unmarked with no cwd → default derivation (non-fatal).
    return { ready: true };
  }

  const loaded = resolveFlushConfig(cwd);
  if (loaded.ok) {
    // Valid config present. Auto-mark only when unmarked (undefined); when
    // already `true`, no auto-mark is needed.
    return flag !== true ? { ready: true, autoMark: true } : { ready: true };
  }

  if (loaded.path !== undefined) {
    // File exists on disk but is invalid/unreadable → fail closed (this covers
    // both `true` and unmarked — matching resolveProjectNameForFlush exactly).
    return {
      ready: false,
      reason: `flush config ${loaded.path} is invalid: ${loaded.error}`,
      configPath: loaded.path,
    };
  }

  // No file present on disk.
  if (flag === true) {
    return {
      ready: false,
      reason:
        "session is marked as using project-local flush config, but no cwd-local flush-config file is present",
    };
  }

  // Unmarked, no file → default derivation.
  return { ready: true };
}
