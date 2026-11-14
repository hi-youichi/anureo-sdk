# history-frame-budget Capability

## ADDED Requirements

### Requirement: Oversized history items are capped at snapshot build time

Adapters SHALL cap oversized text and JSON content fields when building a history snapshot, and SHALL mark capped items with `extensions.historyTruncated` so consumers can distinguish truncated replay from short native content.

#### Scenario: A native history item carries a huge tool output

- **WHEN** a native history item contains a tool output whose serialized size exceeds the per-item ceiling
- **THEN** the snapshot stores a capped item with an in-band truncation marker, and the page carrying it never exceeds any transport frame limit

#### Scenario: A multi-byte text field exceeds the ceiling

- **WHEN** capped text contains multi-byte characters
- **THEN** capping respects UTF-8 byte boundaries and never splits the truncation marker

#### Scenario: An item is within the ceiling

- **WHEN** every field of a history item is within the ceiling
- **THEN** the item is passed through unchanged by reference without allocation

### Requirement: Public history pages are bounded by bytes and always progress

Adapters SHALL shrink requested history pages to a serialized byte budget while keeping at least one item per page, so cursor pagination always advances and no single page exceeds any transport hop.

#### Scenario: Large items force smaller pages

- **WHEN** a requested page of items exceeds the byte budget
- **THEN** the page carries fewer items than requested and `nextCursor` advances to the remaining items

#### Scenario: A single item exceeds the budget

- **WHEN** one capped item alone exceeds the byte budget
- **THEN** the page still carries that item so the cursor progresses

#### Scenario: Clients request a page

- **WHEN** a client requests history with a limit
- **THEN** the response is a prefix of the snapshot and continuation cursors keep their existing shape

### Requirement: Native history requests use bounded page sizes

Adapters SHALL request native paged history with a bounded page size (default 50) rather than an unbounded count, so a single native response frame stays within the transport limit even before capping.

#### Scenario: A session replays history

- **WHEN** an adapter fetches native history through paged methods
- **THEN** each native request carries the bounded page size, and a configured override replaces the default

### Requirement: The stdio transport tolerates large native frames

The Codex stdio JSONL transport SHALL default its maximum frame size to 64MiB, because a local pipe has no external frame ceiling and native paged responses legitimately exceed the previous 8MiB default.

#### Scenario: A native response exceeds 8MiB

- **WHEN** the native process returns a single response frame larger than 8MiB but smaller than 64MiB
- **THEN** the frame is delivered without a `FRAME_TOO_LARGE` failure and the adapter connection survives
