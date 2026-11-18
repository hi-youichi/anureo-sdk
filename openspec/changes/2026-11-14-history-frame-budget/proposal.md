# Proposal: History frame budget

## Why

Staging could not reopen large sessions: a codex session whose native rollout reached 34.6MB produced a single `thread/items/list` response far above the 8MiB stdio frame limit (default `maxFrameBytes`), which killed the whole adapter connection (`FRAME_TOO_LARGE`), failed `history/read`, and left the product UI reporting the agent as unavailable. Pages were sliced by item count only (200 per page), so any session whose average item is large — or that contains one huge tool output — can exceed any frame limit on every page, permanently.

## What Changes

- Raise the stdio JSONL default frame limit from 8MiB to 64MiB: a local pipe has no external ceiling, and native paged history legitimately exceeds 8MiB.
- Cap oversized history item content at snapshot build time (64KiB per text/JSON field, in-band marker plus `extensions.historyTruncated`), mirroring the live execution-output cap, so no single item can outgrow any frame.
- Bound public history pages by serialized bytes (default 4MiB, at least one item per page) so every page survives all transport hops (8MiB AHP frames, 16MiB default WS receive limits).
- Reduce the native history page size from 200 to a configurable `nativePageLimit` (default 50) so one native response frame stays small even before capping.
- Apply the same byte budgeting and capping to the Claude adapter history read.

## Capabilities

### New Capabilities

- `history-frame-budget`: Byte-accounting guarantees for adapter history reads — snapshot-time item capping, byte-budgeted public pages that always progress, bounded native page sizes, and the stdio frame default.

### Modified Capabilities

(none - no existing specs under `openspec/specs/`)

## Impact

- `packages/core` gains `history-pages.ts` (shared measuring, budget shrinking and capping helpers) exported from `@anureo/sdk`.
- `packages/adapter/codex`: `jsonl.ts` default frame limit, `options.ts` new `nativePageLimit`/`maxPageBytes`, `session.ts` native paging, snapshot capping and page budgeting.
- `packages/adapter/claude`: history snapshot capping and page budgeting.
- Wire compatibility: unchanged — cursors, snapshot tokens and page semantics keep their existing shapes; clients may simply receive fewer items per page than requested.
- Consumers that relied on one page carrying up to 200 items must continue paginating via `nextCursor` (already required by the cursor protocol).
