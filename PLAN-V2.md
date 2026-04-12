# pi-hindsight v2 Plan

## Overview

Simplified architecture leveraging Hindsight's new `update_mode='append'` capability for incremental retention without fork detection complexity.

## Key Changes from v1

| Aspect | v1 (Session File-Based) | v2 (Turn Queue + Append) |
|--------|-------------------------|--------------------------|
| Sync timing | session_shutdown/switch (full session) | Per-turn queue, flush on shutdown or manual |
| Fork handling | Complex responseId comparison, parent loading | Simple: each session = own document, append mode |
| State | Stateless (read from files) | Queue file only |
| Content building | Full session from .jsonl | Incremental turn-by-turn |
| Old sessions | N/A | Slash command to parse |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         pi agent                                 │
├─────────────────────────────────────────────────────────────────┤
│  message event     ──────▶  buildTurnContent()                  │
│                              │                                   │
│                              ▼                                   │
│                         queueTurn()                              │
│                              │                                   │
│                              ▼                                   │
│                    queues/session-{id}.queue.jsonl               │
│                                                                  │
│  session_shutdown  ──────▶  flushQueue()                        │
│  session_start (resume)     │                                   │
│  /hindsight-flush           ▼                                   │
│                         Hindsight API                            │
│                         (update_mode='append')                   │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
<getAgentDir()>/extensions/pi-hindsight/
├── pi-hindsight.json              # config file
├── queues/
│   └── session-{id}.queue.jsonl   # pending turns (one JSON per line)
└── parsed-sessions/
    └── {session-id}.jsonl         # stripped session (for manual review)
```

## Queue File Format

Each turn is a single JSON line containing one message object:

```jsonl
{"role":"user","content":[{"type":"text","text":"Hello"}],"timestamp":"2026-04-10T12:34:56.789Z"}
{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"timestamp":"2026-04-10T12:34:58.123Z"}
```

**Each line**: One message object with:
- `role`: "user" or "assistant" (or "toolResult" if configured)
- `content`: Array of content blocks (filtered by `retainContent` config)
- `timestamp`: When this message occurred

**All other retain fields derived at flush time**: document_id, context, tags come from current session + config.

## Flush Logic

```
async function flushQueue(sessionId, session, config):
  queuePath = getQueuePath(sessionId)

  if not exists(queuePath):
    return  // nothing to flush

  messages = readQueue(queuePath)  // line-by-line, skip malformed

  if messages is empty:
    delete queue file
    return

  // Derive retain fields at flush time
  retainPayload = messages.map(msg => ({
    content: JSON.stringify(msg),  // message object as JSON string
    document_id: sessionId,
    update_mode: 'append',
    context: truncate(config.hindsightContextPrefix + session.name, config.hindsightContextMaxLength),
    timestamp: session.startTime,
    tags: [
      ...config.constantTags,
      `session:${sessionId}`,
      `cwd:${session.cwd}`
    ],
  }))

  try:
    response = hindsight.retainBatch(bankId, retainPayload)

    if response success:
      delete queue file
      console.log(`Flushed ${messages.length} turns to Hindsight`)
    else:
      console.error(`Flush failed: ${response.error}`)
      // Queue remains on disk for retry

  } catch (error):
    console.error(`Flush failed: ${error.message}`)
    // Queue remains on disk for retry
```

**Queue file reading**: Parse line-by-line, skip malformed lines.

**Session info**: `session.name`, `session.startTime`, `session.cwd` from pi session context.

**Content format**: `content` field in retain payload = JSON string of message object. Message's internal `content` field = array of content blocks.

**Failure handling:**
- Retain fails → queue remains on disk, show error to user
- User can retry with `/hindsight-flush`
- On next session resume, auto-retry flush

## Turn Building

Queue messages as they occur:

```typescript
function queueTurn(
  message: Message,
  config: HindsightConfig,
  sessionId: string
): void {
  if (!shouldRetainMessage(message, config)) return;

  const stripped = prepareEntry(message, config);

  // Append single message object as JSON line
  appendToQueue(sessionId, JSON.stringify(stripped));
}
```

### Message Events to Queue

| Event | Action |
|-------|--------|
| `message` (role=user) | Queue the user message |
| `message` (role=assistant) | Queue the assistant response |
| `message` (role=toolResult) | Queue if `retainContent.toolResult` is non-empty |

## Shared Stripping Utility

Refactor existing `document.ts` logic into reusable functions:

```typescript
// src/prepare.ts

