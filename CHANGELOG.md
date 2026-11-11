# Changelog

All notable changes to the Anureo SDK will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [SemVer](https://semver.org/spec/v2.0.0.html). During the
0.x line, minor versions may include breaking changes; such entries are
marked **BREAKING**.

## Unreleased

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

[0.2.0]: https://github.com/hi-youichi/anureo-sdk/releases/tag/v0.2.0
