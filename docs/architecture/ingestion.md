# Ingestion Architecture

This document explains epimetheus' ingestion architecture: how session content, explicit tool retains, and metadata move from Pi session state into Hindsight. For config/readiness behavior, see [Config Architecture](config.md).

## Goals

The ingestion system is designed around these constraints:

- **No lost work**: new messages or tool retains created during a flush must remain queued for a later flush.
- **Idempotent retries**: crash recovery and repeated flushes should converge on the same Hindsight documents instead of duplicating content.
- **Portable filesystem coordination**: queue coordination should avoid OS-specific locks and avoid third-party lockfile libraries.
- **Authoritative session files**: Pi session JSONL files remain the source of truth for conversation content and session metadata.
- **Fast common checks**: live session state may be used for guard checks; parsed-session artifacts are derived data used for review/export, not as a flush authority.

The design aims to handle unlikely edge cases (process crashes, concurrent flushers, partial writes) correctly without being completely overkill. Some tradeoffs accept rare duplicate work over complex coordination — for example, two flushers may both upsert the same session, but no work is ever silently lost.

## Data sources

epimetheus ingests two kinds of data.

### Session content

Normal conversation content is stored in Pi session JSONL files. epimetheus does not persist a second copy of every message in its queue. Instead, it records small pending markers saying that a session should be reparsed.

On every session flush, epimetheus reparses the Pi session JSONL file for conversation messages and structural identity, then upserts with a stable session document ID. The on-disk `.messages.jsonl` file is not a normal flush cache; it is a review/export artifact written by `/hindsight parse-session` and normal flushes.

### Explicit tool retains

The `hindsight_retain` tool stores explicit user/model observations. These are not recoverable from the session file alone, so each tool retain is written as a self-contained queue entry.

A tool entry snapshots the session-specific context needed to flush later, such as session ID, parent session ID, session tags, document ID/idempotency key, update mode, content, and observation scopes.

## Queue layout

Queue files are organized per session and per queue type:

```text
queue/
  <session-id>/
    pending/
      <pending-marker-id>.json
      .inflight/
        <claim-id>/
          .claim.json
          <pending-marker-id>.json

    tool/
      <tool-entry-id>.json
      .inflight/
        <claim-id>/
          .claim.json
          <tool-entry-id>.json
```

### Pending markers

A pending marker is a tiny work marker:

```json
{
  "id": "...",
  "sessionId": "...",
  "createdAt": "...",
  "reason": "message_end"
}
```

It does not contain the session content or metadata. It only means:

> This session may need to be reparsed and upserted.

Multiple pending markers are used so flushers can distinguish work they claimed from new work that arrives during a flush. A flush only clears the markers it claimed. Any marker created while the flush is running remains in `pending/` and is handled later.

This can allow two racing flushers to both upsert the same session if they claim different pending markers. That is acceptable because session upserts use stable document IDs and are intended to be idempotent. The priority is preventing lost work.

### Tool entries

Tool queue entries are self-contained JSON files. Unlike pending markers, they contain the actual retain content and the session-specific metadata needed to flush later.

Tool entries should have stable document IDs or idempotency keys so recovery and retries do not create duplicate Hindsight documents.

## Claiming work

Queue coordination uses atomic file renames rather than a global lock.

A flusher creates a claim directory under the relevant `.inflight/` directory and writes claim metadata:

```json
{
  "claimId": "...",
  "sessionId": "...",
  "queue": "pending",
  "pid": 12345,
  "hostname": "...",
  "startedAt": "..."
}
```

It then claims files by renaming them into the claim directory:

```text
pending/<id>.json -> pending/.inflight/<claim-id>/<id>.json
tool/<id>.json    -> tool/.inflight/<claim-id>/<id>.json
```

If another flusher claimed a file first, the rename may fail with `ENOENT`; that is treated as a normal race and skipped.

Renames must stay within the same queue root/filesystem. Destinations should not be overwritten; UUID-style filenames make collisions effectively impossible.

## Flushing sessions

Session flushing follows this high-level flow:

