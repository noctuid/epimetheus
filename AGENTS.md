# Agent Instructions for pi-hindsight

## Runtime vs Parsing Parity

Keep runtime logic (`src/index.ts` event handlers) and parsing logic (`src/document.ts` `isConversationMessage()`, `src/prepare.ts`) consistent:
- If runtime filters a message type from context, parsing should also filter it from stored content
- If runtime transforms message content, parsing should apply the same transformation
- When adding filtering: update both runtime (`src/index.ts` `pi.on("context", ...)`) and parsing (`src/document.ts` `isConversationMessage()`)
- Test both paths, including forked sessions

## Testing

- **No simulation tests**: Do not reimplement production logic in tests (e.g., copying filtering/transform logic into a test helper). This gives false confidence — the test passes even if the real code breaks. Instead, exercise the real handlers via integration tests (invoke handlers from `createMockPi()`, call `parseAndUpsertSession()`, etc.). See `tests/bootstrap.test.ts` for the pattern.
- **Test behavior, not implementation**: Test descriptions and assertions should describe observable behavior (e.g. "recall works on first message") not implementation details (e.g. "uses event.prompt").
- **Run `bun run ci` after completing tasks**
