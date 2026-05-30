# Comparison

How pi-hindsight compares to other Hindsight integrations and the design decisions behind it.

# Table of Contents
- [Deviations from Official Integrations](#deviations-from-official-integrations)
- [Comparison with Other Implementations](#comparison-with-other-implementations)
  - [Feature Comparison](#feature-comparison)
  - [Design Decisions](#design-decisions)
- [Features inspired by anh-chu/pi-hindsight](#features-inspired-by-anh-chupi-hindsight)

# Deviations from Official Integrations

The official Hindsight integrations make some different default choices:

- **Recall types**: The OpenClaw integration defaults to recalling `world` and `experience` types (excluding verbose observation entries by default, per the OpenClaw integration README). This plugin defaults to `observation` only, since observations are deduplicated consolidated information. You can try either approach — set `autoRecallTypes` to `["world", "experience"]`, `["observation"]`, or `null` (all types) depending on what works best for your use case.

- **hindsight-embed setup**: This plugin does not automatically set up or manage [hindsight-embed](https://github.com/vectorize-io/hindsight-embed). You need to create profiles, banks, and configure hindsight-embed yourself before using this plugin. See [Local Quickstart](../README.md#local-quickstart) for setup instructions.

# Comparison with Other Implementations

There are multiple other Hindsight integrations for Pi:

1. **[anh-chu/pi-hindsight](https://github.com/anh-chu/pi-hindsight)** — Simple auto-retain/recall
2. **[pi-less-shitty/packages/hindsight](https://github.com/pi-less-shitty/pi-less-shitty)** — Domain-aware with multi-bank support
3. **[@walodayeet/hindsight-pi](https://github.com/walodayeet/pi-hindsight)** — Feature-rich with multi-bank, linked hosts, reflective recall
4. **[@luxusai/pi-hindsight](https://github.com/luxus/pi-hindsight)**

## Feature Comparison

Note: I do not plan on spending time keeping this updated or adding comparisons with new plugins. I recommend you look at the documentation for the other plugins and decide for yourself. For a brief comparison with `@luxusai/pi-hindsight`: I made [improvement suggestions](https://github.com/luxus/pi-hindsight/commit/3deb058ecfa8d1f49e217de8102300ee25f2a526) to the author that I believe have been implemented where the author agreed they made sense. I think the main remaining design difference worth pointing out is the luxus extension is oriented towards a combination of per-project banks and a global bank that I do not agree with. See [Design Decisions](#design-decisions) for more information.

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
| Configurable recall tag filtering | ✅ | ❌ | ❌ | ❌ |
| Custom message renderer | ✅ | ✅ | ✅ | ✅ |
| Cached context (anti-pattern) | ❌ | ❌ | ❌ | ✅⁵ |
| Linked host recall (multiple servers) | ❌ | ❌ | ❌ | ✅⁶ |
| **Retain** |
| Rich automatic tagging (session, cwd, basedir, project, parent) | ✅ | ❌ | ❌ | ✅ |
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
- **Use a disk queue in case hindsight is down and to delay retention** There is intentionally no "retain every N turns" functionality currently. You generally will not need memories available for an in-progress session. You can flush on compact or manually flush in cases where you do.
- **Use as much automatic tagging as possible**
- **Use the official TypeScript client library over raw HTTP requests** Using `@vectorize-io/hindsight-client` ensures correct API usage, type safety, and automatic compatibility with Hindsight API changes.
- **Keep tools simple and descriptions brief** Offer only the useful arguments and prevent token bloat. For example, advanced `tag_groups` support is provided for user-set auto-recall filtering but not tool recall. Make an issue if you have a use case for this (I personally disable the recall tool entirely and only use auto-recall and reflect).
- **No hashtag extraction or `#nomem` opt-out.** These features require parsing user prompts for control tags, which has edge cases with markdown headings. `#nomem` also does not make sense to me for a turn, since any information in that turn could still be referenced in later turns and retained then, and this would complicate reingesting full sessions later. It makes more sense to disable retention on a per-session basis (via `/hindsight toggle-retain`). Same for tags: it makes more sense to have a dedicated command (`/hindsight tag`) for manually adding tags to the document for the current session.
- **No hard truncation or client-side text chunking.** Hindsight chunks content internally and handles large documents gracefully. Arbitrary truncation risks losing useful information. Client-side chunking (as done by hindsight-pi) is unnecessary since Hindsight already handles this.
- **No support for bank creation/management or functionality that hindsight already provides** This is only for pi integration. Do bank creation and setup directly with e.g. `hindsight-embed` and hindsight's UI. This extension does not provide a document deletion capability. Do that yourself in the UI or with the cli if needed.
- **No project-local configuration files** Use environment variables with mise/direnv for directory-specific config (more flexible and less complex implementation). Note that anh-chu and pi-less-shitty do support `.hindsight/config` in CWD / parent traversal.
- **No bundling of the hindsight skills** I like to use as few skills and instructions as necessary and have not found these necessary. Automatic store/recall does almost all of the work, and I've  found the tool descriptions give enough information for the rest. If needed, the user should obtain the up-to-date skills files from the hindsight repo.
- **No cached recall context.** Recall is fast and should be queried fresh each turn based on the current user prompt. Caching recall results (as done by hindsight-pi) is an anti-pattern: it serves stale or irrelevant results when the user's query changes between turns, defeats the purpose of query-dependent recall, and adds unnecessary complexity (TTL management, background refresh, pinning). Each turn should recall based on the actual current user message.
- **No linked host recall (multiple servers).** This feature allows recalling from multiple Hindsight server instances simultaneously. I can't think of a use case for this — a single Hindsight instance with tags or multiple banks already handles project separation, and the added latency and configuration complexity of cross-server recall doesn't seem justified.
- **No auto-recall gating** I'm still debating this. Hindsight can produce useful memories even for short messages or even just "continue" (otherwise that turn will not have ephemeral injection), so I'm not sure it makes sense to avoid recall in these situations.
- **No per-project or per-agent banks by default.** This extension's design is optimized for having one or only a couple banks (e.g. separate banks for totally separate classes of work like writing vs. programming or for work vs. hobby programming). Hindsight does not recommend a per-agent bank approach: ["Having multiple banks goes against the spirit of sharing information between agents and should only really be used to total isolation of tasks."](https://github.com/vectorize-io/hindsight/discussions/1576#discussioncomment-16922281). Observation scopes and tag-based recall filtering provide project-specific or agent-specific memory without the complexity or additional overhead of separate banks. A single bank with proper tagging can scope both retention (via tags and `observationScopes`) and recall (via `autoRecallTags`) per-project or per-agent while still supporting cross-project/global observations — something separate banks cannot do. Separate banks would require managing multiple bank connections, duplicating configuration, and would prevent recalling global context (like user preferences) alongside project-specific memories. See [Project-specific Recall and Storage](reference.md#project-specific-recall-and-storage) for the recommended single-bank approach for separating memories for different projects.
- **No interactive setup** I think hindsight already makes setup simple enough, and I think if any improvements do need to be made, they would better be part of the harness-agnostic hindsight cli.

## Features inspired by anh-chu/pi-hindsight
- Storing recalls in the session file and showing them in collapsible blocks with custom message renderer, but optional and opt-in
- Removing specific tool types (e.g. `bash`), but more configurable
- Use subcommands to avoid cluttering global command list
