# About
A pi extension that integrates Hindsight AI memory for long-term conversation memory.

Status: This is currently alpha level software. I recommend waiting until I publish to npm if you want something more stable.

# Table of Contents
- [Key Features](#key-features)
- [Philosophy](#philosophy)
- [Local Quickstart](#local-quickstart)
- [Configuration](#configuration)
  - [Example Configuration](#example-configuration)
  - [General Settings](#general-settings)
  - [Auto-Recall Settings](#auto-recall-settings)
    - [autoRecallPersist Tradeoffs](#autorecallpersist-tradeoffs)
  - [Status Bar Indicator](#status-bar-indicator)
  - [Session Retention Control](#session-retention-control)
  - [Content Retention & Stripping Settings](#content-retention--stripping-settings)
    - [retainContent](#retaincontent)
    - [strip](#strip)
    - [toolFilter](#toolfilter)
    - [entities](#entities)
    - [Examples](#examples)
  - [Environment Variables](#environment-variables)
- [Deviations from Official Integrations](#deviations-from-official-integrations)
- [Additional Details](#additional-details)
- [Comparison with Other Implementations](#comparison-with-other-implementations)
  - [Feature Comparison](#feature-comparison)
  - [Design Decisions](#design-decisions)
- [Tools](#tools)
- [Slash Commands](#slash-commands)
- [Recommended User Best Practices](#recommended-user-best-practices)
- [Caveats](#caveats)
- [Known Package Interactions](#known-package-interactions)
- [FAQ](#faq)

# Key Features
Both ambient retain/recall and manual retain/recall tools are enabled by default. Either can be disabled. See [Comparison with Other Implementations](#comparison-with-other-implementations) and [Design Decisions](#design-decisions) for more information on what differentiates this plugin.

## Retain
- Queues messages to disk and automatically retains on session switch, shutdown, etc.
- Also supports ingesting past sessions - any session that has ever existed can be synced to Hindsight, not just sessions that had the extension loaded

## Auto-Recall
When enabled, relevant memories are automatically recalled before each LLM call:

1. Extracts the last user message as a query
2. Searches Hindsight for relevant memories
3. Injects memories as a custom message at the end of the context (only the latest recall is sent)

There are two modes:
1. Ephemerally inject memories - not stored in session file, can only see most recent recall
2. Store memories in session file - allows displaying collapsable blocks with all past recall

The second mode is recommended if you want to be able to view all past recalls, but the first is enabled by default. Note that the second mode puts messages with the customType `hindsight-recall` into the session file. If you stop using this plugin or hindsight, you should continue to filter out these messages using this plugin, your own `pi.on("context")` handler, or remove these entries from your old session files.

# Philosophy
Follow [hindsight best practices](https://hindsight.vectorize.io/best-practices):
- Retains messages as json, which hindsight can intelligently chunk
- Retains all data for the same session with the same `document_id`
- Uses manually session name or truncated first message as `context` field
- Sets the `timestamp` field

Additionally:
- Recalls memories for the current user prompt, unlike [hermes which is currently one turn behind](https://github.com/NousResearch/hermes-agent/issues/5820)
- Supports ingesting past sessions — any session that has ever existed can be synced to Hindsight, not just sessions that had the extension loaded. Note that for old resumed sessions (sessions created before the plugin was installed), only new messages will be auto-queued on `message_end`. To retain the full session history, use `/hindsight parse-and-upsert-session` to ingest the entire conversation.
- Avoids breaking prompt caching - recall messages are appended at the end of the context for a single turn only; the canonical conversation history (which determines cache validity) grows normally with each turn, so caching should work as expected
- Queues content to retain to disk to avoid loss if hindsight is down; also allows deferring processing or reprocessing to potentially lower costs
- Properly handles forking when ingesting full sessions: forks will not duplicate parent content and will only contain new content
- Provides automatic tags: session id, parent session id, store method (tool or auto), and any configured tags like `harness:pi` (default)
- Allows choosing what content to retain and stripping unnecessary fields to reduce tokens/cost

# Local Quickstart
If you want want to run hindsight on your own server or using [hindsight cloud](https://ui.hindsight.vectorize.io/signup), ignore the hindsight-embed commands.

Create a profile:
```bash
uvx hindsight-embed@latest profile create <name> --port <e.g. 9100>
```

Create a bank:
```bash
uvx hindsight-embed@latest -p <profile name> bank create <e.g. default>
```

Start the UI (automatically starts the daemon, will show dashboard url):
```bash
uvx hindsight-embed@latest -p <profile name> ui start
```

You can set any environment variables you want in `~/.hindsight/profiles/<profile>.env`:
```env
# if you want the daemon to remain running (required for this pi extension), you
# either need to create a service or set this variable to 0; otherwise when run
# through uvx it shuts down after there are no requests for a period
HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT=0

HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_API_KEY=sk-...
HINDSIGHT_API_LLM_BASE_URL=.../v1
HINDSIGHT_API_LLM_MODEL=<model>
# if have limited concurrency with provider
HINDSIGHT_API_LLM_MAX_CONCURRENT=5

# can pick faster/cheaper model for lower latency
HINDSIGHT_API_REFLECT_LLM_MODEL=<model>
# hindsight has many other configuration variables, see the documentation for all of them
```

You can customize your retain, observation, and reflect missions in the UI (as well as other settings). See also [Recommended User Best Practices](#recommended-user-best-practices). It is recommended you read over these *early on* to avoid needing to reingest data later after changing settings (but that is always a possibility if you need to).

Create a basic `~/.pi/agent/extensions/pi-hindsight/config.jsonc`:
```jsonc
{
  "enabled": "true",
  "apiUrl": "http://127.0.0.1:9100",
  "apiKey": "unused",
  "bankId": "default",
  // read over tradeoffs before enabling
  "autoRecallPersist": true,
  "autoRecallDisplay": true,
  // recommended to change from default or you will not get cross-session observations
  "observationScopes": [
    // observations about all pi sessions (could also be something like ["user:<me>"] if you add that as a constant tag)
    ["harness:pi"],
    // observations for session
    ["{session}"],
    // for specific directories
    ["{cwd}"]
  ]
}
```
See [autoRecallPersist Tradeoffs](#autorecallpersist-tradeoffs) before enabling!

# Configuration
Configuration is stored in `<getAgentDir()>/extensions/pi-hindsight/config.json` or `config.jsonc` (JSONC has precedence).

## Example Configuration
```jsonc
{
  "apiUrl": "http://127.0.0.1:9100",
  // for local hindsight without a key can set to anything
  "apiKey": "your-api-key",
  "bankId": "default",
  // store recalls in session file and show collapsable blocks; see caveat below!
  "autoRecallPersist": true,
  "autoRecallDisplay": true,
  // if you want to reduce injected memory tokens (hindsight default: 4096, high: 8192)
  // see https://hindsight.vectorize.io/developer/retrieval#max-tokens-context-window-size
  "maxRecallTokens": 2048
}
```

## General Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `toolsEnabled` | `true` | Register hindsight_retain/recall/reflect tools for the agent |
| `autoRecallEnabled` | `true` | Automatically recall relevant memories before each LLM call |
| `autoRetainEnabled` | `true` | Automatically queue messages for retention on `message_end` (see [Session Retention Control](#session-retention-control)) |
| `autoRecallBudget` | `"mid"` | Recall retrieval budget. One of `"low"`, `"mid"`, `"high"`. Controls how many results Hindsight returns. |
| `hindsightContextPrefix` | `"pi: "` | Prefix prepended to the session name or first message when building the `context` field for retained documents |
| `hindsightContextMaxLength` | `100` | Maximum character length for the `context` field (after prefix). The context is truncated to this length. |
| `maxRecallTokens` | `null` | Maximum tokens for recalled content. When `null`, uses Hindsight's default (4096). See [max tokens context window size](https://hindsight.vectorize.io/developer/retrieval#max-tokens-context-window-size) for details. |
| `recallMaxQueryChars` | `800` | Maximum characters from the user's message to use as the recall query |
| `recallPromptPreamble` | *(see defaults)* | The system note text inside `<hindsight_memories>` fences that instructs the LLM how to use recalled memories |
| `constantTags` | `["harness:pi"]` | Tags included on every retained document (useful for filtering in Hindsight) |
| `flushOnCompact` | `false` | Flush queued messages to Hindsight after a compaction event |

## Auto-Recall Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `recallShowDateTime` | `true` | Include current date/time above recalled memories |
| `autoRecallDisplay` | `false` | Show recalled messages in the UI (only works with `autoRecallPersist: true`) |
| `autoRecallPersist` | `false` | Save recall messages to session file (visible in TUI after restart). When `true`, uses `before_agent_start` event for visible, persisted messages. When `false`, uses `context` event for ephemeral messages not shown in TUI. |
| `recallTypes` | `["observation"]` | Memory types to recall. Set to `null` or `[]` to recall all types. |

> **Note:** observations are deduplicated consolidated information about memories and probably the most useful recall type. See [hindsight issue #826](https://github.com/vectorize-io/hindsight/issues/826) for more information.

### autoRecallPersist Tradeoffs
When `autoRecallPersist: true`:
- Recall messages are visible in the TUI and saved to the session file
- Uses `before_agent_start` event to inject messages
- Context filtering in the `context` event prevents old recall messages from being re-sent to the LLM
- **Important**: If pi-hindsight is not loaded, old recall messages in the session file will be sent to the LLM; if you stop using pi-hindsight, you should filter them out yourself or remove them from your session files
- `autoRecallDisplay: true` can be used to show recall messages to the user

When `autoRecallPersist: false` (default):
- Recall messages are ephemeral - sent to LLM but not displayed or persisted except for the most recent message with `/hindsight popup`
- Uses `context` event for injection
- No risk of old recall messages polluting context
- `autoRecallDisplay: true` has no effect (memories are not stored and cannot be shown in chat; only the most recent is available via `/hindsight popup`)

## Status Bar Indicator
The extension shows a health indicator in pi's status bar:
- 🧠 (healthy) — Config is valid with no warnings or errors
- 🤯 (unhealthy) — Config has validation errors or load warnings

Both indicator texts are configurable via `statusHealthy` and `statusUnhealthy` options. If `enabled: false`, no status indicator is shown.

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

Session metadata (retention state and tags) is stored as a `CustomEntry` in the session file with `customType: "hindsight-meta"`, so it persists across session restarts but is not sent to the LLM.

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
Controls how observations are scoped during consolidation. When `null` (default), Hindsight uses its default of `"combined"` (a single consolidation pass with all tags together).

**Presets:**
- `"per_tag"` — One consolidation pass per individual tag, creating separate observations for each tag
- `"combined"` — A single pass with all tags together (Hindsight default)
- `"all_combinations"` — One pass per unique combination of tags

**Custom scope groups:** An array of tag arrays, where each inner array defines a group of tags for one consolidation pass. This gives full control over which tag combinations produce separate observations.

**Placeholder expansion:** In custom scope groups, the following placeholders expand at retain time:

| Placeholder | Expands to | Description |
|-------------|-----------|-------------|
| `{session}` | `session:<sessionId>` | Per-session observations |
| `{parent}` | `parent:<parentId>` | Cross-fork observations (falls back to session ID if no parent) |
| `{cwd}` | `cwd:<path>` | Per-directory observations |

Placeholders must be used as standalone tags — e.g. `["{session}"]` not `["{session}:extra"]`. Non-exact placeholder usage will produce a config warning. This is useful for creating per-session, per-conversation-thread, or per-directory observation scopes.

Example — Create separate observation scopes for user, assistant, session, parent conversation thread, and working directory:
```jsonc
{
  "observationScopes": [
    ["user:alice"],           // observations scoped to alice's facts
    ["assistant:code"],       // observations scoped to specific assistant
    ["{session}"],            // expands to session:<id> — per-session observations
    ["{parent}"],            // expands to parent:<id> — cross fork observations
    ["{cwd}"]                // expands to cwd:<path> — per-directory observations
  ]
}
```

This would create five consolidation passes, each producing its own set of observations:
1. One for facts specific to user `alice`
2. One for facts specific to assistant `code`
3. One for the current session's observations
4. One for the full parent thread context
5. One for the current working directory

Or via environment variable as a JSON string:
```bash
export PI_HINDSIGHT_OBSERVATION_SCOPES='[["{session}","user:alice"],["project:foo"]]'
```

Note: This is currently a config-only setting and not exposed as a parameter on the `hindsight_retain` tool. The configured scope applies to all retains (both auto and tool-initiated).

### Examples

**Keep only user and assistant text messages (no tool calls/results):**
```json
{
  "retainContent": {
    "assistant": ["text"],
    "user": ["text"],
    "toolResult": []
  }
}
```

**Include tool results, strip toolCallId:**
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
| `PI_HINDSIGHT_TOOLS_ENABLED` | `toolsEnabled` | boolean | `true` |
| `PI_HINDSIGHT_AUTO_RECALL_ENABLED` | `autoRecallEnabled` | boolean | `true` |
| `PI_HINDSIGHT_AUTO_RECALL_BUDGET` | `autoRecallBudget` | `"low"` \| `"mid"` \| `"high"` | `"mid"` |
| `PI_HINDSIGHT_AUTO_RETAIN_ENABLED` | `autoRetainEnabled` | boolean | `true` |
| `PI_HINDSIGHT_CONTEXT_PREFIX` | `hindsightContextPrefix` | string | `"pi: "` |
| `PI_HINDSIGHT_CONTEXT_MAX_LENGTH` | `hindsightContextMaxLength` | number | `100` |
| `PI_HINDSIGHT_MAX_RECALL_TOKENS` | `maxRecallTokens` | number \| null | `null` |
| `PI_HINDSIGHT_RECALL_PROMPT_PREAMBLE` | `recallPromptPreamble` | string | *(see defaults)* |
| `PI_HINDSIGHT_RECALL_SHOW_DATETIME` | `recallShowDateTime` | boolean | `true` |
| `PI_HINDSIGHT_AUTO_RECALL_DISPLAY` | `autoRecallDisplay` | boolean | `false` |
| `PI_HINDSIGHT_AUTO_RECALL_PERSIST` | `autoRecallPersist` | boolean | `false` |
| `PI_HINDSIGHT_RECALL_MAX_QUERY_CHARS` | `recallMaxQueryChars` | number | `800` |
| `PI_HINDSIGHT_RECALL_TYPES` | `recallTypes` | string[] (JSON) | `["observation"]` |
| `PI_HINDSIGHT_CONSTANT_TAGS` | `constantTags` | string[] (JSON) | `["harness:pi"]` |
| `PI_HINDSIGHT_FLUSH_ON_COMPACT` | `flushOnCompact` | boolean | `false` |
| `PI_HINDSIGHT_RETAIN_SESSIONS_BY_DEFAULT` | `retainSessionsByDefault` | boolean | `true` |
| `PI_HINDSIGHT_RETAIN_CONTENT` | `retainContent` | RetainContent (JSON) | *(see retainContent default)* |
| `PI_HINDSIGHT_STRIP` | `strip` | StripConfig (JSON) | *(see strip default)* |
| `PI_HINDSIGHT_TOOL_FILTER` | `toolFilter` | ToolFilter (JSON) | *(see toolFilter default)* |
| `PI_HINDSIGHT_ENTITIES` | `entities` | EntityInput[] (JSON) | `[]` |
| `PI_HINDSIGHT_OBSERVATION_SCOPES` | `observationScopes` | ObservationScopes (JSON or preset string) | `null` |
| `PI_HINDSIGHT_STATUS_HEALTHY` | `statusHealthy` | string | `"🧠"` |
| `PI_HINDSIGHT_STATUS_UNHEALTHY` | `statusUnhealthy` | string | `"🤯"` |
</details>

# Deviations from Official Integrations

The official Hindsight integrations make some different default choices:

- **Recall types**: The OpenClaw integration defaults to recalling `world` and `experience` types (excluding verbose observation entries by default, per the OpenClaw integration README). This plugin defaults to `observation` only, since observations are deduplicated consolidated information. You can try either approach — set `recallTypes` to `["world", "experience"]`, `["observation"]`, or `null` (all types) depending on what works best for your use case.

- **hindsight-embed setup**: This plugin does not automatically set up or manage [hindsight-embed](https://github.com/vectorize-io/hindsight-embed). You need to create profiles, banks, and configure hindsight-embed yourself before using this plugin. See [Local Quickstart](#local-quickstart) for setup instructions.

# Additional Details
## Memory Fencing
Recalled memories are wrapped in a `<hindsight_memories>` fence to help the LLM distinguish between new user input and recalled background information. This format is inspired by [Hermes](https://github.com/nousresearch/hermes-agent).

Example of injected content:

```
<hindsight_memories>
[System note: The following are recalled memories from hindsight, NOT new user input. Prioritize recent when conflicting. Only use memories that are directly useful to continue this conversation; ignore the rest]

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

# Comparison with Other Implementations

There are multiple other Hindsight integrations for Pi:

1. **[anh-chu/pi-hindsight](https://github.com/anh-chu/pi-hindsight)** — Simple auto-retain/recall
2. **[pi-less-shitty/packages/hindsight](https://github.com/pi-less-shitty/pi-less-shitty)** — Domain-aware with multi-bank support
3. **[@walodayeet/hindsight-pi](https://github.com/walodayeet/pi-hindsight)** — Feature-rich with multi-bank, linked hosts, reflective recall

## Feature Comparison

| Feature | This Plugin | anh-chu | pi-less-shitty | hindsight-pi |
|---------|:-----------:|:-------:|:--------------:|:------------:|
| **Best Practices** |
| Timestamp set to session start time | ✅ | ❌ | ❌ | ❌ |
| Context field set to session name | ✅ | ❌ | ❌ | ❌ |
| Stable document_id with append mode | ✅ | ✅ | ✅ | ❌ |
| **Architecture** |
| Retain as JSON (not plain text) | ✅ | ❌ | ❌ | ❌¹ |
| Disk queue + reliable persistence | ✅ | ❌ | ❌ | ❌ |
| Official Hindsight client library | ✅ | ❌ | ❌ | ✅ |
| Direct retain on agent_end | ❌¹¹ | ✅ | ✅ | ✅ |
| Credential sanitization on retain | ❌¹² | ❌ | ❌ | ✅ |
| Configurable write frequency | *(planned)* | ❌ | ❌ | ✅² |
| **Config** |
| JSON/JSONC config file | ✅ | ❌ | ❌ | ❌³ |
| Global + project-local config | ❌ | ✅ | ✅ | ✅ |
| Environment variable overrides | ✅ | ❌ | ❌ | ✅ |
| Runtime config persistence | ❌ | ❌ | ❌ | ✅ |
| Interactive setup wizard (`/hindsight:setup`) | ❌ | ❌ | ❌ | ✅ |
| **Recall** |
| Ephemeral injection (not in transcript) | ✅ | ❌ | ❌ | ❌ |
| Injection preserves prompt caching | ✅ | ✅ | ✅ | ❌⁴ |
| Multi-bank recall (project + global) | *(planned)* | ✅ | ✅ | ✅ |
| Configurable recall types | ✅ | ✅ | ✅ | ✅ |
| Custom message renderer | ✅ | ✅ | ✅ | ✅ |
| Cached context (anti-pattern) | ❌ | ❌ | ❌ | ✅⁵ |
| Linked host recall (multiple servers) | ❌ | ❌ | ❌ | ✅⁶ |
| **Retain** |
| Rich automatic tagging (session, cwd, parent) | ✅ | ❌ | ❌ | ✅ |
| Operational tool filtering | ✅ | ✅¹³ | ✅¹³ | ❌ |
| Configurable tool result inclusion | ✅ | ❌ | ❌ | ❌ |
| Hashtag extraction from prompts | ❌ | ✅ | ✅ | ✅ |
| Opt-out via `#nomem`/`#skip` | ❌⁷ | ✅ | ✅ | ❌ |
| Per-session retain/ignore toggle | ✅ | ❌ | ❌ | ❌ |
| Per-session manual tags | ✅ | ❌ | ❌ | ❌ |
| Hard truncation (50KB) | ❌ | ✅ | ✅ | ❌ |
| **Bank Management** |
| Bank auto-creation | ❌ | ❌ | ❌ | ✅ |
| Deterministic bank ID from git/cwd | ❌ | ✅⁸ | ❌ | ✅ |
| Directory → bank ID mappings | ❌ | ❌ | ❌ | ✅ |
| Bank profile/inspection | ❌ | ❌ | ❌ | ✅ |
| **Tools** |
| `hindsight_recall` | ✅ | ✅ | ✅ | ✅⁹ |
| `hindsight_retain` | ✅ | ✅ | ✅ | ✅ |
| `hindsight_retain` with scope param | ✅ (config) | ❌ | ✅ | ❌ |
| `hindsight_reflect` | ✅ | ✅ | ✅ | ✅¹⁰ |
| `hindsight_bank_profile` | ❌ | ❌ | ❌ | ✅ |
| **Legacy Support** |
| Bootstrap/import existing sessions | ✅ | ❌ | ✅ | ❌ |
| Fork detection + parent tracking | ✅ | ❌ | ❌ | ❌ |
| **Operational** |
| TUI overlay for recall (`/hindsight popup`) | ✅ | ❌ | ❌ | ❌ |
| Health/doctor diagnostic command | ❌ | ❌ | ❌ | ✅ |

> **Notes:**
>
> ¹ hindsight-pi builds per-turn summaries with `[user]`/`[assistant]` sections (plaintext), not raw JSON messages.
>
> ² hindsight-pi supports `async`/`turn`/`session`/integer-N write frequencies via `WriteScheduler`.
>
> ³ Uses `~/.hindsight/config.json` (global) + `.hindsight/config.json` (local), not JSONC.
>
> ⁴ Injects into the system prompt each turn (or on first turn only if `injectionFrequency: "first-turn"`), which breaks prompt caching by default.
>
> ⁵ Anti-pattern: recall is fast and should be queried fresh based on the current user prompt each turn, not cached. Caching serves the wrong results when the query changes and adds unnecessary complexity.
>
> ⁶ Integrates with multiple separate Hindsight server instances in a single session. I am not sure what the use case is for this.
>
> ⁷ This plugin supports per-session opt-out via `/hindsight toggle-retain` instead of `#nomem` hashtag-based opt-out. See [Design Decisions](#design-decisions).
>
> ⁸ anh-chu derives `project-{dirname}` from cwd basename (simple, collision-prone). hindsight-pi supports git remote, branch, and per-directory hash strategies.
>
> ⁹ Named `hindsight_search` in hindsight-pi.
>
> ¹⁰ Named `hindsight_context` in hindsight-pi (uses Hindsight's reflect API with dynamic reasoning budget).
>
> ¹¹ Queues messages to disk instead, which prevents data loss if Hindsight is down and allows deferring/reprocessing later. See [Design Decisions](#design-decisions).
>
> ¹² Credential sanitization can't perfectly detect all secrets and risks giving a false sense of safety. It's better prevented at the source — e.g., use [gondolin with secret injection](https://earendil-works.github.io/gondolin/secrets/) or manually remove sensitive fields. If you run memory locally, the risk is lower; if a secret already made it into the session file, it was already sent to your LLM provider, so rotating the credential is the safe move.
>
> ¹³ anh-chu and pi-less-shitty use hardcoded `OPERATIONAL_TOOLS` lists to exclude certain tool calls from plaintext transcripts (not configurable). This plugin uses the configurable `toolFilter` with per-category include/exclude lists, and retains JSON (not plaintext) so tool results can also be selectively included.

> **Note:** This comparison table was AI-generated. If anything is incorrect or outdated, please open a PR. I'm only 100% sure of the current features of my own plugin.

## Design Decisions
- **First class support for old sessions** I want to be able to reingest old sessions later on after adjustments to my retain/observations missions or pi-hindsight stripping configuration.
- **Use a disk queue in case hindsight is down or to delay retention**
- **Use as much automatic tagging as possible**
- **Official TypeScript client library over raw HTTP requests** Using `@vectorize-io/hindsight-client` ensures correct API usage, type safety, and automatic compatibility with Hindsight API changes.
- **No hashtag extraction or `#nomem` opt-out.** These features require parsing user prompts for control tags, which has edge cases with markdown headings. `#nomem` also does not make sense to me for a turn, since any information in that turn could still be referenced in later turns and retained then, and this would complicate reingesting full sessions later. It makes more sense to disable retention on a per-session basis (via `/hindsight toggle-retain`). Same for tags: it makes more sense to have a dedicated command (`/hindsight tag`) for manually adding tags to the document for the current session.
- **No hard truncation or client-side text chunking.** Hindsight chunks content internally and handles large documents gracefully. Arbitrary truncation risks losing useful information. Client-side chunking (as done by hindsight-pi) is unnecessary since Hindsight already handles this.
- **No support for bank creation/management or functionality that hindsight already provides** This is only for pi integration. Do bank creation and setup directly with e.g. `hindsight-embed` and hindsight's UI
- **No project-local configuration files** Use environment variables with mise/direnv for directory-specific config (more flexible and less complex implementation). Note that anh-chu and pi-less-shitty do support `.hindsight/config` in CWD / parent traversal.
- **No bundling of the hindsight skills** I like to use as few skills and instructions as necessary and have not found these necessary. Automatic store/recall does almost all of the work, and I've  found the tool descriptions give enough information for the rest. If needed, the user should obtain the up-to-date skills files from the hindsight repo.
- **No cached recall context.** Recall is fast and should be queried fresh each turn based on the current user prompt. Caching recall results (as done by hindsight-pi) is an anti-pattern: it serves stale or irrelevant results when the user's query changes between turns, defeats the purpose of query-dependent recall, and adds unnecessary complexity (TTL management, background refresh, pinning). Each turn should recall based on the actual current user message.
- **No linked host recall (multiple servers).** This feature allows recalling from multiple Hindsight server instances simultaneously. I can't think of a use case for this — a single Hindsight instance with multiple banks already handles project separation, and the added latency and configuration complexity of cross-server recall doesn't seem justified.
- **No auto-recall gating** I'm still debating this. Hindsight can produce useful memories even for short messages or even just "continue" (otherwise that turn will not have ephemeral injection), so I'm not sure it makes sense to avoid recall in these situations.

## Features inspired by anh-chu/pi-hindsight
- Storing recalls in the session file and showing them in collapseable blocks with custom message renderer, but optional and opt-in
- Removing specific tool types (e.g. `bash`), but more configurable
- Use subcommands to avoid cluttering global command list

# Tools
When `toolsEnabled: true` (default), the following tools are available for the agent:

| Tool | Description |
|------|-------------|
| `hindsight_retain` | Store information to long-term memory. Queues to disk and retains on next flush. Use for facts, preferences, decisions, or any information worth remembering. |
| `hindsight_recall` | Search long-term memory using multi-strategy retrieval. Supports filtering by tags, memory types (`world`/`experience`/`observation`), and budget. |
| `hindsight_reflect` | Generate a synthesized answer from long-term memory. Unlike recall which returns raw facts, reflect uses the bank's identity, mental models, and multi-step reasoning to produce a contextual markdown answer. Best for questions requiring synthesis of multiple memories. |

# Slash Commands
All commands are under `/hindsight <subcommand>`. With no subcommand, defaults to `status`.

| Subcommand | Description |
|------------|-------------|
| `flush` | Flush queued messages to Hindsight |
| `toggle-retain` | Toggle whether the current session should be retained |
| `tag <tag>` | Add a tag to the session's hindsight metadata |
| `remove-tag <tag>` | Remove a tag from the session's hindsight metadata |
| `toggle-display` | Toggle recall message visibility in UI |
| `popup` | Pop up last recalled messages in overlay |
| `queue-status` | Show count of queued messages |
| `status` | Show operational status (connection, session, recall info) |
| `config` | Show configuration (file path, env vars, masked config) |
| `parse-session` | Parse current session to file for manual review |
| `parse-and-upsert-session` | Parse and upsert the full current session to Hindsight |
| `upsert-all-parsed` | Upsert all parsed sessions to Hindsight |

> **Note:** After `/resume`, a new user message is required before `/hindsight popup` will show content, since recall only happens when there's a user message to query against.

# Recommended User Best Practices
- See the [model leaderboard](https://benchmarks.hindsight.vectorize.io/) for information on what models to use. I am currently using gemma 4 31b for retention/consolidation.
- Think about your [retain mission](https://hindsight.vectorize.io/developer/api/memory-banks#retain-configuration), [observations mission](https://hindsight.vectorize.io/developer/api/memory-banks#observations_mission), and [entity labels](https://hindsight.vectorize.io/developer/api/memory-banks#entity-labels) up front, as if you change these later and want them to affect old sessions, you will need to reingest everything.
- Remember that the recall prompt is constructed from the first part of your user message. For long prompts, consider putting any details or keywords you want memories for towards the beginning.
- Consider whether you want to keep tool calls and results. Including tool calls might be useful for remembering details about writes/edits (especially if you use pi for writing prose). Including tool result might be useful, for example, if you want to store memories about reads. You can always keep both and put more details about what should be ignored in your retain mission.

For the retain mission, you may want to experiment with including something like this to avoid retaining duplicate information that may end up in the LLM thinking or final output after recall/reflect:
- "Ignore resurfaced information that has already been stored or meta-commentary about it (unless the commentary is a new realization, surprise, correction, or new connection; in that case retain only the new commentary)"

# Caveats
- This plugin is still in flux and may have breaking changes
- Depending on your workflow with `/tree` and what you expect to be retained, this package may not play well (all new messages and session file content will be retained). Also see rewind/rollback information below
- Currently the only flush options are manual or on session event

# Known Package Interactions
## tintinweb pi-subagents
[pi-subagents](https://github.com/tintinweb/pi-subagents) does not affect the session file. This plugin is good to use for anything you *don't* want extracted except for the final output/summary (e.g. long web search dump).

## rewind/rollback
Rollback with checkpoint extensions is untested. It may require code changes to include rollback information/messages. I think it makes sense to include the rollback information in memories (what happened? why was it necessary?), so I won't support actually removing messages from before the rollback in the final ingested document.

## packages that also use pi.on("context")
Unknown. I'm not sure how this will interact with something like pi-headrom. It needs investigation.

# FAQ
## Why did you make this when there is already a pi-hindsight?
I made this before there were any other pi plugins. When I found the other pi-hindsight, there were features missing that I want and already had:

- Session file parsing with fork content deduplication to ingest old sessions
- Better automatic tagging
- JSON ingestion
- Disk queue
- More configuration options and can use both a config file and or for specific directories with mise or direnv

When I found it, it also did some strange things like:
- Using the API directly instead of the official typescript library
- Stripping `<hindsight_memories>` text blocks instead of just totally filtering out recall custom messages or using ephemeral injection in `pi.on("context")`

I also want to make 100% sure I have something following hindsight's best practices after seeing how many issues hermes' memory implementation had (e.g. recall one turn behind, deleting old memories, etc.). It looks like the other pi-hindsight plugin mostly follows best practices (at least is uses a stable document_id), but I want to continue to understand/control every part myself, so I will maintain my own, opinionated version.

I may try out other memory providers in the future, and in that case, I will also be able to extract a lot the code here into a shared library for dealing with message stripping and parsing old session files.

## Was this vibe coded?
The repo (excluding the documentation) was 100% written by AI but with manual review. The actual design/architecture is by me based on the documented hindsight best practices, github discussions with the hindsight author, and looking how multiple other memory systems are integrated in pi and other harnesses.

I went through many rounds of manual review and bug fixes for the initial code along with manual testing, especially for the session parsing, queuing, retention, and injection parts. This included manually reviewing that my parsed session and queue files were stripped correctly (and the duplicated head removed for forks) and retained with the correct tags, context, etc. I have reingested all my session files into hindsight multiple times as I've experimented with different retain/observation missions.

The commands to show the status, config, popup, and recall display in the UI (which I don't consider nearly as critical) were not thoroughly reviewed by me. I reviewed the initial config parsing code but have only briefly looked over the changes to it.

The automated tests have not been reviewed properly. I'm sure there are also bugs that I have not caught. Any feedback is welcome here, but one major advantage of this plugin is that **you can easily verify the queue and parsed session files are as expected yourself** before retention, and then you can verify that the documents and tags are as expected after retention. You can also verify for yourself that you are still getting cached reads.

Long term, I plan to focus on ensuring this extension is robust and bug-free (*more manual re-review is currently needed*). The primary reason I am making this extension myself is to make sure every aspect works correctly after finding issues with a lot of integrations for other memory systems or harnesses. Correctness matters too much for memory to not review the code (at least in the current month).