1. Recover abandoned pending claims for the session.
2. Run fast guard checks from `session-state/<session-id>.json` when that live state is present and current.
3. Claim current pending markers by renaming them into `pending/.inflight/<claim-id>/`.
4. If no markers were claimed, there is no session work to flush.
5. Parse the Pi session JSONL file for conversation messages, structural identity, and the latest `hindsight-meta` entry.
6. Apply retention and extra-context guard checks using metadata derived from the freshly parsed session file; update live session state from the parsed metadata for future fast checks.
7. Combine parsed message data, header-derived structural identity, user-controlled metadata, and config/env-derived metadata.
8. Upsert the session document to Hindsight with replace/idempotent semantics.
9. Write parsed-session files (`.messages.jsonl` for review/export and `.meta.json` for session metadata).
10. Delete the claim directory and claimed pending markers.

If new messages or metadata changes happen during steps 5-9, they create new pending markers in `pending/`. Those markers are outside the active claim and survive for a future flush.

If the flush fails, claimed pending markers are moved back to `pending/` so the session can be retried.

## Flushing tool retains

Tool flushing follows the same claim pattern:

1. Recover abandoned tool claims for the session.
2. Claim current tool entry files by renaming them into `tool/.inflight/<claim-id>/`.
3. Read claimed tool entries.
4. Send them to Hindsight.
5. On success, delete the claim directory and claimed files.
6. On failure, move claimed files back to `tool/`.

New tool retains written during the flush remain in `tool/` and are not affected by the active claim.

## Inflight recovery

Inflight claims are temporary. They can remain on disk if a process exits or crashes mid-flush.

Recovery scans:

```text
queue/<session-id>/pending/.inflight/*
queue/<session-id>/tool/.inflight/*
```

A claim is considered abandoned when one of these is true:

- the claim metadata identifies a same-host PID that is no longer alive;
- the claim is older than a conservative timeout;
- the claim metadata is missing or invalid and the claim is old enough.

Recovery restores abandoned files back to the live queue directory:

```text
pending/.inflight/<claim-id>/*.json -> pending/*.json
tool/.inflight/<claim-id>/*.json    -> tool/*.json
```

The `.claim.json` file is metadata and is not restored as work. After restoration, the empty claim directory is removed.

Recovery never deletes live files in `pending/` or `tool/`.

## Session metadata, live state, and parsed files

Session metadata has three distinct storage layers. Keeping these roles separate avoids treating parsed artifacts as live state.

### Pi session metadata

Pi session JSONL files contain `hindsight-meta` custom entries. These entries are the portable source of truth for user-controlled session metadata:

- retention enabled/disabled state
- session-scoped user tags
- extra context for extraction caveats

Normal session flushes always parse the Pi session file before upserting conversation content. The actual Hindsight upsert is built from that parse, so the next real flush reflects the latest `/name` entry, latest `hindsight-meta` entry, and current config.

Changing `/name` does not create pending work by itself. If another change later causes a flush, the newly parsed session name is used then.

### Live session state file

Fast guard checks use a small operational state file, separate from parsed-session artifacts:

```text
session-state/<session-id>.json
```

The live state contains only metadata needed to decide whether pending session work can proceed without parsing a large session file:

```ts
interface SessionStateFile {
  retained: boolean;
  extraContext: string | null;
  updatedAt: string;
}
```

`extraContext` uses three states:

- `null`: the user has not made an extra-context choice;
- `""`: the user explicitly said no extra context is needed;
- non-empty string: user-provided extraction caveats.

The live state intentionally does not store session user tags, session title, full Hindsight context, or structural identity. Those values are not needed for fast blocking checks.

Metadata-changing commands and tools should:

1. append a new `hindsight-meta` entry to the Pi session;
2. update the live session state when `retained` or `extraContext` changes;
3. create a new pending marker when the change affects retained output, such as tags or extra context.

If the live state file is missing or invalid, normal flush falls back to parsing the session file and deriving the guard metadata from `hindsight-meta`. After a successful parse, the live state can be rewritten from the parsed session metadata.

### Parsed-session artifacts

Parsed-session files are review/export artifacts, not live state. `/hindsight parse-session` / `parseCurrentSession()` should not create or mutate live session state because doing so is unnecessary for parse-only review/export; live state is updated by metadata mutations and flush/upsert paths.

Message content is stored in:

```text
parsed-sessions/<session-id>.messages.jsonl
```

Parsed metadata is stored in:

```text
parsed-sessions/<session-id>.meta.json
```

