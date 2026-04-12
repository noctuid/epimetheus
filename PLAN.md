# pi-hindsight Extension Plan

A pi extension that integrates Hindsight AI memory, following best practices for context, timestamp, and tag handling.

## Overview

This extension provides long-term memory capabilities for pi through Hindsight, a semantic memory system with fact extraction, multi-strategy retrieval (TEMPR), and observation consolidation.

### Key Features

- **Manual tools**: `hindsight_retain`, `hindsight_recall` for explicit LLM memory operations
- **Document sync**: Sync full session content on shutdown/switch events
- **Auto recall**: Synchronous recall before LLM call (same turn, includes user message)
- **Ephemeral recall injection**: Recall results injected via `context` event (not persisted, fresh each turn)
- **Configurable features**: Independent toggles for tools, auto-recall, and document sync
- **Fork-aware**: responseId-based divergence detection for forked sessions
- **Compaction-safe**: Only syncs original messages, ignores compaction summaries

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         pi-hindsight Extension                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │  Config Load │───▶│   Client     │───▶│   Hindsight  │          │
│  │  (env+file)  │    │   Init       │    │   API        │          │
│  └──────────────┘    └──────────────┘    └──────────────┘          │
│         │                                           │               │
│         ▼                                           ▼               │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Event Handlers                             │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  session_shutdown │ Sync current session before exit         │
│  │  session_switch   │ Sync previous session before switch       │
│  │  context          │ Auto-recall + inject results (ephemeral) │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Custom Tools                               │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  hindsight_retain  │ Store arbitrary content to memory         │  │
│  │  hindsight_recall  │ Search memories with filters              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Configuration

### Configuration Sources (Priority Order)

1. **Environment variables** (highest priority, override config file)
2. **Config file**: `<pi-agent-dir>/extensions/pi-hindsight.json` (default values)

> **Note**: The pi agent directory is obtained via `getAgentDir()`. The config file is located at `<pi-agent-dir>/extensions/pi-hindsight.json`. If the file doesn't exist, the extension uses defaults and logs a warning.
>
> **Missing API Key**: If no API key is provided (neither `HINDSIGHT_API_KEY` env var nor config file), the extension logs a warning, shows a UI notification, and disables all features until the key is configured.

### Config File Structure

Environment variables always override config file values. The config file provides defaults for convenience.

```json
{
  "apiUrl": "",  // Required - Hindsight API endpoint
  "apiKey": "",  // Required if HINDSIGHT_API_KEY env var not set
  "bankId": "pi-default",
  "toolsEnabled": true,
  "autoRecallEnabled": true,
  "autoRecallBudget": "mid",
  "autoRetainEnabled": true,
  "hindsightContextPrefix": "pi: ",
  "hindsightContextMaxLength": 100,
  "maxRecallTokens": null,
  "recallPromptPreamble": "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:",
  "recallMaxQueryChars": 800,
  "constantTags": ["harness:pi"]
}
```

### Environment Variables

Uses Hindsight's standard variables for API configuration. Pi-specific settings are prefixed with `PI_HINDSIGHT_`.

| Variable | Description | Default |
|----------|-------------|---------|
| `HINDSIGHT_API_URL` | Hindsight API endpoint | **None** - must be set |
| `HINDSIGHT_API_KEY` | API key | **None** - must be set |
| `PI_HINDSIGHT_BANK_ID` | Memory bank identifier | `pi-default` |
| `PI_HINDSIGHT_TOOLS_ENABLED` | Enable manual tools | `true` |
| `PI_HINDSIGHT_AUTO_RECALL_ENABLED` | Enable auto-recall | `true` |
| `PI_HINDSIGHT_AUTO_RECALL_BUDGET` | Recall budget (`low`/`mid`/`high`) | `mid` |
| `PI_HINDSIGHT_AUTO_RETAIN_ENABLED` | Enable auto-retain (document sync) | `true` |
| `PI_HINDSIGHT_CONTEXT_PREFIX` | Prefix prepended to truncated session title in Hindsight `context` field | `pi: ` |
| `PI_HINDSIGHT_CONTEXT_MAX_LENGTH` | Max session title length before truncation for Hindsight `context` field (0 = no limit) | `100` |
| `PI_HINDSIGHT_MAX_RECALL_TOKENS` | Max tokens for recall results (null = use Hindsight default) | `null` |
| `PI_HINDSIGHT_RECALL_PROMPT_PREAMBLE` | Preamble prepended to recall results | *(see config)* |
| `PI_HINDSIGHT_RECALL_MAX_QUERY_CHARS` | Max chars of user message used for recall query | `800` |
| `PI_HINDSIGHT_CONSTANT_TAGS` | JSON array of tags always included in retains | `["harness:pi"]` |

