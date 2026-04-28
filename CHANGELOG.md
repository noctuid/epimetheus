# Changelog

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