/**
 * Check if a message should be retained based on config.
 */
export function shouldRetainMessage(
  message: { role: string; content: unknown },
  config: HindsightConfig
): boolean {
  const role = message.role;
  if (role === 'user' || role === 'assistant') return true;
  if (role === 'toolResult') return config.retainContent.toolResult.length > 0;
  return false;
}

/**
 * Filter message content based on allowed types for the role.
 */
export function prepareEntryContent(
  content: unknown,
  role: string,
  retainContent: RetainContent
): unknown {
  if (!Array.isArray(content)) return content;

  const allowedTypes = retainContent[role as keyof RetainContent];
  if (!allowedTypes) return content;

  return content.filter(block =>
    block && typeof block === 'object' &&
    allowedTypes.includes((block as { type: string }).type as string)
  );
}

/**
 * Strip a message for retention.
 */
export function prepareEntry(
  message: { role: string; content: unknown; [key: string]: unknown },
  config: HindsightConfig
): object {
  return {
    ...message,
    content: prepareEntryContent(
      message.content,
      message.role,
      config.retainContent
    ),
  };
}
```

## Slash Commands

### `/hindsight-parse-session`

Parse the current session file and output stripped version for manual review.

```typescript
// Usage: /hindsight-parse-session
// Output: parsed-sessions/{session-id}.jsonl

function parseCurrentSession(config: HindsightConfig): void {
  const sessionPath = getCurrentSessionPath();
  const outputPath = getParsedSessionPath(sessionPath);

  // Use existing document.ts logic
  const { header, entries } = parseSessionFile(sessionPath);
  const stripped = entries
    .filter(e => e.type === 'message')
    .filter(e => shouldRetainMessage(e.message, config))
    .map(e => ({
      message: prepareEntry(e.message, config),
      timestamp: e.timestamp,
    }));

  // Write with full retain payload
  const output = {
    sessionId: header.id,
    documentId: header.id,
    tags: buildTags(header, config),
    content: JSON.stringify(stripped),
    timestamp: new Date().toISOString(),
  };

  writeFileSync(outputPath, JSON.stringify(output) + '\n');
  console.log(`Parsed session written to: ${outputPath}`);
}
```

### `/hindsight-upsert-parsed-session`

Upsert a parsed session file to Hindsight.

```typescript
// Usage: /hindsight-upsert-parsed-session [session-id]
// If no session-id, list available parsed sessions for selection

async function upsertParsedSession(sessionId?: string, config: HindsightConfig): Promise<void> {
  if (!sessionId) {
    const sessions = listParsedSessions();
    // prompt user to select
    sessionId = await promptUser(sessions);
  }

  const parsedPath = getParsedSessionPath(sessionId);
  const parsed = JSON.parse(readFileSync(parsedPath, 'utf-8'));

  const client = new HindsightClient({
    baseUrl: config.apiUrl,
    apiKey: config.apiKey,
  });

  await client.retain(config.bankId, parsed.content, {
    documentId: parsed.documentId,
    tags: parsed.tags,
    updateMode: 'append',
  });

  console.log(`Upserted session: ${sessionId}`);
}
```

### `/hindsight-flush`

Manually flush the current session's queue.

```typescript
// Usage: /hindsight-flush

async function flushCurrentSession(config: HindsightConfig): Promise<void> {
  const sessionId = getCurrentSessionId();
  await flushQueue(sessionId, config);
}
```

## Events

| Event | Handler |
|-------|---------|
| `message` | `queueTurn()` - build and queue turn content |
| `session_shutdown` | `flushQueue()` - send all pending turns |
| `session_start` | Check for existing queue, `flushQueue()` if found |
| `session_switch` | (removed - only flush on shutdown) |

**Session resume flow:**
1. On `session_start`, check if `queues/session-{id}.queue.jsonl` exists
2. If exists, attempt to flush
3. On success: queue deleted, session continues fresh
4. On failure: error shown, queue remains for next retry

## Config

```typescript
interface RetainContent {
  assistant: ("text" | "thinking" | "toolCall")[];
  user: ("text" | "image")[];
  toolResult: ("text")[];
}

