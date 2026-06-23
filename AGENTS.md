# General Instructions
- Use conventional commit messages, always include a scope
- Prefer keeping commit subjects under ~50 chars and body lines at ~72 chars; commitlint enforces 72/72
- Update CHANGELOG.md under the Pending section for any user-facing or internal changes. Since changes land on a feature branch before main, describe fixes relative to main — do not include fixes to issues that were never on main in the changelog.
- Do not use import aliases unless there is genuine naming conflict
- The function that has enough context to produce the most accurate, non-duplicated user message should notify. Lower layers should return enough information to make that possible.
- Update the ToC when adding new documentation headings
- When adding `/hindsight` subcommands, add any command that does non-diagnostic or non-setup network work to `OPERATIONAL_SUBCOMMANDS` (so it's blocked until healthy startup)

# Testing
- **No simulation tests**: Do not reimplement production logic in tests (e.g., copying filtering/transform logic into a test helper). This gives false confidence — the test passes even if the real code breaks. Instead, exercise the real handlers via integration tests (invoke handlers from `createMockPi()`, call `parseAndUpsertSession()`, etc.). See `tests/bootstrap.test.ts` for the pattern.
- **Test behavior, not implementation**: Test descriptions and assertions should describe observable behavior (e.g. "recall works on first message") not implementation details (e.g. "uses event.prompt").
- **Never modify the user's actual pi agent directory in tests**: Use `setupTempAgentDir()` from `fixtures.ts`. Use `makeCtx()` with an explicit session ID so queue/file operations target the test session.
- **Run `bun run ci` after completing tasks**
