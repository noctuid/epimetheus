# Config Architecture

This document explains the high-level configuration and readiness flow. For the full setting reference, see [Reference](../reference.md).

## Goals

Config handling is designed to fail closed for writes while keeping enough of the extension alive for diagnosis and safe cleanup.

- Invalid or unsafe config must not retain to the wrong bank, server, project name, or tag set.
- Existing `hindsight-recall` messages should not leak into model context just because config is broken.
- Users should still be able to inspect what is wrong and recover without hand-editing session files where possible.

## Modes

### Globally disabled mode (`enabled: false`)

`enabled: false` is a global kill switch, not the same thing as degraded mode. In this mode epimetheus does not register slash commands, tools, a client, or operational lifecycle handlers.

The only behavior kept is lightweight session hygiene:

- existing `hindsight-recall` messages are filtered from LLM context;
- the recall renderer still hides or displays old persisted recalls according to display settings.

### Degraded mode

Degraded mode is the single fail-closed operational state for any condition that makes Hindsight unsafe or unavailable while the extension remains enabled. It is not only a startup state: epimetheus can become operational after a successful check, then later re-enter degraded mode if a subsequent session start observes an unhealthy/incompatible server or an invalid project-local flush config for the current session.

Conditions that enter or re-enter degraded mode include:

- invalid global config;
- unreachable Hindsight server;
- incompatible or unavailable server version;
- the current session's project-local flush config is required but missing/invalid;
- the current session's project-local flush config exists but does not contain a valid non-empty `projectName`.

All degraded causes have the same behavior: operational tools, retention, recall, flushes, queue writes, and network work are blocked. This applies both before the first successful startup and after a previously operational session later becomes unsafe. This prevents retaining under a wrong destination, server, project identity, or tag set.

Lightweight diagnostics and recovery remain available:

- `/hindsight status`
- `/hindsight config`
- `/hindsight toggle-display`
- `/hindsight detach-flush-config`
- old `hindsight-recall` filtering/rendering

`/hindsight detach-flush-config` is a recovery command, not an operational command: it can clear a project-local flush-config requirement for the current session, but it does not make the extension operational if another degraded-mode cause still applies.

## Global config

The global extension config lives under `<getAgentDir()>/epimetheus/config.jsonc` or `config.json`. When both files exist, `config.jsonc` has priority over `config.json`. Environment variables override global file/default values.

Global config owns the Hindsight destination and ingestion policy: API URL/key, bank ID, retained content shape, stripping, constant tags, observation scopes, tools, auto-retain/recall/flush behavior, and status/display defaults.

## Project Local Configuration
Project-local config is intentionally not a general overlay for all settings. Settings that affect where or how data is flushed remain global for now to avoid surprising cross-session behavior.

The current recommended way to work with different banks for totally isolated work, for example, is to have a separate pi wrapper script for each use case that sets the configuration environment variables. For work like this, it is probably better for you to use a separate session directory or possibly even a totally different pi coding agent directory.

### Project-local flush config

Project-local flush config is only for a session-specific project-name override used during flushing.


File location is cwd-local only. When both files exist, `flush-config.jsonc` has priority over `flush-config.json`:

```text
<session-cwd>/.pi/epimetheus/flush-config.jsonc
<session-cwd>/.pi/epimetheus/flush-config.json
```

There is no ancestor walk. This keeps the model simple, avoids surprising inheritance from parent directories, and matches Pi's general behavior of not doing project-root discovery for `.pi` config. Users who need subproject identity can run Pi from that subdirectory and put a `.pi/epimetheus/flush-config.jsonc` there.

Initial schema:

```jsonc
{
  "projectName": "my-stable-project-name"
}
```

When a session starts in a cwd with a valid flush config, epimetheus records append-only session metadata:

```jsonc
{
  "usesProjectFlushConfig": true
}
```

The session metadata stores only the boolean. It does not store the config path or project name. On future flushes, the project name is resolved again from the session file header `cwd`.

If the latest metadata says `usesProjectFlushConfig: true`, that session requires a cwd-local flush config with a valid non-empty `projectName`. If the cwd is gone, the file is missing/invalid, or the file is valid JSON but does not specify a valid `projectName`, flushing fails closed and pending work remains queued. `/hindsight detach-flush-config` appends `usesProjectFlushConfig: false` for the current session; it does not delete the file.

If the session is detached or never used project-local flush config, the default project name is derived as:

1. git common-dir repo name when `<cwd>/.git` exists, so worktrees share the main repo name;
2. `basename(cwd)`.

Environment-variable project-name overrides are intentionally not part of the resolution model because they do not follow Pi session switching across directories.

## Flush-time resolution

Flushes use the target session file's header `cwd`, not process cwd and not necessarily the active TUI session cwd. This matters for `/hindsight flush-pending`, which may process sessions from different directories in one command.

Session upserts resolve project identity at flush time. If a required project-local flush config is missing/invalid, or if a present project-local flush config is invalid for an unmarked session, the flush is blocked and pending work remains queued. Tool retain queue entries snapshot their tags and observation scopes when queued, so the current session's config must be valid before the retain tool can create entries.

## Why keep lightweight mode

Even when Hindsight operations are unavailable, epimetheus still protects existing sessions:

- old persisted recall entries are filtered before model context;
- old recall UI rendering remains controlled instead of showing raw custom-message data;
- users can run diagnostics to see whether the failure is global config, project-local flush config, server reachability, or version compatibility;
- recovery commands can detach a session from a missing/broken project-local flush config.

The goal is to fail closed for writes, not to leave users blind.
