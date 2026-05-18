# Changelog

## Pending

### Features

- **`autoRecallTagGroups` config** — Compound boolean tag expressions (and/or/not) for auto-recall filtering. Supports recursive nesting and the same placeholders as `autoRecallTags`. When both `autoRecallTags` and `autoRecallTagGroups` are set, both are sent to the recall API and combined. Env var: `PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS`.
- **Selective tool registration via `toolsEnabled`** — `toolsEnabled` now accepts an array of tool names (e.g. `["retain", "recall"]`) to register only listed tools. Boolean `true`/`false` behavior is preserved.
- **`hindsight_retain` tool visibility** — The `hindsight_retain` tool is now proactively hidden via `pi.setActiveTools()` when the session is not retained, instead of showing an error on execution. Visibility is updated on `session_start` and `toggle-retain`.
- **Retention toggle confirmation** — Toggling retention off now warns that queued messages will be deleted and asks for confirmation.
- **Retained content in tool UI** — `hindsight_retain` now shows the full retained content (dimmed) in the TUI alongside the success indicator.
- **Config validation is non-fatal for most settings** — Invalid values now produce warnings and reset to defaults instead of disabling the plugin. Only `apiUrl`, `apiKey`, `bankId`, and missing `observationScopes` remain as errors. Warnings now include the fallback value. Also fixes several validation bugs: shallow copy bug sharing references with `DEFAULT_CONFIG`, crash on missing `retainContent`/`strip` sub-properties, suppressed warnings when config is invalid, and more.

### Deprecations

- **`recallShowDateTime`** — Use `autoRecallShowDateTime` instead. The old config file key and `PI_HINDSIGHT_RECALL_SHOW_DATETIME` env var still work as silent fallbacks.
- **`recallTypes`** — Use `autoRecallTypes` instead. The old config file key and `PI_HINDSIGHT_RECALL_TYPES` env var still work as silent fallbacks.

### Internal

- Switched to `@earendil-works` npm namespace for pi-coding-agent and pi-tui imports.
- Isolated tests from the user's `~/.pi/agent/` directory via temp `PI_CODING_AGENT_DIR`.
- Added `--isolate` to `bun test` in CI to prevent `mock.module()` pollution across test files.
- Added commitlint with conventional config.
- Compressed tool descriptions and parameter docs for token savings.

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
