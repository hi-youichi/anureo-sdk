# Changelog

All notable changes to the Anureo SDK will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [SemVer](https://semver.org/spec/v2.0.0.html). During the
0.x line, minor versions may include breaking changes; such entries are
marked **BREAKING**.

## [0.3.11] - 2026-11-23

- Hermes supports session model changes and reasoning effort through native,
  revision/generation-fenced mutations. Reasoning is available at creation and
  restored from native snapshots; unsupported gateways do not advertise it.
- Hermes accepts `outputBridge: false` to disable the optional ephemeral MCP
  structured-output bridge for native sessions that outlive their observers.
- Claude supports native turn steering and reports native aborts as interrupted.
- ACP preserves commentary while streaming and marks only the final agent
  message as final when a turn completes.
- Publish `@anureo/host`: persistent scoped sessions, model catalog caching,
  queues, interactions, SQLite storage, and embedded/standalone WebSocket access.
- Fix Windows workspace resolution in the bundled Hermes Node consumer test and
  wait for native reconciliation before asserting recovery completion.

## [0.3.10] - 2026-11-20

- The Claude adapter now supports `goal/set` and `goal/clear` through the CLI's
  native `/goal` command and advertises `goal: set, clear`. The CLI reports no
  goal events to SDK consumers, so the adapter tracks the goal itself: a finished
  or failed execution marks it `cleared`, an interrupted one leaves it `active`,
  and a resumed session starts without one. `goal/set` rejects with
  `SESSION_BUSY` while work is running or input is pending.
- The ACP adapter recognizes the provider-neutral goal extension (`_meta.goal`
  with `controlMethod`, for example anureo 0.7.7 and later) and maps its `set`
  and `clear` actions to `goal/set` and `goal/clear`. `session_info_update`
  `_meta.goal` snapshots now update the session goal and publish
  `session/state`. A goal method advertised through `_meta.ahp` still takes
  precedence.

## [0.3.9] - 2026-11-20

- Codex live events and history retain tool execution evidence, including exit
  codes, signals, explicit success values, and errors alongside partial MCP
  results. MCP tool items also expose allowlisted display labels, connector
  details, and widget resource identifiers.

## [0.3.8] - 2026-11-20

- Swarm members (temporary, fixed-profile and workflow bees) now inherit the
  swarm session's `config.permissionMode` in addition to the top-level
  `permissionMode`. The Codex, Claude and Pi adapters read the config value in
  preference to the top-level field, so a session opened with
  `config: { permissionMode: 'read-only' }` previously left members on the
  backend's default mode (`agent-full-access` for Pi). Other parent `config`
  keys are still not forwarded to members.
- `anureo` CLI workflow resume now reads the input from the source run's stored
  manifest (`run.json`) instead of passing the CLI prompt as args; a missing or
  unreadable manifest fails the run with `SWARM_WORKFLOW_RESUME_NOT_FOUND`.
- Publish `@anureo/adapter-swarm` to npm. It was marked private and left out of
  the release workflow, so `@anureo/cli` (which depends on it) could not be
  installed from the registry in 0.3.7.
- Bump `@anthropic-ai/claude-agent-sdk` to 0.3.328 in the Claude adapter.
- Codex adapter: spawned-subagent `thread/started` notifications that repeat the
  child's id in a top-level `threadId` were dropped by the thread-scope filter
  before reaching discovery, so no `SUBAGENT_THREAD_STARTED` notice was published
  and `listThreads()` lacked their nickname. Session-level hooks (no turn id)
  now publish `NATIVE_HOOK_STARTED`/`NATIVE_HOOK_COMPLETED` notices instead of
  a generic `NATIVE_NOTIFICATION`.
- Test-suite fixes that previously blocked the release workflow: align the Codex
  fake app server's `threads-page` scenario with relation-filtered queries,
  update the ACP model-open cleanup assertion to the documented `cleanupErrors`
  contract, and observe the pending workflow-pool acquire in its unit test so
  it no longer leaks an unhandled rejection.

## [0.3.7] - 2026-11-18

Merge the `fix/history-frame-budget` line into `main` and release the combined
SDK.

- Bound history reads by frame size so large sessions replay on every transport:
  the Codex stdio JSONL default `maxFrameBytes` rises from 8MiB to 64MiB, native
  history pages (`thread/items/list`, `thread/turns/list`) request a bounded
  `nativePageLimit` (default 50) instead of 200, oversized history item content
  is capped at snapshot build time (64KiB per field with an in-band marker and
  `extensions.historyTruncated`), and public history pages shrink to a
  serialized byte budget (`maxPageBytes`, default 4MiB) while always keeping at
  least one item so cursors progress. The Claude adapter applies the same
  capping and byte budgeting through new shared `@anureo/sdk` helpers
  (`historyItemBytes`, `pageEndWithinBudget`, `capItem`, `capHistoryEntry`).
  Previously a session whose 200-item native page exceeded 8MiB failed every
  open with `FRAME_TOO_LARGE`, killing the adapter connection and leaving the
  session permanently unrecoverable.
- Add client-scoped input hooks (`ClientOptions.hooks`): ordered input
  transformations, `beforeInput` gating with revised payloads, `beforeTool`
  policy, and `beforeStop` continuation decisions shared by every session on a
  client. Adapters receive optional native hook callbacks through
  `HarnessAdapter.openSession` (validated via `validateNativeHooks`), and
  interrupts and closes cancel pending hook work with definite outcome codes.
- Accept explicit `timeoutMs: null` on requests, submissions and closes to wait
  without a deadline; admission still rejects non-finite, non-positive and
  above-2_147_483_647 values.
- Claude adapter: subagent stream ownership (child items attribute to their
  spawning tool item, parent-loop text owns the final answer, subagent
  descendants stay out of host-visible turn text), late native completion
  evidence for tracked items, background-task notifications that open follow-up
  turns carrying `extensions.native.origin`, `toolExecution.success` evidence on
  matched tool results, and host-echoed fork boundaries resolved through the
  transcript prompt map.
- Codex adapter: Multi-Agent V2 subagent discovery (thread/started projection,
  thread metadata enrichment, direct-input capability degradation), singular
  collab wire-word mapping with per-agent outcome evidence, and classification
  of parent-owned subagent input denials as `SUBAGENT_DIRECT_INPUT_REJECTED`.
- Workflow: journaled calls record drop reason codes, tolerate SDK clients
  without `inputHookRevision` in the journal key, and reserve keys through a
  tracked preflight thunk so schema failures mark runs incomplete; unknown
  saved outcomes require `WORKFLOW_RECONCILIATION_REQUIRED` before re-dispatch.
- Hermes adapter rejects session instructions before any native mutation with a
  `session.instructions` capability detail.
- Add the `@anureo/cli` package (`anureo` bin): single-turn agent runs printing
  the unified AHP event stream for Codex, Claude, Hermes, Pi, ACP and Swarm.
- Harden swarm orchestration internals: per-bee module routing instructions are
  injected into swarm sessions and bee profiles are tracked in the repository.

## [0.3.2] - 2026-11-15

- **BREAKING** Workflow checkpoints now use format version 3. Runs created
  with format version 2 require a fresh run when upgrading.
- Harden session recovery across adapters by preserving native request outcomes,
  handling late messages during cleanup, and keeping sibling sessions usable.
- Improve workflow recovery by validating persisted records and preserving
  execution and cleanup failures in diagnostics.
- Strengthen isolated code-review and refactor checkouts, patch transfer,
  source-state validation, and failure reporting.
- Refine AHP schema generation and runtime validation.

## [0.3.1] - 2026-11-14

- Run refactor checks in isolated worktrees before transferring verified edits
  to the target. Transfer module edits in readiness order and checkpoint each
  module as it finishes.
- Consolidate workflow agent execution and checkpoint handling, and clarify the
  public workflow API guide.

## [0.3.0] - 2026-11-14

- Publish the Hermes and Pi adapters, workflow primitives, and the code-review
  and refactor CLI packages. Review and refactor run their editing agents in
  separate Git worktrees and integrate validated changes into the target tree.

- **BREAKING** Replace the explicit `run.step()` checkpoint API with an automatic
  agent-call journal. `WorkflowContext` now exposes only `runId` and `input`;
  every `agent()` call inside a `workflow()` body is checkpointed by a chained
  prompt-and-options key, and `resumeFrom` replays identical calls from
  `journal.json` without opening sessions. Run directories use checkpoint format
  version 2 with a single `journal.json` replacing `attempts/`, `checkpoints/`,
  `results/`, and `inherited/`; format-v1 directories are rejected on resume.
  `StepOptions` (`key`, `input`, `schema`, `recovery`, `reuse`) is removed along
  with `WORKFLOW_STEP_INCOMPLETE`; prior calls with unknown outcomes reject with
  `WORKFLOW_RECONCILIATION_REQUIRED`. `Client` now exposes a readonly `identity`.
  code-review migrates off `run.step`, embeds a git source-state fingerprint in
  every prompt so journaled results never go stale silently, and bumps its
  workflow revision to 5.

- Retain per-file unreadable paths and observation errors in repair JSON and Markdown.

- Publish readability repair reports after Client cleanup; retain successful findings
  alongside lifecycle failures and preserve report publication errors.

- Identify changed resume configuration in review progress without restoring old defaults.

- Retain structured call failure certainty, stop repair dispatch after interrupted
  file preparation, and drain fixture releases before cleaning temporary resources.

- Reject stale repair inputs and scopes without readable text, choose eligible repair
  group representatives, clean failed JSON write temporaries, and preserve BOM
  package entry resolution.

- Add optional workflow persistence: `workflow(options, body)` provides a durable
  run ID and explicit, schema-inferred `run.step()` checkpoints. Resume creates a
  new run, validates and imports compatible results, and preserves effective
  history across branches. Storage and unknown execution failures stop dispatch.
  Code-review persists accepted plans and task evidence independently of final
  reports; `--resume` can recover failed runs with an explicit backend configuration
  fingerprint. Add deterministic persistence and process-crash recovery examples/tests.
  Bound complete review tasks so checkpoints publish promptly; preserve UTF-8 BOM
  hashes and repository-aware evidence validation. Legacy report reuse requires
  matching backend provenance. Editing runs exclusively claim their output directories.
  Keep long call-chain navigation bounded while retaining exact source ranges.
  Validate duplicate roots before checkpoint/repair admission and compare restored
  findings by value, independent of JSON object key ordering. Keep cross-task
  grouping in the final summary so earlier task results cannot become hidden
  verification inputs during recovery. Compact unrelated consumer navigation in
  task prompts while retaining complete primary navigation and source snapshots.
  Centralize snapshot adoption, validate immutable source identities, and roll back
  provisional evidence when business validation rejects a restored result. Avoid
  resending identical source copies while preserving distinct versions and read history.

- Code-review repair reports expose `changesKnown`; uncertain native outcomes no
  longer display an empty change set as no changes. Keep bare-package import
  navigation candidates inside their package roots. Retain operation and cleanup
  causes together in CLI diagnostics.

- Add `@anureo/adapter-pi`, an in-process adapter for the Pi coding agent
  (`@earendil-works/pi-coding-agent`, verified against 1.5.2). Supports submit,
  steer/follow-up, interrupt, history, fork, resume and compaction, plus model,
  thinking-level and `read-only`/`agent-full-access` permission configuration.
  Pi has no approval gate, so permissions are enforced with tool allowlists and no
  interactions, revert, goal or review are advertised. Pi runs inside the host
  process with the host's credentials and file access; see the package README.

- **BREAKING:** workflow `agent` supports Zod object schemas and infers
  `z.output<S> | null`; text mode now returns `string | null`. Convert schemas to
  native JSON Schema before submission, validate raw JSON and the original Zod
  schema, and reject unsupported schema forms before creating a Session.
  Confirmed terminal authentication, usage/rate limit and service errors become
  `null`; startup/submission errors, unknown outcomes and other failures still
  reject. Never replay input; cleanup failure also rejects after a null candidate.
  Preserve optional interrupted reason metadata in SDK results for trusted
  adapters. Bundled adapters do not infer user skip or classifier denial.
- Claude adapter preserves typed terminal API error categories and HTTP status,
  distinguishes native execution limits from API failures, and never uses
  free-form error text for classification. Add a Zod workflow example for both
  native backends: `bun run example:workflow-schema all`.
- **BREAKING:** workflow `parallel` and `pipeline` now wait for every task/item
  to settle and return `null` at failed positions instead of rejecting the batch;
  inferred result types include `null`. Validate composition arguments before
  starting work. Pipeline stages receive `(prevResult, originalItem, index)`,
  await input values, and skip remaining stages on `null`. Allow zero stages;
  empty inputs return before stage validation. These composition semantics follow
  Claude Code 2.1.296 without introducing its VM or shared host controls.
- Claude adapter supports per-submit `outputSchema` through the native Agent
  SDK output format. Return validated JSON as final text, retain saved structured
  output in history, and switch formats only when the session has no active or
  pending inputs. Schema changes preserve the native session ID and configuration.
- Add `@anureo/workflow` with only three directly imported primitives: `agent`,
  `parallel`, and `pipeline`. Workflows are ordinary TypeScript functions;
  each agent owns a fresh Session and returns final text. Preserve typed task
  results, per-item stage sequencing, native failures, and session cleanup.
  Remove the unpublished runtime, MCP, profiles, source-string execution,
  shared scheduling, events, workspace management, `phase`, and `log` design.
  Include a scripted arithmetic example and clean Node/Bun package checks.
- Add `example:readability`: a normal TypeScript workflow using local Codex for
  two review perspectives and independent verification, with source citation/hash
  validation, explicit incomplete coverage, Markdown reports, and optional raw traces.

- **BREAKING:** revise AHP v1 in place through package root entries. Both
  initialization directions require `protocolContract: "native-lifecycle"`;
  incompatible old v1 peers are rejected before business dispatch. Remove
  experimental versioned entries and the second schema/validator contract.
- **BREAKING:** replace `createHarnessRuntime` / `startTurn` with `createClient`
  and `await session.submit()` returning a Turn. Replace wire `turn/start`
  with `input/submit`; request, input and execution identities are separate.
  No public Submission or mandatory accepted()/turn() chain remains.
- Exact `turn.steer()` returns void on native append confirmation. Declare
  input delivery and interrupt scopes explicitly. Claude native/afterTurn input
  maps to next/later, with fixed Agent SDK 0.3.265 and evidence-based merged
  execution association. Standard ACP retains serial input and session cancel.
- Separate observation disposal/close from execution-stop evidence; preserve
  independent observers, late results, bounded retention and source errors.
  Fix metadata merging, revert references, result patch projection, privacy,
  cleanup error aggregation and late notifications from closed AHP sources.
- Migrate examples, all adapter suites, conformance and clean Node/Bun packing
  checks; add `bun run example:dsh` driving `dsh --profile acp`. See the
  [design](docs/native-harness-lifecycle.md) and
  [local validation record](docs/development.md#native-lifecycle-v1).
- `@anureo/adapter-acp`: retain a bounded, redacted stderr tail and attach it to
  handshake and disconnect failures; map ACP `stopReason` explicitly so unknown
  reasons fail closed instead of reporting success; add `autoRespondPermission`
  for unattended hosts with auditable `ACP_PERMISSION_AUTO_ANSWERED` notices;
  resolve model aliases against the advertised enum before dispatch. Add
  `createDshAcpAdapter()` for `dsh --profile acp` plus a DSH-shaped wire fixture.

## [0.2.0] - 2026-10-30

First public npm release of the Anureo SDK under the `@anureo` scope.

- `@anureo/protocol` — Anureo Harness Protocol (AHP) v1: JSON Schema
  (`urn:anureo:ahp:v1`), generated TypeScript types, runtime validation
  (Ajv 8.20.0, draft 2020-12), version and capability negotiation.
- `@anureo/sdk` — runtime core: `createHarnessRuntime(adapter)` wraps any
  adapter behind `HarnessRuntime` / `HarnessSession`, enforcing turn and
  item lifecycle state machines, bounded event queues, interaction
  approvals, and secret redaction for events and histories.
- `@anureo/adapter-codex` — Codex CLI `app-server` adapter over stdio
  JSONL, with the native protocol schema vendored and hash-verified.
- `@anureo/adapter-claude` — adapter for the official Claude Agent SDK
  (0.3.257), including the `FileSessionStore` session persistence.
- `@anureo/adapter-acp` — adapter for standard Agent Client Protocol
  agents via the official `@agentclientprotocol/sdk` 1.4.0.
- `@anureo/adapter-ahp` — wire-level client for external harnesses that
  implement AHP themselves, over stdio or WebSocket.
- `@anureo/conformance` — shared conformance suite (lifecycle, approval,
  interrupt, history scenarios) and scripted fake backends that speak
  their real native wire protocols.

**BREAKING** (relative to the upstream internal `@cowork/harness-*` 0.1.0
packages this codebase was extracted from): package names, the `x-anureo/`
extension prefix, the `Ahp*` / `createAhpAdapter` naming, and the schema
`$id` changed; old-brand extension names are not compatible.

[0.3.9]: https://www.npmjs.com/package/@anureo/sdk/v/0.3.9
[0.3.8]: https://www.npmjs.com/package/@anureo/sdk/v/0.3.8
[0.3.7]: https://www.npmjs.com/package/@anureo/sdk/v/0.3.7
[0.3.2]: https://www.npmjs.com/package/@anureo/sdk/v/0.3.2
[0.3.1]: https://www.npmjs.com/package/@anureo/sdk/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/@anureo/sdk/v/0.3.0
[0.2.0]: https://github.com/hi-youichi/anureo-sdk/releases/tag/v0.2.0