interface StripConfig {
  topLevel: string[];   // Fields to strip from outside message object
  message: string[];     // Fields to strip from inside message object
}

interface HindsightConfig {
  apiUrl: string;
  apiKey: string;
  bankId: string;
  toolsEnabled: boolean;
  autoRecallEnabled: boolean;
  autoRecallBudget: "low" | "mid" | "high";
  autoRetainEnabled: boolean;
  hindsightContextPrefix: string;
  hindsightContextMaxLength: number;
  maxRecallTokens: number | null;
  recallPromptPreamble: string;
  recallMaxQueryChars: number;
  constantTags: string[];
  retainContent: RetainContent;
  strip: StripConfig;
}

// Default strip config
const DEFAULT_STRIP: StripConfig = {
  topLevel: ["type", "id", "parentId"],
  message: ["api", "provider", "model", "usage", "cost", "stopReason", "timestamp", "responseId"]
};
```

### Example: Keep tool results, strip toolCallId

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

### Config Semantics

| Config | Purpose | Scope |
|--------|---------|-------|
| `retainContent` | Filter content block types by role | Per-role (assistant, user, toolResult) |
| `strip` | Remove metadata fields | Same for all messages (checks if exists) |

Processing order:
1. Filter content blocks by `retainContent[role]`
2. Strip fields from top level by `strip.topLevel`
3. Strip fields from message by `strip.message`

## Implementation Plan

### Phase 1: Core Infrastructure
1. Create `src/prepare.ts` - shared stripping utilities (extract from document.ts)
2. Create `src/queue.ts` - queue file management (append, read with error recovery, delete)
3. Update `src/config.ts` - ensure all fields present

### Phase 2: Unit Tests
4. Unit tests for `prepare.ts`
5. Unit tests for `queue.ts`

### Phase 3: Turn Building & Events
6. Create `src/turn.ts` - build turn content from pi events
7. Create `src/commands/flush.ts` - needed for testing phase 3
8. Update `src/index.ts`:
   - Wire up `message` event → queueTurn
   - Wire up `session_shutdown` → flushQueue
   - Wire up `session_start` → check and flush existing queue
   - Register `/hindsight-flush` command

### Phase 4: Session Parsing Commands
9. Create `src/commands/parse-session.ts`
10. Create `src/commands/upsert-session.ts`
11. Register commands in `src/index.ts`

### Phase 5: Integration & Docs
12. Manual testing with real pi sessions
13. Update README with new architecture
14. Mark `document.ts` as legacy (keep for slash commands)

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Retain fails on shutdown | Queue remains, error shown to user |
| Retain fails on session resume | Queue remains, error shown, user can `/hindsight-flush` |
| Pi crashes | Queue on disk, flushed on next resume |
| Hindsight unavailable | Queue grows, flushed when available |
| Queue file corruption | Skip malformed lines on read (partial data loss) |
| Concurrent queue writes | Simple append; JSON lines are independent |

**No duplication risk**: Single flush attempt per trigger, queue cleared only on success.

**Partial batch failure**: Not handled - queue cleared only on full success. If partial failure occurs, queue remains and will retry all items (some duplicates). Acceptable given append mode semantics.

## Migration Notes

- **No migration needed**: New queue-based approach works alongside existing sessions
- **Old sessions**: Use `/hindsight-parse-session` to manually import
- **Config compatible**: Same config format works for v2

## Dependencies

- `@vectorize-io/hindsight-client@latest` (v0.5.0+ for `update_mode='append'`)
- Uses npm package (not fork)

## Future Enhancements (Out of Scope)

- Sent log for duplicate prevention
- Batch size configuration
- Queue age limits / cleanup
- Background flush retry with backoff
- Atomic writes (.tmp + rename)
