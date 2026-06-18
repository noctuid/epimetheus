# Changelog

## Pending

## 0.4.0

### Features

- **`/hindsight flush-pending` subcommand** — Flushes all sessions with pending session markers or tool queue entries.
- **Session chunking improvements** — Session flushes now consistently upsert the full reparsed session as jsonl with replace semantics instead of appending queued messages. This ensures that Hindsight will preferentially keep messages within the same chunk instead of splitting them.
- Added `debug` config setting (`PI_HINDSIGHT_DEBUG`)
  - When enabled, logs parse timing to console
  - Added `/hindsight active-tools` subcommand — shows currently active tool names for debugging tool visibility issues.
  - Blocked flush notifications ("Session does not allow retention", "extra context not set") now use `warning` severity, and auto-flush notifications (blocked, "no pending changes", and successful flush messages like "Parsed and upserted …" / "Flushed N tool entries") are suppressed during automatic flushes (session switch/fork) in normal mode and only shown when `debug: true`. They still show for `/quit` (user may want to know why data wasn't flushed) and user-initiated flushes (`/hindsight flush`, `/hindsight toggle-retain`). For `/reload`, they only show in debug mode.

### Breaking Changes

- **Message content is no longer queued to disk** — The `message_end` handler now creates pending markers instead of queueing message payloads. Session flushes reparse the Pi session JSONL and upsert the full session document with replace semantics.
- **Parsed-session artifact format changed** — `parsed-sessions/{sessionId}.json` is replaced by `{sessionId}.messages.jsonl` plus `{sessionId}.meta.json`. The metadata artifact stores parsed inputs such as `sessionName`, `extraContext`, session user tags, cwd, timestamps, and retention state; full Hindsight context is rebuilt at upsert time.
- **Live session state added for flush guards** — New `session-state/<session-id>.json` files store operational guard state (`retained`, `extraContext`, `updatedAt`) for fast pre-parse checks. Normal flush final metadata still comes from the freshly parsed session file.
- **Configuration: `flushOnCompact` replaced by `autoFlushSessionOn` / `autoFlushPendingOn`** — The boolean `flushOnCompact` setting is removed. Use `autoFlushSessionOn` (array) to control which lifecycle events flush the current active session, and `autoFlushPendingOn` (array) to run the `/hindsight flush-pending`-equivalent flow (flush all pending sessions/tool queues). Default `autoFlushSessionOn` is `["switch", "fork", "reload"]` (matching previous always-on behavior); default `autoFlushPendingOn` is `["quit"]`. Options for `autoFlushSessionOn`: `"switch"` (`/new`, `/resume`), `"fork"` (`/fork`, `/clone`), `"reload"`, `"compact"`, `"quit"` (active-session only), `"tree"` (`/tree`). Options for `autoFlushPendingOn`: `"quit"`, `"startup"`. If `"quit"` is in both, the pending flush takes precedence and the active-session quit flush is skipped (with a validation warning). Environment variables: `PI_HINDSIGHT_AUTO_FLUSH_SESSION_ON` and `PI_HINDSIGHT_AUTO_FLUSH_PENDING_ON` (JSON arrays); `PI_HINDSIGHT_FLUSH_ON_COMPACT` is removed.
- **`/quit` now flushes all pending sessions by default** — Previously `/quit` only flushed the current active session. With the new default `autoFlushPendingOn: ["quit"]`, `/quit` now runs the flush-pending flow across all sessions with pending markers/tool queues, with warning/error notifications mirrored to the console. To restore the old active-session-only `/quit` behavior, set `autoFlushPendingOn: []` and add `"quit"` to `autoFlushSessionOn`.

User note:
- Please flush before updating if you have un-ingested memories from `hindsight_retain` tool calls.
- Old parsed-session artifacts are not migrated. Re-parse and ingest sessions you want rechunked to avoid message splitting. Note that old sessions ingested with `parse-and-upsert-session` are already chunked to avoid message splitting.

### Fixes

- **Multiline slash command arguments** — `/hindsight` subcommand dispatch now preserves internal whitespace and newlines in arguments, so `/hindsight set-extra-context` can store multiline caveats entered with Shift+Return.
- **Cross-platform concurrent queue** — Atomic rename-based claiming works without native locks and supports multiple Pi terminals enqueueing/flushing concurrently.
- **Self-healing inflight recovery** — Abandoned claims are detected using claim metadata, same-host PID checks, and age-based fallbacks, then restored to the live queue for retry.
- **Retry-idempotent tool retains** — Each queued tool retain stores a stable per-entry document ID and is flushed with replace semantics, avoiding duplicate memories when the same queued entry is retried.
- **Flush guard correctness** — Automatic flushes respect retention and extra-context guard state. Fast guard checks use live session state, but once parsing happens, the session file is authoritative for retention, tags, session name, and extra context.
- **Toggle-retain reliability** — Enabling retention writes metadata, shows the retain tool, and queues the session before the optional immediate upsert. Disabling retention updates metadata/tool visibility *before* clearing queued state. Given the new consistent ingestion method, it is also possible to toggle retention on without immediately upserting.
- **Flush feedback improved** — `/hindsight flush-pending` confirmation counts session reparses and tool queues separately, per-session notifications replace the aggregate summary, and no-work notifications are scoped to explicit flushes.
- **Disambiguated `flush-pending` per-session notifications** — Per-session messages emitted while running `/hindsight flush-pending` (parse/upsert success, retention/extra-context warnings, tool-queue outcomes, and missing-session errors) are now prefixed with a `[<sessionid> - <session name>]` header line so users can tell which session each outcome belongs to. The session name is derived the same way as every other flush path (explicit `session_info` name → first user message → `Untitled`). Aggregate messages (`Flushing N session(s)...`, `No pending changes`, `Flush cancelled`, `Failed to list sessions`) are not prefixed. Normal `/hindsight flush` is unaffected.
- **No data loss on corrupt tool queue entries** — `readClaimedToolEntries` now reports errors for missing, malformed-JSON, and invalid-schema claimed files instead of silently skipping them. `flushToolQueue` restores the claim and returns failure with a clear error (including filename and error type) when any claimed file is unreadable, rather than completing the claim and deleting the entries.
- **Session ID invariant guard** — `parseAndUpsertSession` now hard-fails if the parsed session file header id does not match the caller-supplied session id. This is a defensive check for a condition that should never occur in normal operation; it prevents writing parsed artifacts/live state/upserts under the wrong identity if a wrong or corrupt session file is passed. On mismatch, the pending claim is restored (retryable) and the user is notified.
- **Removed `lastUpsertedAt` from parsed `.meta.json`** — The `lastUpsertedAt` field is no longer stored in or validated for parsed-session artifact metadata. `/hindsight upsert-all-parsed` now derives the upsert timestamp from the required non-empty `sessionTimestamp`. Removes a misleading per-upsert clock field from the review/export manifest.
- **Error reporting improved** — Flush paths report parse and tool-queue errors, and fork parent loading reports the underlying parent-load error instead of always claiming the parent session was not found.
- **Flush feedback visible during quit and compaction** — For `/quit` via `autoFlushPendingOn` (default), the flush-pending flow mirrors warning/error notifications to `console.warn`/`console.error` so blocking/failure feedback is visible after the TUI shuts down; for the optional active-session `"quit"` in `autoFlushSessionOn`, the same console mirroring applies to the current-session flush. With `autoFlushSessionOn` containing `"compact"`, compact flushing runs from `session_compact` and captures `ctx.ui.notify` calls emitted during the flush, then replays them via the real `ctx.ui.notify` on the next tick — the compact transition can swallow synchronous notify feedback, so deferred replay keeps it in-TUI once the TUI settles. Compact uses auto-flush notification semantics: success ("Parsed and upserted …" / "Flushed N tool entries"), "No pending changes", and block/not-retained warnings are all suppressed unless `debug: true` (compaction is not a final-chance event like `/quit`). The `autoFlushPendingOn` lifecycle flows differ: `"quit"` runs the `/hindsight flush-pending`-equivalent flow and surfaces per-session block/failure warnings outside debug, mirroring warnings/errors to the console (the TUI is gone); `"startup"` runs in auto-flush mode, suppressing routine block/not-retained warnings and success/no-work unless `debug: true` (quiet best-effort cleanup of old pending sessions), while true errors still surface. `/hindsight flush-pending` (explicit) and `"quit"` surface warnings/success; `"startup"` and compact are quiet by default. Normal `/hindsight flush` is unchanged.

### Documentation

- Added `docs/ARCHITECTURE.md` documenting the queue protocol, claim/recovery flow, live session state, parsed artifacts, and normal flush authority model.

### Internal

- Major refactor/simplification (no longer multiple parsing/upsert paths)
- Removed obsolete auto-queue APIs and dead queue helpers (e.g. `readToolQueue`, `deleteToolQueue`, `getQueueItemCount`).

## 0.3.0

### Features

- **Extra context field and flush guard** — New `requireExtraContextBeforeFlush` config option that blocks automatic flushing until extra context is set via `/hindsight set-extra-context` or the `hindsight_set_extra_context` tool. Helps prevent incorrect extraction for sessions involving fiction, satire, or external content. Extra context is appended to the Hindsight `context` field after the session name.
- **`hindsight_set_extra_context` tool** — Set extra context/caveats for extraction from the LLM. Setting an empty string satisfies the flush guard.
- **`hindsight_get_extra_context` tool** — Query the current extra context. Shows distinct messages for set, empty (flush guard satisfied), and not-set states.
- **`/hindsight set-extra-context` subcommand** — Slash command to set extra context. Call with no text to set empty extra context (satisfies flush guard).
- **`autoRecallRole` config** — Choose whether auto-recall messages are injected as `user` or `assistant` role (default: `user`). Env var: `PI_HINDSIGHT_AUTO_RECALL_ROLE`.
- **`autoRecallTagGroups` config** — Compound boolean tag expressions (and/or/not) for auto-recall filtering. Supports recursive nesting and the same placeholders as `autoRecallTags`. When both `autoRecallTags` and `autoRecallTagGroups` are set, both are sent to the recall API and combined. Env var: `PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS`.
- **Selective tool registration via `toolsEnabled`** — `toolsEnabled` now accepts an array of tool names (e.g. `["retain", "recall"]`) to register only listed tools. Boolean `true`/`false` behavior is preserved.
- **`hindsight_retain` tool visibility** — The `hindsight_retain` tool is now proactively hidden via `pi.setActiveTools()` when the session is not retained, instead of showing an error on execution. Visibility is updated on `session_start` and `toggle-retain`.
- **Retention toggle confirmation** — Toggling retention off now warns that queued messages will be deleted and asks for confirmation.
- **Retained content in tool UI** — `hindsight_retain` now shows the full retained content (dimmed) in the TUI alongside the success indicator.
- **Config validation is non-fatal for most settings** — Invalid values now produce warnings and reset to defaults instead of disabling the plugin. Only `apiUrl`, `apiKey`, `bankId`, and missing `observationScopes` remain as errors. Warnings now include the fallback value. Also fixes several validation bugs: shallow copy bug sharing references with `DEFAULT_CONFIG`, crash on missing `retainContent`/`strip` sub-properties, suppressed warnings when config is invalid, and more.

### Fixes

- **Deduplicate session shutdown flush** — `session_shutdown` no longer re-flushes for `new`/`resume`/`fork` reasons since `session_before_switch`/`session_before_fork` already handle those cases. Prevents duplicate messages on `/new` and `/resume`.
- **`flushOnCompact` uses `session_before_compact`** — Switched from `session_compact` (which was not reliably dispatched) to `session_before_compact`, which also flushes before the compaction rewrites context — a better fit.
- **`NaN`/`Infinity` config values** — `setConfigValue` now rejects `NaN` and `Infinity` for numeric fields (`hindsightContextMaxLength`, `recallMaxQueryChars`, `maxRecallTokens`) instead of silently accepting them.
- **`hindsightContextPrefix` longer than max** — `validateConfig` now warns when the prefix exceeds `hindsightContextMaxLength`, since auto-derived names won't be truncated in that case.
- **Consistent `??` operator** — Replaced `||` with `??` for optional header fields (`timestamp`, `cwd`) to correctly handle empty-string edge cases.
- **Consistent flush guard wording** — Aligned "No extra context needed" wording between `get_extra_context` execute result and renderer (previously "set" vs "needed").

### Changes

- **Unified session name derivation** — Consolidated `truncateSessionTitle` and `getHindsightContextFromEntries` into a new `deriveSessionName` function (single source of truth). Removed `appendExtraContext`. All callers use `deriveSessionName`/`getSessionDisplayName` + `buildContextFromSessionName`, ensuring runtime/parsing parity. `hindsightContextMaxLength` limits the total context length (prefix + name); manually set names are preserved as-is.
- **Extra context in `/hindsight status`** — Moved to its own `== Extra Context ==` section with clearer messaging: full text if set, "(empty — flush guard satisfied)" if explicitly empty, or "(not set)" if never configured.
- **Feature flags in `/hindsight status`** — Added `Flush on compact` and `Require extra context` to the `== Features ==` section.
- **Documentation: `hindsightContextMaxLength`** — Clarified that it limits the total context field length (prefix + name), not just the name portion. Manually set session names are preserved as-is and may exceed this length.
- **Documentation: `set-extra-context`** — Removed misleading quoted examples (e.g. `"..."`) since the command handler does not strip quotes. To set empty extra context, call with no text.

### Deprecations

- **`recallShowDateTime`** — Use `autoRecallShowDateTime` instead. The old config file key and `PI_HINDSIGHT_RECALL_SHOW_DATETIME` env var still work as silent fallbacks.
- **`recallTypes`** — Use `autoRecallTypes` instead. The old config file key and `PI_HINDSIGHT_RECALL_TYPES` env var still work as silent fallbacks.

### Internal

- Switched to `@earendil-works` npm namespace for pi-coding-agent and pi-tui imports.
- Isolated tests from the user's `~/.pi/agent/` directory via temp `PI_CODING_AGENT_DIR`.
- Added `--isolate` to `bun test` in CI to prevent `mock.module()` pollution across test files.
- Added commitlint with conventional config.
- Compressed tool descriptions and parameter docs for token savings.
- Fixed CI masking test failures: `set -o pipefail` ensures `bun test` exit code propagates through `tee` pipe.
- Split reference documentation into `docs/reference.md` for detailed config, tools, commands, and operational docs.
- Improved README clarity and completeness.

## 0.2.0

### Features

- **`basedir:` and `project:` auto-tags** — All retained documents are now automatically tagged with `basedir:<basename>` (derived from cwd) and `project:<name>` (configurable, falls back to basedir). These tags enable project-scoped observations and recall without tying memory to exact directory paths.

- **`{basedir}` and `{project}` observation scope placeholders** — Custom `observationScopes` now support `{basedir}` and `{project}` placeholders that expand at retain time, matching the existing `{session}`, `{parent}`, and `{cwd}` placeholders.

- **`PI_HINDSIGHT_PROJECT_NAME` environment variable** — Overrides the project name (falls back to cwd basename). Not a config file key — read at tag-build time, making it ideal for per-directory setup via `.env` with direnv or mise. Useful for disambiguating directories that share the same basename.

- **`autoRecallTags` and `autoRecallTagsMatch` config** — Filter auto-recall by tags. Supports the same placeholder expansion as observation scopes (`{session}`, `{parent}`, `{cwd}`, `{basedir}`, `{project}`). `autoRecallTagsMatch` controls matching strategy (`any`/`all`/`any_strict`/`all_strict`), derived from the Hindsight SDK's `RecallRequest` type. Env vars: `PI_HINDSIGHT_AUTO_RECALL_TAGS` and `PI_HINDSIGHT_AUTO_RECALL_TAGS_MATCH`.

### Breaking Changes

- `sessionCwd` is now required in `upsertToHindsight` params. No existing parsed sessions lack a `cwd` field (repo was private at that point), so this has no practical impact.

### Documentation

- Added "Project-specific Recall and Storage" section with combined `autoRecallTags` + `observationScopes` configuration examples.
- Added backward compatibility guidance for `cwd:` tags via per-directory env vars.
- Added "No per-project banks by default" design decision explaining why tag-based scoping is preferred over separate banks.
- Documented that `cwd:` tags and cwd-derived placeholders use the session header cwd (not runtime cwd).
- Added `autoRecallTags`/`autoRecallTagsMatch` to config settings table, env var table, TOC, and feature comparison table.

### Internal

- 36 new tests covering: `autoRecallTags`/`autoRecallTagsMatch` config loading, validation warnings, placeholder expansion, `expandAutoRecallTags()`, bootstrap integration tests exercising the real `before_agent_start` handler with `{project}`, `{cwd}`, `{parent}` expansion reaching `client.recall()`, and null-tags passthrough.
