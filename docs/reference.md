# Reference

Detailed configuration, tools, commands, and operational details for pi-hindsight. For getting started, see the [main README](../README.md).

# Table of Contents
- [Configuration](#configuration)
  - [General Settings](#general-settings)
    - [Disabled Mode](#disabled-mode)
    - [Debug Mode](#debug-mode)
  - [Auto-Flush Events](#auto-flush-events)
    - [Overlap: `quit` in both lists](#overlap-quit-in-both-lists)
  - [Auto-Recall Settings](#auto-recall-settings)
    - [autoRecallPersist Tradeoffs](#autorecallpersist-tradeoffs)
  - [Status Bar Indicator](#status-bar-indicator)
  - [Session Retention Control](#session-retention-control)
  - [Extra Context & Flush Guard](#extra-context--flush-guard)
    - [Flush Guard](#flush-guard)
  - [Content Retention & Stripping Settings](#content-retention--stripping-settings)
    - [retainContent](#retaincontent)
    - [strip](#strip)
    - [toolFilter](#toolfilter)
    - [entities](#entities)
  - [observationScopes](#observationscopes)
    - [Project scope for relocatable projects](#project-scope-for-relocatable-projects)
  - [autoRecallTags](#autorecalltags)
  - [Project-specific Recall and Storage](#project-specific-recall-and-storage)
  - [Environment Variables](#environment-variables)
- [Additional Details](#additional-details)
  - [Memory Fencing](#memory-fencing)
  - [Failure Modes](#failure-modes)
- [Tools](#tools)
- [Slash Commands](#slash-commands)
- [Known Package Interactions](#known-package-interactions)

# Configuration
Configuration is stored in `<getAgentDir()>/extensions/pi-hindsight/config.json` or `config.jsonc` (JSONC has precedence). See the [Example Configuration](../README.md#example-configuration) in the main README for a practical starting point.

## General Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable or disable the extension. When `false`, the extension runs in a lightweight disabled mode (see [Disabled Mode](#disabled-mode)). |
| `toolsEnabled` | `true` | Which tools to register: `true` (all), `false` (none), or array of tool names (`"retain"`, `"recall"`, `"reflect"`, `"set_extra_context"`, `"get_extra_context"`) |
| `autoRecallEnabled` | `true` | Automatically recall relevant memories before each LLM call |
| `autoRetainEnabled` | `true` | Automatically queue messages for retention on `message_end` (see [Session Retention Control](#session-retention-control)) |
| `autoRecallBudget` | `"mid"` | Recall retrieval budget. One of `"low"`, `"mid"`, `"high"`. Controls how many results Hindsight returns. |
| `hindsightContextPrefix` | `"pi: "` | Prefix prepended to the session name or first message when building the `context` field for retained documents |
| `hindsightContextMaxLength` | `100` | Maximum character length for the `context` field (including prefix) when the session name is auto-derived from the first user message. Manually set session names are preserved as-is and may exceed this length. |
| `maxRecallTokens` | `null` | Maximum tokens for recalled content. When `null`, uses Hindsight's default (4096). See [max tokens context window size](https://hindsight.vectorize.io/developer/retrieval#max-tokens-context-window-size) for details. |
| `recallMaxQueryChars` | `800` | Maximum characters from the user's message to use as the recall query |
| `recallPromptPreamble` | *(see defaults)* | The system note text inside `<hindsight_memories>` fences that instructs the LLM how to use recalled memories |
| `constantTags` | `["harness:pi"]` | Tags included on every retained document (useful for filtering in Hindsight) |
| `autoFlushSessionOn` | `["switch", "fork", "reload"]` | Auto-flush the current session when these lifecycle events occur. Options: `"switch"` (`/new`, `/resume`), `"fork"` (`/fork`, `/clone`), `"reload"`, `"compact"`, `"quit"` (active-session only; skipped if `"quit"` is also in `autoFlushPendingOn`), `"tree"`. See [Auto-Flush Events](#auto-flush-events). |
| `autoFlushPendingOn` | `["quit"]` | Run the `/hindsight flush-pending`-equivalent flow on these events. Options: `"quit"`, `"startup"`. See [Auto-Flush Events](#auto-flush-events). |
| `requireExtraContextBeforeFlush` | `false` | Block automatic flush until extra context is set via `/hindsight set-extra-context` or the `hindsight_set_extra_context` tool. Helps prevent incorrect extraction for sessions involving satire, fiction, external blog posts, or other content that could be misclassified. See [Extra Context & Flush Guard](#extra-context--flush-guard). |
| `debug` | `false` | Enable debug mode. Logs parse pipeline timing to console and shows auto-flush block notifications that are otherwise suppressed. See [Debug Mode](#debug-mode). |

### Disabled Mode
When `enabled: false`, pi-hindsight runs in a lightweight disabled mode. No tools, commands, API client, auto-recall, auto-retain, or status indicator are registered. However, two things are still handled:

1. **Context filtering**: `hindsight-recall` custom messages are filtered from the LLM context, preventing stale recall messages from being sent to the model. This only matters for sessions where `autoRecallPersist` was enabled (the default is false) and those sessions are resumed.

2. **Custom message renderer**: The `hindsight-recall` renderer is still registered based on `autoRecallDisplay`:
   - **`autoRecallDisplay: true`** — Persisted recall messages render with their formatted content (collapsed/expanded), so they display nicely in the TUI even though the extension is disabled.
   - **`autoRecallDisplay: false`** (default) — The renderer hides recall messages from the chat (returns empty lines), preventing raw custom message data from appearing.

> **Note:** When disabled, the `/hindsight toggle-display` command is not available, so `autoRecallDisplay` can only be controlled via the config file or `PI_HINDSIGHT_AUTO_RECALL_DISPLAY` environment variable.

This ensures that disabling the extension does not leave stale data in your sessions — recall messages are both filtered from the LLM context and properly rendered (or hidden) in the UI.

**If you stop using Hindsight entirely** and have sessions with persisted recall entries, you have two options:
1. Keep pi-hindsight installed with `enabled: false` (this disabled mode) — recall messages will continue to be filtered from context and rendered/hidden in the UI
2. Uninstall pi-hindsight and manually remove all `hindsight-recall` entries from your session files — without the extension, `custom_message` entries would otherwise be sent to the LLM as regular user messages (`hindsight-meta` entries are safe to leave since they are `custom` entries, not messages, and won't appear in the LLM context)

> **Pi limitation:** The core issue is that pi has no way to render `custom_message` entries as UI-only (without sending them to the LLM), nor does it support rendering `custom` entries at all. If either were supported, the `autoRecallPersist` tradeoff would disappear — recall could be stored as display-only data that never enters the LLM context. Pi sessions are supposed to be append-only, so while you could technically delete or update these old entries, I won't support that as part of this extension directly.

### Debug Mode

When `debug: true` (or `PI_HINDSIGHT_DEBUG=true`), pi-hindsight enables additional diagnostic output:

- **Parse pipeline timing**: Logs `performance.now()` timing for `parseSessionFile` and `buildMessageArrayFromParsedSession` to the console
- **Auto-flush block notifications**: Block notifications ("Session does not allow retention", "extra context not set") are suppressed during most auto-flushes since they are transient and not useful. In debug mode, these are always shown. The one exception is `/quit` (the final chance before exit):
  - **`/quit`** always shows block notifications regardless of debug mode, so when you finally exit there will be persistent warnings if anything wasn't flushed due to missing extra context. For the default `autoFlushPendingOn: ["quit"]`, these are also mirrored to `console.warn`/`console.error` because the TUI is already gone (see [Auto-Flush Events](#auto-flush-events)).
- **`/hindsight active-tools`**: Only available in debug mode. Shows currently active tool names for debugging tool visibility.

## Auto-Flush Events

Two settings control which session lifecycle events automatically flush pending work:

- **`autoFlushSessionOn`** (default `["switch", "fork", "reload"]`): auto-flush the *current active session* when these events fire.
  - `"switch"` — `session_before_switch`, triggered by `/new` and `/resume`.
  - `"fork"` — `session_before_fork`, triggered by `/fork` and `/clone`.
  - `"reload"` — `session_shutdown` triggered by `/reload`.
  - `"compact"` — `session_compact` triggered by compaction.
  - `"tree"` — `session_before_tree` triggered by `/tree`.
  - `"quit"` — `session_shutdown` with reason `quit`.
- **`autoFlushPendingOn`** (default `["quit"]`): run the `/hindsight flush-pending`-equivalent flow (flush all sessions with pending markers and/or tool queues) when these events fire.
  - `"quit"` — `session_shutdown` with reason `quit`.
  - `"startup"` — `session_start` with reason `startup`. Runs after the client is ready and the health check.

### Overlap: `"quit"` in both lists

`"quit"` may appear in either or both lists. If it is in **both**, the pending flush (`autoFlushPendingOn`) takes precedence and the active-session quit flush is skipped to avoid duplicate work. `validateConfig` emits a warning in that case. The recommended default (`autoFlushPendingOn: ["quit"]`, `"quit"` absent from `autoFlushSessionOn`) flushes all pending sessions on `/quit`.

## Auto-Recall Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `autoRecallShowDateTime` | `true` | Include current date/time above recalled memories |
| `autoRecallDisplay` | `false` | Show recalled messages in the UI. With `autoRecallPersist: true`, controls whether new recall messages are visible in chat. Also affects rendering of previously persisted recall messages (e.g. when `enabled: false`, see [Disabled Mode](#disabled-mode)). |
| `autoRecallPersist` | `false` | Save recall messages to session file (visible in TUI after restart). Both persist modes use `before_agent_start` for recall and the `context` handler for re-injection as the configured role; the difference is whether the recall is also persisted to the session file. See [autoRecallPersist Tradeoffs](#autorecallpersist-tradeoffs). |
| `autoRecallRole` | `"user"` | Role to use when injecting recall memories. The default is `"user"` because some providers require the last message to be user-role. `"assistant"` may also cause issues with other extensions that inject messages via the `context` event, since injection order cannot be controlled and mixed roles may confuse the LLM. |
| `autoRecallTypes` | `["observation"]` | Memory types to recall. Set to `null` or `[]` to recall all types. |
| `autoRecallTags` | `null` | Tags to filter by during auto-recall. Supports same placeholders as observation scopes (`{session}`, `{parent}`, `{cwd}`, `{basedir}`, `{project}`). `null` means no tag filtering (recall from entire bank). See [autoRecallTags](#autorecalltags). |
| `autoRecallTagsMatch` | `"any"` | How to match `autoRecallTags`: `"any"` (OR, includes untagged), `"all"` (AND, includes untagged), `"any_strict"` (OR, excludes untagged), `"all_strict"` (AND, excludes untagged). |
| `autoRecallTagGroups` | `null` | Compound boolean tag expressions for auto-recall. Combined with `autoRecallTags` when both are set. Supports same placeholders. See [autoRecallTags](#autorecalltags). |

> **Note:** observations are deduplicated consolidated information about memories and probably the most useful recall type. See [hindsight issue #826](https://github.com/vectorize-io/hindsight/issues/826) for more information.

### autoRecallPersist Tradeoffs

Both modes use the same flow: `before_agent_start` always performs recall and caches the result; the `context` handler then re-injects the cached recall as the configured role (`user` or `assistant`, per `autoRecallRole`).

When `autoRecallPersist: true`:
- Recall messages are also persisted to the session file as `custom_message` entries (visible in the TUI after restart)
- The `context` handler filters out these persisted `hindsight-recall` entries from the LLM context, preventing old recall messages from being re-sent to the model
- `autoRecallDisplay: true` can be used to show recall messages to the user in the TUI

When `autoRecallPersist: false` (default):
- Recall messages are ephemeral — sent to the LLM via the `context` handler but not persisted or displayed in the TUI
- The most recent recall is available via `/hindsight popup`
- `autoRecallDisplay: true` has no effect on new messages (memories are not stored and cannot be shown in chat) but still affects rendering of any previously persisted recall messages

If you stop using Hindsight and have sessions with persisted recall entries, you can keep pi-hindsight installed with `enabled: false` to continue filtering them from context, or manually remove them from session files. See [Disabled Mode](#disabled-mode) for details and the underlying pi limitation.

## Status Bar Indicator
The extension shows a health indicator in pi's status bar:
- 🧠 (healthy) — Config is valid with no warnings or errors
- 🤯 (unhealthy) — Config has validation errors or load warnings

Both indicator texts are configurable via `statusHealthy` and `statusUnhealthy` options. If `enabled: false`, no status indicator is shown (the extension runs in lightweight disabled mode).

## Session Retention Control
Session retention has two config settings that serve distinct purposes:

- **`retainSessionsByDefault`** (default: `true`) — determines the `retained` state for sessions that don't have metadata. When a session starts and has no hindsight metadata, a metadata entry is automatically created with `retained` set to this value.
- **`autoRetainEnabled`** (default: `true`) — controls whether messages are automatically queued on `message_end`. When disabled, no new messages enter the auto-queue, so there is nothing for the flush handlers to send (tool queue entries from `hindsight_retain` tool calls are still flushed normally).

When a session starts, pi-hindsight checks whether the session file already has hindsight metadata. If it doesn't, a metadata entry is automatically created with `retained` set to `retainSessionsByDefault`. This means:

- **New sessions**: get `retained: true` by default (matching `retainSessionsByDefault: true`)
- **Old sessions resumed without metadata**: also get `retained` based on `retainSessionsByDefault` at the time they are opened
- **Sessions with existing metadata**: keep whatever state was previously set (via toggle-retain, tag, etc.)

The interaction between `autoRetainEnabled` and the session's `retained` state:

| `autoRetainEnabled` | Session `retained` | Auto-queue | Auto-queue flush | `hindsight_retain` tool | Parse & upsert |
|:---:|:---:|:---:|:---:|:---:|:---:|
| `true` | `true` | ✅ | ✅ | ✅ | ✅ |
| `true` | `false` | ❌ | N/A | ❌ | ❌ |
| `false` | `true` | ❌ | N/A | ✅ | ✅ |
| `false` | `false` | ❌ | N/A | ❌ | ❌ |

When `autoRetainEnabled: false`, messages are never added to the auto-queue, so there is nothing to flush. The queue-flush handlers still run on switch/fork/shutdown (to drain any tool queue entries from agent `hindsight_retain` calls), but the auto-queue will always be empty. The `hindsight_retain` tool and manual parse/upsert commands are unaffected — they represent explicit user intent, not automatic behavior.

Per-session control:
- `/hindsight toggle-retain` — Toggle whether the current session should be retained
- `/hindsight tag <tag>` — Add a tag to the session's metadata (included in document tags on flush)
- `/hindsight remove-tag <tag>` — Remove a tag from the session's metadata

Current retain setting and tags can be viewed for the current session with `/hindsight status`.

When a session does not allow retention:
- Messages are not auto-queued on `message_end`
- The `hindsight_retain` tool returns an error ("Session does not allow retention")
- Auto-recall still works (read-only operation)
- `/hindsight parse-session` and `/hindsight parse-and-upsert-session` are disabled

When toggling retention:
- **Off**: Queue files are deleted (queued messages will not be flushed). The existing document in Hindsight is not affected to avoid mistakes (manually delete it if you want to).
- **On**: A confirmation dialog asks whether to parse and upsert the full session first. If confirmed, the entire conversation is retained as the document (so newly queued messages append correctly). If declined, retention is not enabled. Queue files are deleted regardless.

Tags added via `/hindsight tag` are included in the document tags when flushing to Hindsight, alongside the automatic tags (session ID, cwd, parent, etc.).

Session metadata (retention state, tags, and extra context) is stored as a `CustomEntry` in the session file with `customType: "hindsight-meta"`, so it persists across session restarts but is not sent to the LLM.

## Extra Context & Flush Guard

**Extra context** is an optional caveat string appended to the Hindsight `context` field (after the session name), separated by a newline. It helps Hindsight correctly classify content during extraction — for example, indicating that a session involves taking notes on fiction or any content not written by the user.

Extra context is used in all places the Hindsight context field is used:
- **Fact extraction**: Included in the extraction prompt so the LLM knows the nature of the source
- **Full-text search**: Indexed in the tsvector for recall filtering
- **Consolidation**: Included in source fact data passed to the observation synthesis LLM
- **Recall results**: Returned as a field on each memory fact
- **Reflect agent**: Available as context for answer synthesis

There are two ways to set extra context:
1. **Slash command**: `/hindsight set-extra-context This session involves reading Dune by Frank Herbert; characters are not the user`
2. **Tool**: `hindsight_set_extra_context` — the LLM can set extra context directly (useful when the model recognizes the need or at the end of a session - ask model to summarize the overall session and provide necessary context to avoid out-of-context/incorrect memories)

Call with no text (`/hindsight set-extra-context`) to indicate no extra context is needed (satisfies the flush guard).

### Flush Guard

When `requireExtraContextBeforeFlush: true`, session upserts are blocked until extra context is explicitly set. This prevents accidental retention of content that could be misclassified by Hindsight's extraction.

The guard applies to all session upsert paths: automatic flush (session switch, shutdown, compact), manual `/hindsight flush`, `/hindsight flush-pending`, `/hindsight parse-and-upsert-session`, and `/hindsight upsert-all-parsed`. It does **not** apply to the tool queue (`hindsight_retain` tool calls) — those are explicit manual memories that already include the necessary context in their content.

The flush guard distinguishes between three states:

| Extra Context | Flush Guard | Behavior |
|---------------|-------------|----------|
| Never set | **Blocked** | Flush is blocked — you must set extra context first |
| Set to empty string (`""`) | **Satisfied** | Flush proceeds — you've confirmed no extra context is needed |
| Set to non-empty string | **Satisfied** | Flush proceeds — extraction will use the provided caveats |

This is particularly useful for sessions involving prose to prevent Hindsight from treating fictional characters as real people, fictional events as factual, or even real people as the user.

The guard is checked at every session flush point in `autoFlushSessionOn`, `autoFlushPendingOn`, and for the manual manual slash commands (`/hindsight flush`, `/hindsight flush-pending`, `/hindsight parse-and-upsert-session`, and `/hindsight upsert-all-parsed`). Tool queue flushes (from `hindsight_retain` tool calls) are not guarded.

## Content Retention & Stripping Settings
### `retainContent`
Controls what content is retained to Hindsight per role:

**Default:**
```json
{
  "retainContent": {
    "assistant": ["text", "thinking", "toolCall"],
    "user": ["text"],
    "toolResult": ["text"]
  }
}
```

Tool results are included by default. Exclude them if you *never* need to retain output to reduce noise and costs. Include or exclude thinking blocks, user images, and tool calls/results as needed.

**Reconfigurable later**: If you decide you want to retain more or less content, you can update the `retainContent` config and future sessions will use the new settings. Note that changing settings requires reprocessing to update existing documents, which will also update their last use date.

Can also be set via environment variable as a JSON string:
```bash
export PI_HINDSIGHT_RETAIN_CONTENT='{"assistant":["text"],"user":["text"],"toolResult":[]}'
```

**Example — Keep only user and assistant text messages (no tool calls/results):**
```json
{
  "retainContent": {
    "assistant": ["text"],
    "user": ["text"],
    "toolResult": []
  }
}
```

### `strip`
Controls which metadata fields are removed before queuing:

- `topLevel`: Fields from the pi event entry (default: `type`, `id`, `parentId`)
- `message`: Fields from inside the message object (default: `api`, `provider`, `model`, `usage`, `cost`, `stopReason`, `timestamp`, `responseId`)

**Default:**
```json
{
  "strip": {
    "topLevel": ["type", "id", "parentId"],
    "message": ["api", "provider", "model", "usage", "cost", "stopReason", "timestamp", "responseId"]
  }
}
```

Can also be set via environment variable as a JSON string:
```bash
export PI_HINDSIGHT_STRIP='{"topLevel":[],"message":["toolCallId"]}'
```

**Example — Include tool results, strip toolCallId:**
```json
{
  "retainContent": {
    "assistant": ["text", "thinking", "toolCall"],
    "user": ["text"],
    "toolResult": ["text"]
  },
  "strip": {
    "topLevel": ["type", "id", "parentId"],
    "message": ["api", "provider", "model", "usage", "cost", "stopReason", "timestamp", "responseId", "toolCallId"]
  }
}
```

### `toolFilter`
Filters tool calls and tool results by tool name. Uses `include` (whitelist) or `exclude` (blacklist) per category — these are mutually exclusive within each category.

Only applies when `toolCall` is in `retainContent.assistant` or `toolResult` is in `retainContent.toolResult` respectively.

**Default** (conservative; still retains any potentially useful information while reducing unnecessary tokens):
```json
{
  "toolFilter": {
    "toolCall": { "exclude": ["grep", "find", "ls", "read", "hindsight_retain"] },
    "toolResult": { "exclude": ["grep", "find", "ls", "write", "edit", "hindsight_retain", "hindsight_recall", "hindsight_reflect"] }
  }
}
```

The default excludes tool calls where you typically only care about the result (e.g. `read`), and tool results where you typically only care about the input (e.g. `write`). Hindsight tool calls/results are excluded because they would be circular — retaining memories about retained/recalled/reflected content creates a feedback loop, and `hindsight_retain` content is already stored through its own mechanism.

**Examples:**

Retain `read` results but not calls (to have file contents in memory):
```json
{
  "toolFilter": {
    "toolCall": { "exclude": ["read"] },
    "toolResult": { "include": ["read"] }
  }
}
```

No tool filtering (retain everything):
```json
{
  "toolFilter": {}
}
```

Can also be set via environment variable as a JSON string:
```bash
export PI_HINDSIGHT_TOOL_FILTER='{"toolCall":{"exclude":["bash"]},"toolResult":{"include":["read"]}}'
```

### `entities`
Optional entities to pass to every retain call. Useful for tagging known entities in your content.

Each entity has:
- `text`: The entity name/text (e.g., "John")
- `type`: Optional entity type (e.g., "PERSON", "ORG", "CONCEPT")

Example:
```json
{
  "entities": [
    { "text": "John", "type": "PERSON" },
    { "text": "Acme Corp", "type": "ORG" }
  ]
}
```

Or via environment variable as a JSON string:
```bash
export PI_HINDSIGHT_ENTITIES='[{"text":"John","type":"PERSON"}]'
```

### `observationScopes`
Controls how observations are scoped during consolidation. **Required** — the default of `null` is invalid and will produce a validation error; you must explicitly set this to a preset or custom scope groups.

The automatic `session:`, `parent:`, and `cwd:` tags added during retention make observation scopes important for controlling how observations are consolidated across sessions.

Using custom scope groups is recommended. Most users should combine a per-user scope with a per-directory scope.

**Hindsight Presets:**
- `"combined"` — A single pass with all tags together (Hindsight default, not recommended)
- `"per_tag"` — One consolidation pass per individual tag, creating separate observations for each tag
- `"all_combinations"` — One pass per unique combination of tags (can require *many* passes)

**Custom scope groups:** An array of tag arrays, where each inner array defines a group of tags for one consolidation pass. This gives full control over which tag combinations produce separate observations.

**Placeholder expansion:** In custom scope groups, the following placeholders expand at retain time:

| Placeholder | Expands to | Description |
|-------------|-----------|-------------|
| `{session}` | `session:<sessionId>` | Per-session observations |
| `{parent}` | `parent:<parentId>` | Cross-fork observations (falls back to session ID if no parent) |
| `{cwd}` | `cwd:<path>` | Per-directory observations |
| `{basedir}` | `basedir:<basename>` | Per-directory-name observations |
| `{project}` | `project:<name>` | Per-project observations (name from `PI_HINDSIGHT_PROJECT_NAME` or cwd basename) |

Placeholders must be used as standalone tags — e.g. `["{session}"]` not `["{session}:extra"]`. Non-exact placeholder usage will produce a config warning.

**Choosing your scopes:**
- **Per-session observations** (`["{session}"]`) — facts within a single session only — this is rarely useful unless you frequently resume the same session over and over. In practice, you'll get more value from:
- **Per-user** (`["user:<me>"]`) — facts that span all your sessions/documents and memories stored manually with `hindsight_retain` tool, even across different harnesses. Add `"user:<me>"` to `constantTags` and use it as a scope. This is the most broadly useful scope.
- **Per-project** (`["{project}"]`) — facts about a specific project, independent of directory. The project tag defaults to the cwd basename but can be overridden with `PI_HINDSIGHT_PROJECT_NAME`. This is ideal when a project might change directories or have multiple separate worktrees — observations stay linked to the project identity rather than a specific path. See [Project scope for relocatable projects](#project-scope-for-relocatable-projects).
- **Per-directory** (`["{cwd}"]`) — facts about a specific project/codebase, consolidated across all sessions in that directory
- **Per-basedir** (`["{basedir}"]`) — facts scoped by directory name (basename). Less precise than `{cwd}` but works across different parent paths with the same directory name
- **Per-harness** (`["harness:pi"]`) — facts that span all pi sessions (included as a default constant tag)


Recommended example — Per-user scope plus per-project scope:
```jsonc
{
  "constantTags": ["harness:pi", "user:<me>"],
  "observationScopes": [
    ["user:<me>"],   // observations across all your sessions
    ["{project}"]     // observations scoped to this project (basedir or PI_HINDSIGHT_PROJECT_NAME)
  ]
}
```

This creates two consolidation passes:
1. One for facts that span all your sessions (even across different harnesses, assuming you've also tagged those documents with `user:<me>`)
2. One for facts specific to the current project (identified by `PI_HINDSIGHT_PROJECT_NAME` or the cwd basename)

> **Note on duplicate observations:** When you have multiple scopes in `observationScopes`, the same underlying memories may produce duplicate observations — one per scope. For example, a project-scoped observation and a global (per-user) observation may contain overlapping information. To avoid recalling duplicates, you should filter auto-recalled observations to the scope you currently want (e.g., use `autoRecallTags: ["{project}"]` for project-specific recall or `autoRecallTags: ["user:<me>"]` for global recall). Alternatively, if you will never need to switch between scopes, you can limit `observationScopes` to just one entry.

### Project scope for relocatable projects

Use `{project}` when you want observations tied to a project identity rather than a specific directory path. By default `{project}` expands to the cwd basename, so observations automatically follow the project across directory moves (e.g., `~/projects/myapp` → `~/work/myapp` — the `cwd` tag changes but the `project` tag stays the same).

You only need to set `PI_HINDSIGHT_PROJECT_NAME` when you have multiple directories with the same basename that should have separate observations (e.g. `~/work/myapp` vs. `~/personal/myapp`) or if you are using separate worktree folders and want the project name to be the same for both.

Set `PI_HINDSIGHT_PROJECT_NAME` per directory in, e.g. `.env` with [direnv](https://direnv.net/) or [mise](https://mise.jdx.dev/):

```envrc
# In .env per project directory (loaded by direnv or mise):
PI_HINDSIGHT_PROJECT_NAME=myapp
```

```jsonc
{
  "constantTags": ["harness:pi", "user:<me>"],
  "observationScopes": [
    ["user:<me>"],    // observations across all your sessions
    ["{project}"]      // observations for "myapp" regardless of directory
  ]
}
```

**When to use `{project}` vs. `{cwd}` vs. `{basedir}`:**
- `{project}` (recommended) — Observations scoped by project name (cwd basename by default). Automatically follows directory moves. Set `PI_HINDSIGHT_PROJECT_NAME` to disambiguate directories with the same basename or to give separate worktree directories the same project name.
- `{cwd}` — Use when you want observations tied to an exact directory path. Different directories with the same basename produce separate observations.
- `{basedir}` — Use when you want observations grouped by directory name regardless of parent path. All directories named `myapp` share observations.

> **Note:** Since `basedir:` and `project:` tags are generated at retain time, re-parsing and re-ingesting a session (via `/hindsight parse-and-upsert-session`) will use the *current* basedir or `PI_HINDSIGHT_PROJECT_NAME`. This means you can change the project identity of an existing session by updating the env var and re-ingesting — useful for correcting or migrating project names after the fact. The `cwd:` tag is fixed from the session header and does not change on re-parse (unless you manually change it).
>
> The `cwd:` tag and `{cwd}`/`{basedir}`/`{project}` placeholders (in both observation scopes and auto-recall tags) use the session's cwd from the session header — the directory the session was first created in.

Full example with all available scopes:
```jsonc
{
  "constantTags": ["harness:pi", "user:<me>"],
  "observationScopes": [
    ["user:<me>"],    // observations across all your sessions
    ["harness:pi"],   // observations across all pi sessions
    ["{project}"],    // observations scoped to this project (PI_HINDSIGHT_PROJECT_NAME or basedir)
    ["{cwd}"],        // observations scoped to this exact directory path
    ["{basedir}"],    // observations scoped to this directory name
    ["{session}"],    // observations scoped to this session only (rarely needed)
    ["{parent}"]     // observations scoped to the parent conversation thread
  ]
}
```

Or via environment variable as a JSON string:
```bash
export PI_HINDSIGHT_OBSERVATION_SCOPES='[["{session}","user:alice"],["project:foo"]]'
```

Note: This is currently a config-only setting and not exposed as a parameter on the `hindsight_retain` tool. The configured scope applies to all retains (both auto and tool-initiated).

### autoRecallTags
Tags to filter by during auto-recall. When set, only memories matching these tags will be recalled. Supports the same placeholder expansion as observation scopes (`{session}`, `{parent}`, `{cwd}`, `{basedir}`, `{project}`), expanded at recall time using the current session context.

**`autoRecallTagsMatch`** controls how tags are matched:
- `"any"` (default) — OR logic, includes untagged memories. A memory with *any* matching tag is returned.
- `"all"` — AND logic, includes untagged memories. A memory must have *all* specified tags.
- `"any_strict"` — OR logic, **excludes** untagged memories. Only returns memories that actually have a matching tag.
- `"all_strict"` — AND logic, **excludes** untagged memories.

When `autoRecallTags` is `null` (default), no tag filtering is applied and `autoRecallTagsMatch` is ignored — auto-recall searches the entire bank.

**`autoRecallTagGroups`** provides compound boolean tag expressions for auto-recall filtering. When both `autoRecallTags` and `autoRecallTagGroups` are set, both are sent to the Hindsight API and combined. Tag groups support nested `and`/`or`/`not` expressions for complex filtering. Each leaf node has a `tags` array and an optional `match` mode. Groups in the top-level array are AND-ed together. See [the relevant hindsight documentation](https://hindsight.vectorize.io/developer/api/recall#tag_groups) for more information.

Supports the same placeholder expansion as `observationScopes`, expanded at recall time using the current session context.

**Example — Project-scoped recall:**
```jsonc
{
  "autoRecallTags": ["{project}"],
  "autoRecallTagsMatch": "any_strict"
}
```

**Example — Project-scoped recall excluding current session:**
```jsonc
{
  "autoRecallTagGroups": [
    // Match memories from this project AND NOT from this session
    { "tags": ["{project}"], "match": "any_strict" },
    { "not": { "tags": ["{session}"], "match": "any_strict" } }
  ]
}
```

> **Caveat:** Excluding the current session's memories with `not` means you won't recall memories from *the current session*. This is usually fine because the LLM already has the current conversation in context. However, after a session compaction (when old messages are removed from the context window), you *might* want those memories — they just won't be added to Hindsight until the session switches, ends, is compacted (if `autoFlushSessionOn` includes `"compact"`), or manually flushed. In practice, `not: ... {session}` is useful when you want to avoid wasting recall tokens on information the LLM already knows from the current conversation.

**Recall types and tag matching:**

Your `autoRecallTags` configuration depends on which `autoRecallTypes` you use:

- **`autoRecallTypes: ["observation"]`** (default): Observations are tagged exactly according to your observation scopes. If you use `observationScopes: [["{project}"]]`, observations get a `project:<project>` tag and not any others (even constant tags like harness). Using `autoRecallTags: ["harness:pi", "{project}"]` would fail to match any observations.
- **`autoRecallTypes: ["world", "experience"]`**: World/experience memories are tagged based on all tags from the document they were extracted from, so your observation scopes do not matter.

### Project-specific Recall and Storage
By combining `autoRecallTags` and `observationScopes`, you can create project-specific memory that's both stored and recalled per-project:
```jsonc
{
  "constantTags": ["harness:pi", "user:<me>"],
  "observationScopes": [
    ["user:<me>"],    // global observations across all sessions
    ["{project}"]      // project-specific observations
  ],
  "autoRecallTags": ["{project}"],
  "autoRecallTagsMatch": "any_strict"
}
```

With this configuration:
- **Retention**: Observations are consolidated per-user (global) and per-project
- **Recall**: Only memories tagged with the current project name are recalled

If you need backward compatibility with old memories stored under `cwd:` tags where the directory has changed, add the legacy tags via the `PI_HINDSIGHT_AUTO_RECALL_TAGS` env var per-directory (not in config.json, which is shared across all projects):
```envrc
# In .env per project directory (loaded by direnv or mise):
# Supports old memories from a project that has changed directories *and* been renamed
PI_HINDSIGHT_AUTO_RECALL_TAGS='["cwd:/old/path/to/project-name","project:old-name","{project}"]'
# OR: match any of the above
PI_HINDSIGHT_AUTO_RECALL_TAGS_MATCH=any_strict
```

## Environment Variables
Configuration options can also be set via environment variables (override config file). This can be used to use different configurations for different wrapper scripts or for different directories by using [mise](https://mise.jdx.dev/installing-mise.html) or [direnv](https://direnv.net/).

<details>
<summary>Click to see table of all environment variables</summary>

| Environment Variable | Config Key | Type | Default |
|---------------------|------------|------|---------|
| `PI_HINDSIGHT_ENABLED` | `enabled` | boolean | `true` |
| `HINDSIGHT_API_URL` | `apiUrl` | string | *(required)* |
| `HINDSIGHT_API_KEY` | `apiKey` | string | *(required)* |
| `PI_HINDSIGHT_BANK_ID` | `bankId` | string | *(required)* |
| `PI_HINDSIGHT_TOOLS_ENABLED` | `toolsEnabled` | boolean \| JSON array of tool names | `true` |
| `PI_HINDSIGHT_AUTO_RECALL_ENABLED` | `autoRecallEnabled` | boolean | `true` |
| `PI_HINDSIGHT_AUTO_RECALL_BUDGET` | `autoRecallBudget` | `"low"` \| `"mid"` \| `"high"` | `"mid"` |
| `PI_HINDSIGHT_AUTO_RETAIN_ENABLED` | `autoRetainEnabled` | boolean | `true` |
| `PI_HINDSIGHT_CONTEXT_PREFIX` | `hindsightContextPrefix` | string | `"pi: "` |
| `PI_HINDSIGHT_CONTEXT_MAX_LENGTH` | `hindsightContextMaxLength` | number | `100` |
| `PI_HINDSIGHT_MAX_RECALL_TOKENS` | `maxRecallTokens` | number \| null | `null` |
| `PI_HINDSIGHT_RECALL_PROMPT_PREAMBLE` | `recallPromptPreamble` | string | *(see defaults)* |
| `PI_HINDSIGHT_AUTO_RECALL_SHOW_DATETIME` | `autoRecallShowDateTime` | boolean | `true` |
| `PI_HINDSIGHT_AUTO_RECALL_DISPLAY` | `autoRecallDisplay` | boolean | `false` |
| `PI_HINDSIGHT_AUTO_RECALL_PERSIST` | `autoRecallPersist` | boolean | `false` |
| `PI_HINDSIGHT_AUTO_RECALL_ROLE` | `autoRecallRole` | `"user"` \| `"assistant"` | `"user"` |
| `PI_HINDSIGHT_RECALL_MAX_QUERY_CHARS` | `recallMaxQueryChars` | number | `800` |
| `PI_HINDSIGHT_AUTO_RECALL_TYPES` | `autoRecallTypes` | string[] (JSON) | `["observation"]` |
| `PI_HINDSIGHT_AUTO_RECALL_TAGS` | `autoRecallTags` | string[] (JSON) | `null` |
| `PI_HINDSIGHT_AUTO_RECALL_TAGS_MATCH` | `autoRecallTagsMatch` | string | `"any"` |
| `PI_HINDSIGHT_AUTO_RECALL_TAG_GROUPS` | `autoRecallTagGroups` | TagGroupInput[] (JSON) | `null` |
| `PI_HINDSIGHT_CONSTANT_TAGS` | `constantTags` | string[] (JSON) | `["harness:pi"]` |
| `PI_HINDSIGHT_AUTO_FLUSH_SESSION_ON` | `autoFlushSessionOn` | string[] (JSON) | `["switch", "fork", "reload"]` |
| `PI_HINDSIGHT_AUTO_FLUSH_PENDING_ON` | `autoFlushPendingOn` | string[] (JSON) | `["quit"]` |
| `PI_HINDSIGHT_REQUIRE_EXTRA_CONTEXT_BEFORE_FLUSH` | `requireExtraContextBeforeFlush` | boolean | `false` |
| `PI_HINDSIGHT_RETAIN_SESSIONS_BY_DEFAULT` | `retainSessionsByDefault` | boolean | `true` |
| `PI_HINDSIGHT_RETAIN_CONTENT` | `retainContent` | RetainContent (JSON) | *(see retainContent default)* |
| `PI_HINDSIGHT_STRIP` | `strip` | StripConfig (JSON) | *(see strip default)* |
| `PI_HINDSIGHT_TOOL_FILTER` | `toolFilter` | ToolFilter (JSON) | *(see toolFilter default)* |
| `PI_HINDSIGHT_PROJECT_NAME` | *(not in config)* | string | *(falls back to cwd basename)* |
| `PI_HINDSIGHT_ENTITIES` | `entities` | EntityInput[] (JSON) | `[]` |
| `PI_HINDSIGHT_OBSERVATION_SCOPES` | `observationScopes` | ObservationScopes (JSON or preset string) | `null` (required) |
| `PI_HINDSIGHT_STATUS_HEALTHY` | `statusHealthy` | string | `"🧠"` |
| `PI_HINDSIGHT_STATUS_UNHEALTHY` | `statusUnhealthy` | string | `"🤯"` |
| `PI_HINDSIGHT_DEBUG` | `debug` | boolean | `false` |
</details>

> **Note:** `PI_HINDSIGHT_PROJECT_NAME` is a special environment variable that controls the `project:` auto-tag and `{project}` observation scope placeholder. Unlike other env vars, it does not correspond to a config file key — it is read at tag-build time and falls back to the cwd basename if not set. This makes it ideal for setting per-directory in `.env` (with direnv or mise) to disambiguate directories that share the same basename or to give separate worktree directories the same project name so they share observations.

# Additional Details
## Memory Fencing
Recalled memories are injected as a proper `user` or `assistant` role message (configurable via `autoRecallRole`), with the content wrapped in `<hindsight_memories>` fences. The fence and preamble provide additional instructions inside the content. This format is inspired by [Hermes](https://github.com/nousresearch/hermes-agent).

Example of injected content (with `autoRecallRole: "user"` - default):

```
role: user
content:
<hindsight_memories>
[System note: The following are recalled memories from hindsight, NOT new user or assistant input. Prioritize recent when conflicting. Only use memories that are directly useful to continue this conversation; ignore the rest]

Current date and time: Monday, 2024-01-15 14:30 EST

{recalled memory content}
</hindsight_memories>
```

The fencing helps prevent the LLM from confusing recalled context with the current conversation, reducing hallucinations and improving response relevance.

The `recallPromptPreamble` config option (shown inside the fence above) defaults to the combined Hermes/Hindsight system note wording. You can customize this text to change the instructions given to the LLM about how to use recalled memories.

## Failure Modes
| Scenario | Behavior |
|----------|----------|
| Retain fails on shutdown | Queue remains on disk for manual flush via `/hindsight flush` |
| Pi crashes | Queue on disk, can be flushed manually on next session |
| Hindsight unavailable | Queue grows, flushed when available |
| Queue file corruption | Skip malformed lines on read (partial data loss) |

# Tools
When `toolsEnabled: true` (default), all tools are available. Set to an array of tool names (`"retain"`, `"recall"`, `"reflect"`, `"set_extra_context"`, `"get_extra_context"`) to register only specific tools, or `false` to disable all tools.

| Tool | Description |
|------|-------------|
| `hindsight_retain` | Store information to long-term memory. Queues to disk and retains on next flush. Use for facts, preferences, decisions, or any information worth remembering. |
| `hindsight_recall` | Search long-term memory using multi-strategy retrieval. Supports filtering by tags, memory types (`world`/`experience`/`observation`), and budget. |
| `hindsight_reflect` | Generate a synthesized answer from long-term memory. Unlike recall which returns raw facts, reflect uses the bank's identity, mental models, and multi-step reasoning to produce a contextual markdown answer. Best for questions requiring synthesis of multiple memories. |
| `hindsight_set_extra_context` | Set extra context/caveats for Hindsight extraction. Appended to the context field (after session name) to help extraction correctly extract memories. See [Extra Context & Flush Guard](#extra-context--flush-guard). |
| `hindsight_get_extra_context` | Get the current extra context set for this session. |

# Slash Commands
All commands are under `/hindsight <subcommand>`. With no subcommand, defaults to `status`.

| Subcommand | Description |
|------------|-------------|
| `flush` | Drain pending messages and retain tool entries for the current session to Hindsight |
| `flush-pending` | Drain pending messages and retain tool entries for all sessions to Hindsight |
| `toggle-retain` | Toggle whether the current session should be retained |
| `tag <tag>` | Add a tag to the session's hindsight metadata |
| `remove-tag <tag>` | Remove a tag from the session's hindsight metadata |
| `set-extra-context <text>` | Set extra context for extraction caveats (appended to Hindsight context field). Call with no text to indicate no extra context is needed (satisfies the flush guard). |
| `toggle-display` | Toggle recall message visibility in UI |
| `popup` | Pop up last recalled messages in overlay |
| `status` | Show operational status (connection, session, recall info, queue count) |
| `config` | Show configuration (file path, env vars, masked config) |
| `active-tools` | Show currently active tool names (for debugging tool visibility). Only available in [debug mode](#debug-mode). |
| `parse-session` | Parse current session to local files for review (no upsert) |
| `parse-and-upsert-session` | Parse and upsert the full current session to Hindsight (forced full re-parse, ignoring cache) |
| `upsert-all-parsed` | Upsert all parsed sessions to Hindsight |

> **Note:** After `/resume`, a new user message is required before `/hindsight popup` will show content, since recall only happens when there's a user message to query against.

# Known Package Interactions
## subagents
You should check how your subagent plugin interacts with sessions. If it writes to a separate session, and you do not want memories stored for subagents, you should disable pi-hindsight for subagents. A good subagent plugin should allow disabling or configuring extensions per-agent.

Edxeth's pi-subagents plugin injects `custom_message` entries via `before_agent_start` (subagent roster) and `sendMessage` (subagent results). These are converted to user-role messages by pi's `convertToLlm`. Since pi-subagents does not use the `context` event, its messages appear before pi-hindsight's recall injection, so the ordering (user prompt → roster/result as user → recall as assistant) is typically fine. However, if other extensions inject messages via the `context` event, injection order cannot be controlled and mixed roles after the user prompt may confuse the LLM. Consider setting `autoRecallRole: "user"` if this becomes an issue.

## rewind/rollback
Rollback with checkpoint extensions is untested. It may require code changes to include rollback information/messages. I think it makes sense to include the rollback information in memories (what happened? why was it necessary?), so I won't support actually removing messages from before the rollback in the final ingested document.

## packages that also use pi.on("context")
Unknown. I'm not sure how this will interact with something like pi-headrom. It needs investigation.
