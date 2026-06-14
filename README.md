# About
A pi extension for [Hindsight](https://hindsight.vectorize.io/) AI memory.

Status: I would call this beta level software, though I am focusing on stability and am unlikely to make breaking changes at this point. Please report any issues. I am using this daily without problems.

# Table of Contents
- [Key Features](#key-features)
  - [Retain Memories](#retain-memories)
  - [Auto-Recall Memories](#auto-recall-memories)
  - [Reflect](#reflect)
- [Philosophy](#philosophy)
- [Local Quickstart](#local-quickstart)
- [Configuration](#configuration)
  - [Example Configuration](#example-configuration)
- [Recommended User Best Practices](#recommended-user-best-practices)
- [Caveats](#caveats)
- [FAQ](#faq)

See [Reference](docs/reference.md) for detailed configuration, tools, commands, and operational details.
See [Comparison](docs/comparison.md) for how this plugin compares to others and the design decisions behind it.

# Key Features
Both ambient retain/recall and manual retain/recall tools are enabled by default. Either can be disabled. See [Comparison with Other Implementations](docs/comparison.md) and [Design Decisions](docs/comparison.md#design-decisions) for more information on what differentiates this plugin.

## Retain Memories
- Automatically retains session content on session switch, shutdown, etc.
- Also supports ingesting past sessions - any session that has ever existed can be synced to Hindsight, not just sessions that had the extension loaded

## Auto-Recall Memories
When enabled, relevant memories are automatically recalled before each LLM call. Recall is injected as the configured role (`user` or `assistant`) with content wrapped in `<hindsight_memories>` fences.

There are two modes:
1. Ephemerally inject memories (default) — not stored in session file, can only see most recent recall via `/hindsight popup`
2. Store memories in session file — allows displaying collapsible blocks with all past recall

For mode tradeoffs, cleanup options, and all auto-recall settings, see [Auto-Recall Settings](docs/reference.md#auto-recall-settings) and [autoRecallPersist Tradeoffs](docs/reference.md#autorecallpersist-tradeoffs).

## Reflect
Unlike recall which returns raw matching memories, reflect uses the bank's reflect mission, disposition, and multi-step reasoning to produce a synthesized answer. Best for questions requiring synthesis of multiple memories or deeper analysis. Available as the `hindsight_reflect` tool (see [Tools](docs/reference.md#tools)).

Example reflect queries:
- "What are the user's development preferences?"
- "What architectural decisions have been made for this project?"
- "Summarize what went wrong with the last deployment"

You can set up [mental models](https://hindsight.vectorize.io/developer/api/mental-models) — cached reflect queries that can optionally automatically update when new observations come in — for common reflect queries. You can also use a pi prompt file to seed useful reflect queries at any point during a session.

# Philosophy
Follow [hindsight best practices](https://hindsight.vectorize.io/best-practices):
- Retains messages as JSON, which hindsight can intelligently chunk
- Retains all data for the same session with the same `document_id`
- Uses manually set session name (preserved as-is) or truncated first message as `context` field
- Sets the `timestamp` field

Additionally:
- Recalls memories for the current user prompt, unlike [hermes which is currently one turn behind](https://github.com/NousResearch/hermes-agent/issues/5820)
- Supports ingesting past sessions — any session that has ever existed can be synced to Hindsight, not just sessions that had the extension loaded.
- Avoids breaking prompt caching - recall messages are appended at the end of the context for a single turn only; the canonical conversation history (which determines cache validity) grows normally with each turn, so caching should work as expected
- Marks sessions as dirty on `message_end` so content is retained even if Hindsight is temporarily down; pending markers persist until the next successful flush
- Properly handles forking when ingesting full sessions: forks will not duplicate parent content and will only contain new content
- Provides automatic tags: session id, parent session id, cwd, basedir (cwd basename), project (configurable name, falls back to basedir), store method (tool or auto), and any configured tags like `harness:pi` (default)
- Allows choosing what content to retain and stripping unnecessary fields to reduce tokens/cost

# Local Quickstart
It is recommended to use the latest version of hindsight or >= `v0.6.2`.

If you want to run hindsight on your own server or using [hindsight cloud](https://ui.hindsight.vectorize.io/signup), ignore the hindsight-embed commands.

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
# increase if you want to prevent splitting larger messages between chunks (see user recommendations below for more info)
HINDSIGHT_API_RETAIN_STRUCTURED_CHUNK_SIZE=<size>
# hindsight has many other configuration variables, see the documentation for all of them
```

You can customize your retain, observation, and reflect missions in the UI (as well as other settings). See also [Recommended User Best Practices](#recommended-user-best-practices). It is recommended you read over these *early on* to avoid needing to reingest data later after changing settings (but that is always a possibility if you need to).

Create `~/.pi/agent/extensions/pi-hindsight/config.jsonc` — see the [Example Configuration](#example-configuration) below.

# Configuration
Configuration is stored in `<getAgentDir()>/extensions/pi-hindsight/config.json` or `config.jsonc` (JSONC has precedence). See the [Reference](docs/reference.md) for detailed documentation of all settings.

## Example Configuration
```jsonc
{
  "apiUrl": "http://127.0.0.1:9100",
  // for local hindsight without a key can set to anything
  "apiKey": "your-api-key",
  "bankId": "default",
  // add a user tag so you can scope observations across all your sessions;
  // replace <me> with your name/identifier
  "constantTags": ["harness:pi", "user:<me>"],
  // disable recall tool; auto-recall covers most use cases and reflect is more useful for
  // manual queries requiring detailed synthesized information
  "toolsEnabled": ["retain", "reflect"],
  // remove thinking from assistant messages to reduce tokens/cost (default includes "thinking")
  "retainContent": {
    "assistant": ["text", "toolCall"],
    "user": ["text"],
    "toolResult": ["text"]
  },
  // store recalls in session file and show collapsible blocks; see autoRecallPersist Tradeoffs in docs/reference.md!
  "autoRecallPersist": true,
  "autoRecallDisplay": true,
  // "autoRecallRole": "assistant",  // use if your provider allows non-user last message and you want memories injected as assistant
  // if you want to reduce injected memory tokens (hindsight default: 4096, high: 8192)
  // see https://hindsight.vectorize.io/developer/retrieval#max-tokens-context-window-size
  "maxRecallTokens": 2048,
  // required; see observationScopes section in docs/reference.md for details
  "observationScopes": [
    ["user:<me>"],  // global observations across all your sessions
    ["{project}"]    // project-specific observations
    // ["{session}"]  // per-session observations; only include if you continuously resume the same session
  ],
  // scope auto-recall to global observations by default;
  // switch to ["{project}"] if you want project-scoped recall instead
  "autoRecallTags": ["user:<me>"],
  // don't include untagged memories
  "autoRecallTagsMatch": "any_strict",
  // require extra context to be set before flushing prevents accidental retention
  // of fiction or content not about the user that could be misclassified by extraction
  // "requireExtraContextBeforeFlush": true,
}
```

# Recommended User Best Practices
## Initially
- See the [model leaderboard](https://benchmarks.hindsight.vectorize.io/) for information on what models to use. I am currently using gemma 4 31b for retention/consolidation.
- Think about your [retain mission](https://hindsight.vectorize.io/developer/api/memory-banks#retain-configuration), [observations mission](https://hindsight.vectorize.io/developer/api/memory-banks#observations_mission), and [entity labels](https://hindsight.vectorize.io/developer/api/memory-banks#entity-labels) up front. While the hindsight defaults are good for general use cases, you may want to be more specific, and if you change these later and want them to affect old sessions, you will need to reingest everything.
- Configure your [observation scopes](docs/reference.md#observationscopes) to control how observations are consolidated across sessions.
- Consider whether you want to ingest tool calls and results. Including tool calls might be useful for remembering details about writes/edits (especially if you use pi for writing prose). Including tool results might be useful, for example, if you want to store memories about reads. You can always keep both and put more details about what should be ignored in your retain mission.
- Consider whether you want to ingest assistant thinking or just the final output
- Consider increasing `HINDSIGHT_API_RETAIN_STRUCTURED_CHUNK_SIZE` depending on your model. This is not the normal chunk size — it controls splitting single JSON entry (which is normally kept together even if larger than the normal chunk size). Increasing this will ensure larger messages have memories extracted together so timestamps, user vs. assistant role, filenames from read/write tool calls, etc. are in context. Avoid setting it too high. You can look at context benchmarks for your specific model if you are unsure, e.g. [contextarena](contextarena.ai).
- If you are getting incorrect memories extracted (e.g. other people conflated with the user), consider [setting extra context](docs/reference.md#extra-context--flush-guard) for sessions; this is especially useful for non-programming sessions

Example - For the retain mission, you may want to experiment with including something like this to avoid retaining duplicate information that may end up in the LLM thinking or final output after recall/reflect:
- "Ignore resurfaced information that has already been stored or meta-commentary about it (unless the commentary is a new realization, surprise, correction, or new connection; in that case retain only the new commentary)"

## Later
- Remember that the recall prompt is constructed from the first part of your user message. For long prompts, consider putting any details or keywords you want memories for towards the beginning.
- Set up [mental models](https://hindsight.vectorize.io/developer/api/mental-models) for common reflect queries
- Consider your [bank disposition](https://hindsight.vectorize.io/developer/reflect#disposition-shapes-reasoning) for reflect

# Caveats
- While breaking changes are unlikely, this plugin is still in flux and the config API may evolve
- Depending on your workflow with `/tree` and what you expect to be retained, this package may not play well (all new messages and session file content will be retained, not just the current tree branch). Also see [rewind/rollback information in Known Package Interactions](docs/reference.md#rewindrollback).
- Flush options are manual, or automatic on session switch, shutdown, compact (see `flushOnCompact` in [Reference](docs/reference.md)), etc.

# FAQ
## Why did you make this when there is already a pi-hindsight?

See [Comparison with Other Implementations](docs/comparison.md) for a detailed feature comparison and [Design Decisions](docs/comparison.md#design-decisions) for the reasoning behind this plugin's approach.

I made this before there were any other pi plugins. When I found [anh-chu/pi-hindsight](https://github.com/anh-chu/pi-hindsight), there were features missing that I want and already had:

- Session file parsing with fork content deduplication to ingest old sessions
- Better automatic tagging
- JSON ingestion
- Disk queue
- More configuration options and can use both a config file and/or environment variables for specific directories with mise or direnv

When I found it, it also did some strange things like:
- Using the API directly instead of the official typescript library
- Stripping `<hindsight_memories>` text blocks instead of just totally filtering out recall custom messages or using ephemeral injection in `pi.on("context")`

I also want to make 100% sure I have something following hindsight's best practices after seeing how many issues hermes' memory implementation had (e.g. recall one turn behind, deleting old memories, etc.). It looks like anh-chu/pi-hindsight mostly follows best practices (at least it uses a stable document_id), but I want to continue to understand/control every part myself, so I will maintain my own, opinionated version.

I may try out other memory providers in the future, and in that case, I will also be able to extract a lot the code here into a shared library for dealing with message stripping and parsing old session files.

## Was this vibe coded?
Partially. The repo (excluding the documentation) was 100% written by AI but with manual review. The actual design/architecture is by me based on the documented hindsight best practices, GitHub discussions with the hindsight author, and looking how multiple other memory systems are integrated in pi and other harnesses.

I went through many rounds of manual review and bug fixes for the initial code along with manual testing, especially for the session parsing, queuing, retention, and injection parts. This included manually reviewing that my parsed session and queue files were stripped correctly (and the duplicated head removed for forks) and retained with the correct tags, context, etc. I have reingested all my session files into hindsight multiple times as I've experimented with different retain/observation missions.

The commands to show the status, config, popup, and recall display in the UI (which I don't consider nearly as critical) were not thoroughly reviewed by me. I reviewed the initial config parsing code but have only briefly looked over the changes to it. That code is very vibed.

The automated tests have not been reviewed properly. I'm sure there are also bugs that I have not caught. Any feedback is welcome here, but one major advantage of this plugin is that **you can easily verify the queue and parsed session files are as expected yourself** before retention, and then you can verify that the documents and tags are as expected after retention. You can also verify for yourself that you are still getting cached reads.

Long term, I plan to focus on ensuring this extension is robust and bug-free (*more manual re-review is currently needed*). The primary reason I am making this extension myself is to make sure every aspect works correctly after finding issues with a lot of integrations for other memory systems or harnesses. Correctness matters too much for memory to not review the code (at least in the current month).