## Hindsight Best Practices Compliance

### Document Strategy

Hindsight's best practice recommends retaining the full conversation document for better fact extraction: "Always use the same ID for a growing conversation — retain the full conversation with each new message."

**Our approach:** Sync full session content at key events (not per-turn), reading directly from pi's session files.

### Sync Triggers

| Event | Description |
|-------|-------------|
| `session_shutdown` | Ctrl+C, Ctrl+D, SIGTERM - sync current session before exit |
| `session_switch` | User switches to different session - sync previous session first |

### Content Format

Documents are stored as JSON arrays (single line, no pretty-printing) preserving message structure:

```json
[
  {
    "message": {
      "role": "user",
      "content": [{"type": "text", "text": "bananas"}],
      "timestamp": 1775565375834
    },
    "timestamp": "2026-04-06T22:54:56.913Z"
  },
  {
    "message": {
      "role": "assistant",
      "content": [
        {"type": "thinking", "thinking": "..."},
        {"type": "text", "text": "..."}
      ],
      "responseId": "19a8f75d...",
      "timestamp": 1775565375834
    },
    "timestamp": "2026-04-06T22:54:59.428Z"
  }
]
```

**Includes:** `type="message"` with `role="user"` or `role="assistant"`
**Excludes:** `type="compaction"`, `type="branch_summary"`, `role="toolResult"`, `role="bashExecution"`, etc.

### Fork Detection via responseId

Forked sessions copy all messages from the parent, including original timestamps. We detect divergence by comparing `responseId` fields:

1. Load parent session file (path from `header.parentSession`)
2. Build `Set` of parent's assistant responseIds
3. Find first assistant message in current session whose `responseId` is NOT in parent
4. Include that assistant message + the previous user message + everything after

**Edge cases:**

| Case | Handling |
|------|----------|
| Not a fork (no `parentSession`) | Include all conversation messages |
| Fork before first response (parent has no responseIds) | Include all - first response is new |
| No new responseIds in current session | Empty document (nothing to retain) |
| Parent session file missing | Disable sync, show UI warning |
| Fork from aborted turn | Works - fork from previous user message, that response already in parent |

### Implementation

```typescript
function buildDocumentContent(sessionPath: string): {
  content: string,  // JSON string
  documentId: string,
  warning?: string
} {
  const { header, entries } = parseSessionFile(sessionPath);

  // Check parentSession BEFORE filtering
  if (header.parentSession) {
    try {
      const parentResponseIds = loadParentResponseIds(header.parentSession);
      return buildForkedContent(entries, header, parentResponseIds);
    } catch (e) {
      return {
        content: "[]",
        documentId: `session:${header.id}`,
        warning: `Parent session not found: ${header.parentSession}`
      };
    }
  }

  // Not a fork - include all conversation messages
  const conversationEntries = entries.filter(isConversationMessage);
  return {
    content: JSON.stringify(conversationEntries.map(formatEntry)),
    documentId: `session:${header.id}`
  };
}

function buildForkedContent(
  entries: SessionEntry[],
  header: SessionHeader,
  parentResponseIds: Set<string>
): { content: string; documentId: string } {
  const conversationEntries = entries.filter(isConversationMessage);

  // Find first assistant with responseId NOT in parent
  const forkPoint = conversationEntries.findIndex(e =>
    e.message.role === "assistant" &&
    e.message.responseId &&
    !parentResponseIds.has(e.message.responseId)
  );

  if (forkPoint === -1) {
    // No new responses - nothing to retain
    return { content: "[]", documentId: `session:${header.id}` };
  }

  // Walk backward in conversationEntries to find the previous user message
  let userMsgIndex = -1;
  for (let i = forkPoint - 1; i >= 0; i--) {
    if (conversationEntries[i].message.role === "user") {
      userMsgIndex = i;
      break;
    }
  }

  const startIndex = userMsgIndex === -1 ? forkPoint : userMsgIndex;
  return {
    content: JSON.stringify(conversationEntries.slice(startIndex).map(formatEntry)),
    documentId: `session:${header.id}`
  };
}

function loadParentResponseIds(parentPath: string): Set<string> {
  const { entries } = parseSessionFile(parentPath);
  const responseIds = new Set<string>();
  for (const e of entries) {
    if (e.type === "message" &&
        e.message.role === "assistant" &&
        e.message.responseId) {
      responseIds.add(e.message.responseId);
    }
  }
  return responseIds;
}

function isConversationMessage(e: SessionEntry): boolean {
  return e.type === "message" &&
    (e.message.role === "user" || e.message.role === "assistant");
}

function formatEntry(e: SessionEntry): object {
  return {
    message: e.message,  // role, content, responseId, timestamp
    timestamp: e.timestamp  // ISO string from entry
  };
}
```