`.messages.jsonl` is for user review/export. Normal session flushes must not read `.messages.jsonl` as the conversation source; they must reparse the Pi session JSONL file for conversation messages, then rewrite `.messages.jsonl` after a successful parse/upsert.

`.meta.json` is a parsed artifact manifest written alongside `.messages.jsonl` for human review/export and debugging. It snapshots the parsed inputs (session name, extra context, user tags, parent, cwd, timestamp, retention) but is not an upsert authority and is not used to replay upserts. Metadata mutations such as `session_start`, `/hindsight toggle-retain`, tags, or extra-context updates do not patch `.meta.json`; the artifact may remain stale until the next parse/flush rewrites it together with `.messages.jsonl`.

It stores:

```ts
interface ParsedSessionMetaFile {
  sessionId: string;
  sessionName: string;
  extraContext: string | null;
  sessionUserTags?: string[];
  parentSessionId?: string;
  sessionCwd: string;
  sessionTimestamp: string;
  messageCount: number;
  retained: boolean;
}
```

The `sessionId` stored in `.meta.json` is the Pi session id. The Hindsight document id for a session document is derived from this session id at upsert time (`documentId === sessionId`). Tool queue entries are the exception: they snapshot their own stable `document_id` (`tool:<sessionId>:<uuid>`) so explicit tool retains remain idempotent across recovery and retries.

It should not store a baked full Hindsight `context` string. Context is derived at upsert time from the current config prefix plus the stored/parsed session name and extra context:

```ts
buildContextFromSessionName(config.hindsightContextPrefix, sessionName, extraContext ?? undefined)
```

This means config prefix changes are reflected by normal flushes. For normal flushes, `sessionName` comes from the freshly parsed session file.

### Metadata derived at upsert time

Config/env-derived ingestion metadata is rebuilt whenever an upsert happens instead of being treated as stored state:

- final Hindsight context from current `hindsightContextPrefix`, session name, and extra context;
- constant tags from current config;
- structural tags such as `session:<id>`, `cwd:<path>`, `basedir:<name>`, `store_method:auto`, and `parent:<id>`;
- project tag/name, resolved for the target session at flush time: project-local flush config `projectName` when required/present, otherwise git common-dir basename or cwd basename;
- observation scopes from current config, with placeholders expanded using the session ID, parent session ID, session cwd, basedir, and project name;
- entities from current config.

Normal flush gets session-specific metadata from the freshly parsed session file, with the live state used only for fast guard checks. Tool queue entries are different: they are self-contained and snapshot the tags, observation scopes, document ID, and session context needed to flush later.

### Incremental parsed session building

Currently there is no incremental parsed session building — each normal session flush re-parses the full session file. Incremental building (appending only new messages to the review artifacts) may be considered later if speed becomes an issue, but correctness is the priority: any ingested data must be in the correct canonical order. Incrementally appended messages could be out of order relative to the full session, which would require unnecessary rechunking when a subsequent full-parse upsert corrects the order. Full-parse-then-replace avoids this.

## Parsed-session file writes

Parsed-session files should be written with atomic replace:

1. write a temporary file in the same directory;
2. rename the temporary file to the final path.

Readers then see either the old complete file or the new complete file, not a partially written file.

Concurrent parsed-session file writes are treated as last-writer-wins. This is acceptable because writes are atomic and metadata updates are user initiated and rare.

## Important invariants

- Pending markers are work markers, not content stores.
- Tool entries are content stores and must be self-contained.
- Claimed work lives only under `.inflight/<claim-id>/`.
- Success deletes only claimed files.
- Failure restores only claimed files.
- New work created during a flush stays in the live queue directory.
- Normal session flushes always reparse the Pi session JSONL file for conversation messages and structural identity.
- `.messages.jsonl` is a review/export artifact, not a normal flush cache.
- Live session state is used only for fast guard checks; if it is missing or invalid, normal flush falls back to parsing the session file.
- `.meta.json` is a parsed artifact manifest for review, not normal-flush live state.
- Config/env-derived metadata is rebuilt at upsert time.
- Sessions whose loaded metadata has retention disabled must not be ingested.
- When `requireExtraContextBeforeFlush` is enabled, sessions without explicitly set extra context must not be ingested.
- The extra-context flush guard applies to session ingestion, not tool queue flushing; tool retains are explicit observations and use their self-contained queue entries.
