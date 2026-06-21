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
 * - `activeSessionFlushReady`: per-active-session project-local flush-config
 *   latch. Re-evaluated by every `session_start` (after the health/version
 *   probe succeeds). `true` means the current session can safely retain under
 *   a resolved project name (config is valid, detached, or unmarked with a
 *   derivable default). `false` means the active session's cwd-local flush
 *   config is required-but-missing/invalid, or present-but-invalid for an
 *   unmarked session. Unlike `startupReady`, this CAN flip back to `true`
 *   (e.g. after `/hindsight detach-flush-config`, or a later `session_start` in
 *   a fixed cwd).
 *
 * - `isOperationalReady()`: the unified operational-ready getter
 *   (`startupReady && activeSessionFlushReady`). Any single failed cause
 *   (unreachable/incompatible server, or required-but-missing/invalid cwd-local
 *   flush config) puts the extension into the single degraded mode: unhealthy
 *   status, ALL Hindsight tools hidden, no auto-recall/retain/flush, no queue
 *   writes/network, and operational slash commands blocked. The flush path
 *   (`parseAndUpsertSession`) re-validates freshly via `resolveProjectNameForFlush`
 *   and is NOT gated by this latch — it handles non-active sessions in
 *   `flush-pending` and catches files that disappeared or became invalid after
 *   `session_start`.
 *
 * Also tracks `registeredHindsightTools` (set by `registerTools`) so the unified
 * `refreshToolVisibility` knows which tool names to show when leaving degraded
 * mode and which to hide when entering it.
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
 * Per-active-session project-local flush-config readiness.
 *
 * Defaults to `true` (assume OK) so the pre-`session_start` window is not
 * spuriously blocked — `startupReady` (false until the first healthy probe)
 * gates that window. `session_start` re-evaluates and sets this on every
 * session after the health/version probe. `/hindsight detach-flush-config`
 * also sets it back to `true` (detached wins) so the retain tool is
 * immediately re-enabled.
 */
let activeSessionFlushReady = true;

/** Whether the active session's project-local flush config is usable for retention. */
export function isActiveSessionFlushReady(): boolean {
  return activeSessionFlushReady;
}

/**
 * Set the active-session flush-config readiness. Unlike `markStartupReady`,
 * this is NOT a one-way latch — callers may set it false (failed session_start)
 * and back to true (detach / fixed cwd on a later session_start).
 */
export function setActiveSessionFlushReady(ready: boolean): void {
  activeSessionFlushReady = ready;
}

/** Reset the active-session flush-config latch to true. Exported for testing/reset only. */
export function resetActiveSessionFlushReady(): void {
  activeSessionFlushReady = true;
}

/**
 * Unified operational-ready getter for the normal (enabled, valid-config)
 * path. The extension is operational only when BOTH the process-global
 * health/version probe has succeeded AND the active session's project-local
 * flush config is usable. Any single failed cause (unreachable/incompatible
 * server, or required-but-missing/invalid cwd-local flush config) puts the
 * extension into the single degraded mode (status unhealthy, no Hindsight
 * tools active, no auto-recall/retain/flush, operational subcommands
 * blocked). See `index.ts`'s session_start handler for the per-session
 * evaluation.
 *
 * The fail-fast path (invalid global config) is separate — it never creates
 * a client and registers commands with a constant `() => false` readiness.
 */
export function isOperationalReady(): boolean {
  return isStartupReady() && activeSessionFlushReady;
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
