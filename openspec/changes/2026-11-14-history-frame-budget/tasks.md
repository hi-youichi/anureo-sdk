# Tasks: History frame budget

## 1. Shared helpers (core)

- [x] 1.1 Add `history-pages.ts` with `historyItemBytes`, `pageEndWithinBudget`, `capItem`, `capHistoryEntry`, and budget constants exported from `@anureo/sdk`.
- [x] 1.2 Cover CJK byte boundaries, JSON stubs, reference stability and the one-item floor with unit tests (`history-pages.test.ts`).

## 2. Codex adapter

- [x] 2.1 Raise the stdio default `maxFrameBytes` from 8MiB to 64MiB with an updated doc comment.
- [x] 2.2 Add `nativePageLimit` (default 50) and `maxPageBytes` (default 4MiB) adapter options.
- [x] 2.3 Use the option for `thread/items/list` and `thread/turns/list` native page sizes.
- [x] 2.4 Cap items when building history snapshots and shrink public pages by bytes in `readHistory`.
- [x] 2.5 Extend `fake-app-server.mjs` with an `oversized-history` scenario and add integration tests: capping, page budgeting with cursor progress, native page size on the wire, and option overrides.

## 3. Claude adapter

- [x] 3.1 Cap history snapshot items and byte-budget public pages using the shared core helpers.

## 4. Verification

- [x] 4.1 `bun run typecheck` passes across all 12 packages.
- [x] 4.2 `bun test packages/core packages/adapter/codex packages/adapter/claude` — 289 pass; the 4 remaining failures are pre-existing on clean `main` (two `correlates joined submissions` process tests, one Windows-only `fileURLToPath` input-mapping test, one load-flaky reconciliation test) and are unrelated to this change.

Verified: integration test proves a 34.6MB-scale replay (two 160KiB outputs + one message) paginates under a 96KiB budget with capped 64KiB items, cursor progress across pages, and a single native fetch of 50-item pages.