### Why This Works

| Concern | Resolution |
|---------|------------|
| Fork duplicates | Each session only includes its new content; `parent:` tag links lineage |
| Compaction | Ignored - we only include `type="message"` |
| Crash before sync | Resync on next event - session files are source of truth |
| Recall misses recent turns | Recall is for cross-session memory, not same-session |
| Adding existing sessions | Just trigger sync - reads session files directly |

## Tool Specifications

### `hindsight_retain` Tool

Store information to long-term memory.

**Parameters:**
```typescript
{
  // Required
  content: string,           // The information to store

  // Optional
  tags?: string[],           // Tags for filtering (e.g., ["topic:billing", "priority:high"])
  metadata?: Record<string, unknown>  // Additional context for fact extraction
}
```

**Auto-filled by plugin:**
- `bank_id`: From config
- `timestamp`: Current ISO 8601 timestamp
- `context`: Truncated session title with prefix
- `tags`: Combines `constant_tags` + `["session:<session-id>", "store_method:tool"]`

**LLM-facing description:**
> Store information to long-term memory. Hindsight automatically extracts structured facts, resolves entities, and indexes for retrieval. Use this for facts, preferences, decisions, or any information worth remembering for future sessions.
>
> **Tags** are useful for filtering memories during recall. Use namespaced tags like `topic:billing` or `priority:high`.
>
> **Metadata** is included in the fact extraction prompt (improving accuracy) and returned with recalled memories, useful for client-side filtering or linking back to sources.

**Return value:**
```typescript
// Success
{ success: true }

// Error
{ success: false, error: "<error type>", message: "<full message>" }
```

### `hindsight_recall` Tool

Search long-term memory using multi-strategy retrieval.

**Parameters:**
```typescript
{
  // Required
  query: string,             // What to search for

  // Optional
  tags?: string[],           // Filter by tags (e.g., ["user:alice", "topic:billing"])
  tags_match?: "any" | "all" | "any_strict" | "all_strict",  // Default: "any"
  tag_groups?: TagGroup[],   // Complex tag filtering (AND-ed with tags/tags_match)
  types?: ("world" | "experience" | "observation")[],  // Filter by memory type
  budget?: "low" | "mid" | "high"  // Retrieval thoroughness (default: "mid")
}
```

**Auto-filled by plugin:**
- `bank_id`: From config
- `query_timestamp`: Current timestamp
- `max_tokens`: From config (or omitted if not set)

**Tag Filtering Explanation (for LLM):**
> Tags filter memories at retrieval time. A memory tagged `user:alice` is only returned when `tags=["user:alice"]` is specified. Use `tags_match="any_strict"` for strict user isolation.
>
> `tag_groups` and `tags`/`tags_match` can be used simultaneously — they are AND-ed together. Use `tag_groups` for complex boolean filters.

**Memory Types Explanation (for LLM):**
> - `world`: General knowledge, external facts (e.g., "The Eiffel Tower is in Paris")
> - `experience`: Personal events, user-specific facts (e.g., "User prefers dark mode")
> - `observation`: Consolidated patterns synthesized from facts (e.g., "User consistently prefers async communication")

**Return value:**
```typescript
// Success with results
{
  success: true,
  results: [{
    id: "<fact-id>",
    text: "<memory text>",
    type: "world" | "experience" | "observation",
    context: "<context-label>" | null,
    metadata: { ... } | null,
    tags: ["..."] | null,
    entities: ["..."] | null,
    occurred_start: "<iso8601>" | null,
    occurred_end: "<iso8601>" | null,
    mentioned_at: "<iso8601>",
    document_id: "<doc-id>",
    chunk_id: "<chunk-id>" | null,
    source_fact_ids: ["..."] | null  // observation type only
  }, ...],
  source_facts: { "<fact-id>": {...} } | undefined,
  chunks: { "<chunk-id>": { id, text, chunk_index, truncated } } | undefined,
  entities: { "<name>": { entity_id, canonical_name, observations } } | undefined,
  trace: { ... } | undefined
}

// Success, no results
{ success: true, results: [] }

// Error
{ success: false, error: "<error type>", message: "<full message>" }
```

