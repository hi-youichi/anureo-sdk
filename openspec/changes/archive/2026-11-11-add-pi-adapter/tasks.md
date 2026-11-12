## 1. Spike and package scaffold

- [x] 1.1 Write `packages/pi/scripts/spike.ts` (records one real run's normalized events under `protocol/<version>/`) and `scripts/fork-probe.ts` (offline check of Pi session-file branching). Verified: `bun scripts/fork-probe.ts` confirms branching keeps entry ids and yields a new resolvable session.
- [x] 1.2 Scaffold `packages/pi` (`package.json`, `tsconfig.json`) and add it to root devDependencies. Verified: `bun install --frozen-lockfile && bun run typecheck` pass.
- [x] 1.3 Record real event transcripts with `PI_SMOKE_MODEL=provider/id bun run spike` and pin them under `packages/pi/protocol/1.5.2/`. Verified: recorded with `zai/glm-5.3-flash` (bash tool call + final answer, 34 events ending in `settled`); `tests/replay.test.ts` replays it through the adapter; the file contains no credential.

## 2. Host seam and mapping

- [x] 2.1 Implement the `PiSessionHost` interface, the default implementation over `createAgentSession`, and a scripted fake host in `tests/`. Verified: `tests/mapping.test.ts` asserts only `host.ts` imports the Pi SDK at runtime; the default host opens a real in-memory session in `bun run smoke`.
- [x] 2.2 Implement `mapping.ts` (tool kinds, file changes, usage, turn errors, input, history, redaction). Verified: `tests/mapping.test.ts` passes.

## 3. Adapter core

- [x] 3.1 Implement event handling (single subscription owner, settled-based completion, teardown). Verified: adapter tests for run-end-then-retry, interrupted/failed/closed turns, and zero listeners after close.
- [x] 3.2 Implement `index.ts`: initialize, version profile and capabilities, open/resume/submit/interrupt/close. Verified: lifecycle, native-failure and resume tests in `tests/adapter.test.ts`.
- [x] 3.3 Implement steer/follow-up including extension-consumed (`handled`) input. Verified: steer, afterTurn and handled-input tests.

## 4. Session features

- [x] 4.1 Implement model and thinking-level config, catalog session, and invalid-value errors. Verified: config and catalog tests.
- [x] 4.2 Implement permission modes via tool allowlists and reject unsupported modes. Verified: read-only test asserts no bash/edit/write tool and that `agent` fails with `INVALID_PARAMS`.
- [x] 4.3 Implement history paging, fork and compaction. Verified: history, fork (before/through/empty/unknown) and compaction tests.
- [x] 4.4 Implement secret redaction for events, history and errors. Verified: redaction test and the native-error text test.

## 5. Conformance and wiring

- [x] 5.1 Run the shared `@anureo/conformance` suite and `runNativeConformance` against the fake host. Verified: `tests/conformance.test.ts` passes; not-applicable scenarios are exactly approval, userInput, elicitation, dynamicTool, steer, revert.
- [x] 5.2 Add package README (supported/unsupported capabilities, in-process trust model), root README adapter list, CHANGELOG entry. Verified: `bun run typecheck`, `bun run typecheck:tooling` and `bun test --timeout 15000 packages` (504 pass) at repo root.
- [x] 5.3 Add `scripts/smoke.ts` with an offline mode. Verified: `bun run smoke` opens a real in-memory Pi session, lists models and closes it without credentials.
- [x] 5.4 Run the live smoke with a real model. Verified with `zai/glm-5.3-flash`: `bun run smoke` returns `pong`; `bun scripts/live-check.ts` passes multi-turn context, history, fork (through), resume and interrupt on persisted sessions.
