/**
 * Tiny runtime-state module shared across event handlers, tools, and slash
 * commands without threading callbacks through every subcommand creator.
 *
 * Holds two independent latches plus a unified getter:
 *
 * - `startupReady`: process-global health/version latch reflecting the most
 *   recent probe. Starts `false`, set `true` after a healthy probe and `false`
 *   again when a later `session_start` probe observes an unreachable/
 *   incompatible server — so the extension re-enters the unified degraded mode
 *   on later server failures (it is NOT a one-way latch). status HEALTHY
 *   is independent: a failed probe sets the status-bar unhealthy regardless of
 *   prior readiness.
 *
 * - `activeSessionProjectReady`: per-active-session project-local config
 *   latch. Re-evaluated by every `session_start` (after the health/version
 *   probe succeeds). `true` means the current session can safely retain under
 *   a resolved project name (config is valid, detached, or unmarked with a
 *   derivable default). `false` means the active session's cwd-local flush
 *   config is required-but-missing/invalid, or present-but-invalid for an
 *   unmarked session. Unlike `startupReady`, this CAN flip back to `true`
 *   (e.g. after `/hindsight detach-project-name`, or a later `session_start` in
 *   a fixed cwd).
 *
 * - `isOperationalReady()`: the unified operational-ready getter
 *   (`startupReady && activeSessionProjectReady`). Any single failed cause
 *   (unreachable/incompatible server, or required-but-missing/invalid cwd-local
 *   project config) puts the extension into the single degraded mode: unhealthy
 *   status, ALL Hindsight tools hidden, no auto-recall/retain/flush, no queue
 *   writes/network, and operational slash commands blocked. The flush path
 *   (`parseAndUpsertSession`) re-validates freshly via `resolveProjectName`
 *   and is NOT gated by this latch — it handles non-active sessions in
 *   `flush-pending` and catches files that disappeared or became invalid after
 *   `session_start`.
 *
 * Also tracks `registeredHindsightTools` (set by `registerTools`) so the unified
 * `refreshToolVisibility` knows which tool names to show when leaving degraded
 * mode and which to hide when entering it.
 *
 * Also tracks `degradedReason`: a typed degraded-mode cause plus its
 * human-readable message (invalid global config, server/version issue, or the
 * active session's project-name failure), or `null` when
 * operational. Set by `index.ts` whenever readiness changes (including the
 * fail-fast invalid-global-config path, which sets it before registering
 * commands); read by the slash-command block path so manual operational
 * commands can surface the SPECIFIC reason (and repeat on every attempt)
 * instead of a one-time generic catch-all. Recovery paths compare the typed
 * cause, never substrings of the human-readable message. The only fallback is
 * the specific internal `"startup readiness has not completed yet"` when no
 * reason has been classified (e.g. before the first `session_start`); there
 * is no generic catch-all fallback.
 *
 * Hindsight tools are process-global and registered lazily by the first healthy
 * `session_start` (not by `before_agent_start` and not at extension init), so
 * session-specific setup remains owned by the session lifecycle. `before_agent_start`
 * only READS `isOperationalReady()` and returns if degraded — it never probes or
 * mutates readiness (session_start is awaited before the first prompt). The
 * recall filter and renderer are always active regardless of readiness.
 *
 * index.ts's `_resetState()` is the single reset entrypoint and calls all the
 * resets here; tests already invoke `_resetState()`.
 */

let startupReady = false;

/** Whether the most recent health + version readiness probe succeeded. */
export function isStartupReady(): boolean {
  return startupReady;
}

/**
 * Mark startup as ready (true). Called after a successful health + version
 * probe. Readiness is re-enterable: {@link clearStartupReady} flips it back to
 * false when a later `session_start` probe observes an unreachable/
 * incompatible server, so the extension re-enters the unified degraded mode.
 */
export function markStartupReady(): void {
  startupReady = true;
}

/** Flip startup readiness back to false (a later probe failed). */
export function clearStartupReady(): void {
  startupReady = false;
}

/** Reset the startup-ready latch to false. Exported for testing/reset only. */
export function resetStartupReady(): void {
  startupReady = false;
}

/**
 * Per-active-session project-local config readiness.
 *
 * Defaults to `true` (assume OK) so the pre-`session_start` window is not
 * spuriously blocked — `startupReady` (false until the first healthy probe)
 * gates that window. `session_start` re-evaluates and sets this on every
 * session after the health/version probe. `/hindsight detach-project-name`
 * also sets it back to `true` (detached wins) so the retain tool is
 * immediately re-enabled.
 */
let activeSessionProjectReady = true;

/** Whether the active session's project-local config is usable for retention. */
export function isActiveSessionProjectReady(): boolean {
  return activeSessionProjectReady;
}

