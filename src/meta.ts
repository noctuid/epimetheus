/**
 * Hindsight session metadata management.
 *
 * Session metadata (retention state, tags) is stored as CustomEntry
 * entries in the session file with customType "hindsight-meta".
 * Since session files are append-only, each operation appends a new entry,
 * and the latest one is the current state.
 */

import type { HindsightConfig } from "./config";

/**
 * Session metadata stored in CustomEntry with customType "hindsight-meta".
 * Both fields are optional - only the fields that have been set are present.
 */
export interface HindsightMeta {
  retained?: boolean;
  tags?: string[];
}

/**
 * Get the latest hindsight metadata from session entries.
 * Scans from newest to oldest for the most recent "hindsight-meta" CustomEntry.
 * Returns null if no metadata entry exists.
 */
export function getHindsightMeta(
  entries: Array<{ type: string; customType?: string; data?: unknown }>
): HindsightMeta | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry &&
      entry.type === "custom" &&
      entry.customType === "hindsight-meta" &&
      entry.data !== undefined
    ) {
      return entry.data as HindsightMeta;
    }
  }
  return null;
}

/**
 * Determine whether a session should be retained.
 * Checks the latest hindsight-meta entry for a retained field.
 * If no metadata entry exists or retained is undefined, falls back
 * to the retainSessionsByDefault config value.
 *
 * Note: The session_start handler auto-creates metadata with
 * retained=retainSessionsByDefault when no metadata exists, so this
 * fallback is only relevant before session_start fires or if
 * metadata somehow gets into an inconsistent state.
 */
export function shouldSessionBeRetained(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  config: Pick<HindsightConfig, "retainSessionsByDefault">
): boolean {
  const meta = getHindsightMeta(entries);
  if (meta?.retained !== undefined) {
    return meta.retained;
  }
  return config.retainSessionsByDefault;
}