## Error Handling

### API Timeouts

All Hindsight API calls have built-in timeouts:
- **Recall**: 10 second timeout (synchronous, must not block indefinitely)
- **Retain**: 30 second timeout (background, more lenient)

### Error Responses

On API failure, tools return:
```typescript
{ success: false, error: "<error type>", message: "<full message>" }
```

### Manual Tools vs Auto Operations

**Manual tools** (`hindsight_retain`, `hindsight_recall`):
- On failure: Return error to LLM, let it decide whether to retry
- No automatic retry
- LLM sees full error message and can make informed decision

**Auto operations** (auto-recall, document sync):
- Auto-recall failure: Log warning, show UI notification, continue without memory context
- Document sync failure: Log warning, show UI notification, retry once with 2s backoff, then give up
- On timeout: Show UI notification ("Hindsight memory <operation> timed out")

### Graceful Degradation

- If config is invalid on startup: Log warning, show UI notification, disable plugin features
- On interrupt (`ctx.signal`): Cancel in-flight API calls, clean up resources

## Ephemeral Recall Injection

Recall results are injected **ephemerally** in the `context` event - no state between events needed.

### Implementation

```typescript
pi.on("context", async (event, ctx) => {
  if (!autoRecallEnabled) return;

  // Extract user message from the messages array
  const userMessage = extractLastUserMessage(event.messages);
  if (!userMessage) return;

  // Truncate query to max chars
  const query = userMessage.slice(0, config.recallMaxQueryChars);

  // Recall synchronously with timeout and cancellation support
  const results = await client.recall(query, {
    signal: ctx.signal,
    timeout: 10000
  });

  if (results) {
    // Prepend preamble to recall results
    const content = `${config.recallPromptPreamble}\n\n${results}`;
    const recallMessage = {
      role: "user",
      content: [{ type: "text", text: `<hindsight-memory source="auto-recall">
${content}
</hindsight-memory>` }]
    };
    return { messages: [recallMessage, ...event.messages] };
  }
});
```

**Why `context` event:**
- Fires right before LLM call - recall results available immediately
- `event.messages` is a deep copy - modifications don't pollute session
- Single handler - no state management between events
- `ctx.signal` available for cancellation

**Why ephemeral injection:**
1. **Preserves prompt caching**: System prompt unchanged
2. **No user intent pollution**: User message unmodified
3. **Not persisted**: Recall results don't bloat session file
4. **Fresh each turn**: Each turn gets new recall based on current user message
5. **No stale context**: Previous recall results don't pollute future turns

**Recall query context:** Auto-recall uses the **current user message** as query context (truncated to `recallMaxQueryChars`). This ensures the most relevant memories are retrieved based on what the user is asking right now.

### State

**No persistent state needed.** All session data is read directly from session files at sync time.

**Retrieved on demand:**
- **sessionId**: `ctx.sessionManager.getSessionId()`
- **sessionFile**: `ctx.sessionManager.getSessionFile()`
- **parentSession**: `ctx.sessionManager.getHeader().parentSession`

## Event Flow

### Auto-Recall Flow (Synchronous)

```
User input received
       │
       ▼
┌─────────────────┐
│ context event   │  ← Recall + inject in one handler
└─────────────────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│ Extract user │────▶│ Recall API   │  ← Synchronous with timeout
│ message       │     │ call         │
└──────────────┘     └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ Inject result │  ← Prepend to messages
                     │ as ephemeral  │
                     └──────────────┘
                            │
                            ▼
                      Agent runs with
                      recall context
```

### Document Sync Flow (Background)

```
Sync event triggered
(session_shutdown, session_switch)
       │
       ▼
┌─────────────────────┐
│ Read session file   │
└─────────────────────┘
       │
       ▼
┌─────────────────────┐     ┌──────────────────┐
│ Check parentSession │────▶│ Load parent     │  ← If forked
│ in header           │     │ responseIds     │
└─────────────────────┘     └──────────────────┘
       │                            │
       ▼                            ▼
┌─────────────────────┐     ┌──────────────────┐
│ Filter entries:     │     │ Find first      │
│ type=message,       │     │ responseId NOT  │
│ role=user/assistant │     │ in parent       │
└─────────────────────┘     └──────────────────┘
       │                            │
       └────────────┬───────────────┘
                    ▼
           ┌────────────────┐
           │ Build JSON     │
           │ document       │
           └────────────────┘
                    │
                    ▼
           ┌────────────────┐
           │ Retain API     │  ← Background (non-blocking)
           │ call           │
           └────────────────┘
                    │
                    ▼
              Memory updated
```