/**
 * Set the active-session project-name readiness. Unlike `markStartupReady`,
 * this is NOT a one-way latch — callers may set it false (failed session_start)
 * and back to true (detach / fixed cwd on a later session_start).
 */
export function setActiveSessionProjectReady(ready: boolean): void {
  activeSessionProjectReady = ready;
}

/** Reset the active-session project-config latch to true. Exported for testing/reset only. */
export function resetActiveSessionProjectReady(): void {
  activeSessionProjectReady = true;
}

/**
 * Unified operational-ready getter for the normal (enabled, valid-config)
 * path. The extension is operational only when BOTH the process-global
 * health/version probe has succeeded AND the active session's project-local
 * project config is usable. Any single failed cause (unreachable/incompatible
 * server, or required-but-missing/invalid cwd-local project config) puts the
 * extension into the single degraded mode (status unhealthy, no Hindsight
 * tools active, no auto-recall/retain/flush, operational subcommands
 * blocked). See `index.ts`'s session_start handler for the per-session
 * evaluation.
 *
 * The fail-fast path (invalid global config) is separate — it never creates
 * a client and registers commands with a constant `() => false` readiness,
 * and sets `degradedReason` to a `global-config` cause with the specific
 * `global config is invalid: ...` message (joined validation errors) before
 * registering commands.
 */
export function isOperationalReady(): boolean {
  return isStartupReady() && activeSessionProjectReady;
}

/**
 * The set of Hindsight tools that have been registered (process-global, via
 * `registerTools`). Used by `refreshToolVisibility` to know which tools to
 * re-show after leaving degraded mode, and to hide all of them when entering
 * it. Set by `tools.ts`'s `registerTools`; reset by `index.ts`'s `_resetState()`.
 */
let registeredHindsightTools: string[] = [];

/** Recorded registered Hindsight tool names (set by `registerTools`). */
export function getRegisteredHindsightTools(): string[] {
  return registeredHindsightTools;
}

/** Record the registered Hindsight tool names. Called by `registerTools`. */
export function setRegisteredHindsightTools(names: string[]): void {
  registeredHindsightTools = names;
}

/** Reset the registered-tools record. Exported for testing/reset only. */
export function resetRegisteredHindsightTools(): void {
  registeredHindsightTools = [];
}

export const DEGRADED_REASON_PENDING = "startup readiness has not completed yet";

export const DegradedReasonKind = {
  GlobalConfig: "global-config",
  Server: "server",
  ProjectName: "project-name",
} as const;

export type DegradedReasonKind = (typeof DegradedReasonKind)[keyof typeof DegradedReasonKind];

export interface DegradedReason {
  kind: DegradedReasonKind;
  message: string;
  /**
   * For causes that carry a list of errors (e.g. global-config validation
   * errors). When non-empty, the block message renders them as a bulleted
   * list below `message`. The shared `epimetheus: ` log prefix is stripped
   * from each at render (it is redundant inside an already-epimetheus-branded
   * block message).
   */
  errors?: string[];
  projectNameRecovery?: "detach-or-fix" | "fix-config";
  /**
   * Session cwd captured when the reason was set, used by recovery advice to
   * render a concrete config file path. Falls back to `<cwd>/.pi/epimetheus/config.jsonc`
   * when unknown.
   */
  cwd?: string;
  /**
   * Path of the invalid/unreadable project config file found on disk, when
   * known. Used by recovery advice to point the user at the exact file to fix
   * (which may be a `.json` file or a git-worktree commondir fallback, not
   * always `<cwd>/.pi/epimetheus/config.jsonc`).
   */
  configPath?: string;
}

/**
 * Typed cause plus human-readable message for the current degraded mode, or
 * `null` when the extension is operational (or has not yet classified the
 * cause). Set by `index.ts` whenever the unified readiness changes: a failed
 * startup probe sets a server/version cause; a failed active-session
 * project-local config sets a project-name cause; a return to
 * operational clears it. Set on the fail-fast invalid-global-config path too
 * (before registering commands) to a global-config cause with the specific
 * `global config is invalid: ...` message. Slash commands read this to give a
 * specific, repeatable block message, while recovery code checks `kind` rather
 * than matching substrings in `message`. There is no generic catch-all
 * fallback; when no reason is classified (e.g. before the first
 * `session_start`), the block message uses the specific internal
 * `"startup readiness has not completed yet"` reason.
 */
let degradedReason: DegradedReason | null = null;

/** Set the degraded-mode reason (null = operational / unknown). */
export function setDegradedReason(reason: DegradedReason | null): void {
  degradedReason = reason;
}

/** The current degraded-mode reason, or null if none is classified. */
export function getDegradedReason(): DegradedReason | null {
  return degradedReason;
}

/** Reset the degraded-reason slot. Exported for testing/reset only. */
export function resetDegradedReason(): void {
  degradedReason = null;
}
