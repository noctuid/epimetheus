# Agent Instructions for pi-hindsight
- Use conventional commit messages, always include a scope
- Update CHANGELOG.md under the Pending section for any user-facing or internal changes
- Do not use import aliases unless there is genuine naming conflict
- The function that has enough context to produce the most accurate, non-duplicated user message should notify. Lower layers should return enough information to make that possible.

## Testing
- **No simulation tests**: Do not reimplement production logic in tests (e.g., copying filtering/transform logic into a test helper). This gives false confidence — the test passes even if the real code breaks. Instead, exercise the real handlers via integration tests (invoke handlers from `createMockPi()`, call `parseAndUpsertSession()`, etc.). See `tests/bootstrap.test.ts` for the pattern.
- **Test behavior, not implementation**: Test descriptions and assertions should describe observable behavior (e.g. "recall works on first message") not implementation details (e.g. "uses event.prompt").
- **Never modify the user's actual pi agent directory in tests**: Use `setupTempAgentDir()` from `fixtures.ts`. Use `makeCtx()` with an explicit session ID so queue/file operations target the test session.
- **Run `bun run ci` after completing tasks**