## File Structure

```
pi-hindsight/
├── README.md              # User documentation
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript config
├── src/
│   ├── index.ts           # Entry point, exports default extension function
│   │                      # - Registers tools, event handlers
│   │                      # - Handles session_switch, session_shutdown, context
│   ├── config.ts          # export loadConfig(): HindsightConfig
│   ├── client.ts          # export HindsightClient wrapper with timeout handling
│   ├── tools.ts           # export registerTools(pi, config)
│   ├── injection.ts       # export formatRecallMessage(results): Message
│   └── document.ts        # export buildDocumentContent(sessionPath): DocumentContent
└── TODO.md                 # Future enhancements
```

## Dependencies

```json
{
  "dependencies": {
    "@vectorize-io/hindsight-client": "^0.4.22"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.x",
    "@sinclair/typebox": "^0.34.x"
  }
}
```

## Implementation Tasks

### Phase 1: Core Infrastructure
- [ ] Set up TypeScript project with bun (`bun init`, tsconfig.json)
- [ ] Add `@vectorize-io/hindsight-client` dependency
- [ ] Implement `config.ts`: Load from `<getAgentDir()>/extensions/pi-hindsight.json`, override with `HINDSIGHT_*` and `PI_HINDSIGHT_*` env vars. If file missing, use defaults + log warning.
- [ ] Implement `client.ts`: Create Hindsight client wrapper with 10s recall timeout, 30s retain timeout, abort signal support
- [ ] On `session_start`: Validate config (show UI notification and disable if invalid)

### Phase 2: Manual Tools
- [ ] Implement `hindsight_retain` in `tools.ts`: Accept content, optional tags, optional metadata; auto-fill bank_id, timestamp, context, tags
- [ ] Implement `hindsight_recall` in `tools.ts`: Accept query, optional tags/tags_match/tag_groups/types/budget; auto-fill bank_id, query_timestamp, max_tokens
- [ ] Register tools conditionally based on `toolsEnabled` config

### Phase 3: Auto-Recall
- [ ] On `context` event (when `autoRecallEnabled`): Extract last user message from `event.messages`
- [ ] Truncate query to `recallMaxQueryChars` chars
- [ ] Call recall API synchronously with 10s timeout and `ctx.signal`
- [ ] If recall returned results, prepend preamble + recall message to `event.messages` and return modified array
- [ ] Handle recall errors gracefully: log warning, show UI notification, return unmodified messages
- [ ] Handle rate limiting (429): Show UI notification, don't retry

### Phase 4: Document Sync
- [ ] Implement `document.ts`: `parseSessionFile()`, `loadParentResponseIds()`, `buildDocumentContent()`
- [ ] On `session_shutdown`: Sync current session to Hindsight (if `autoRetainEnabled`)
- [ ] On `session_switch`: Sync previous session (via `event.previousSessionFile`) before switching
- [ ] Handle parent session missing: return empty + warning, show UI notification
- [ ] Build tags: `[...constantTags, "session:<id>", "parent:<id>"]` (parent = sessionId if not forked)
- [ ] Auto-fill: timestamp (session start), context (truncated session title + prefix)
- [ ] Handle retain errors: log warning, show UI notification, retry once with 2s backoff
- [ ] Handle rate limiting (429): Log warning, show UI notification, don't retry

### Phase 5: Polish
- [ ] Add error notifications for startup config validation failures
- [ ] Test: config loading, manual tool calls, auto-recall injection, document sync, fork detection, parent session missing
- [ ] Add README documentation

## References

- [Hindsight Best Practices](https://hindsight.vectorize.io/best-practices)
- [Hindsight API Documentation](https://hindsight.vectorize.io/developer/api/quickstart)
- [Hindsight TypeScript Client](https://npm.im/@vectorize-io/hindsight-client)
- [Pi Extensions Documentation](https://github.com/badlogic/pi-mono/blob/main/docs/extensions.md)
- [Pi Session Management](https://github.com/badlogic/pi-mono/blob/main/docs/session.md)
