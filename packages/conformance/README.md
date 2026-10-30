# @anureo/conformance

The shared conformance suite for the Anureo SDK. It drives any `HarnessAdapter` through the public runtime API and verifies the behavioral contract that AHP implies — so "implements AHP" has a concrete, repeatable meaning: pass the suite, and every host built on the SDK can use your backend.

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/conformance`.

## Running a backend through the suite

Implement a `ConformanceFactory` — one driver per scenario — and hand it to `runConformance`:

```typescript
import { runConformance, createScriptedAdapter, type ConformanceFactory } from '@anureo/conformance'

const factory: ConformanceFactory = (scenario) => ({
  adapter: createScriptedAdapter(),       // your adapter here
  openParams: {
    requestId: 'open', mode: 'new', cwd: process.cwd(),
    binding: { sessionId: 'conformance', adapterId: 'scripted', runtimeConfigId: 'test' },
  },
  expectedText: 'conformance',
})

const report = await runConformance(factory, { timeoutMs: 3000 })
if (!report.passed) {
  for (const entry of report.cases) console.log(entry.scenario, entry.status, entry.message)
}
```

Each case returns `passed`, `failed`, or `not-applicable`:

- A scenario is **not-applicable** when its capability was not declared at initialization (e.g. `steer` for a backend without `turn.steer`).
- A **declared** capability must actually pass its scenario — a missing fixture is a failure, not a skip. Declaring fork without a working fork is exactly the bug this suite exists to catch.

## Scenarios

`lifecycle`, `immediate`, `identity`, `approval`, `userInput`, `elicitation`, `dynamicTool`, `interrupt`, `steer`, `fork`, `revert`, `history`, `unknown-item`, `disconnect`, `backpressure`.

The scenario list is the shared acceptance scope, not a claim that every protocol capability has exhaustive coverage. All four adapters in this workspace (Codex, Claude, ACP, AHP) are validated against the same suite; several adapters also use it as their unit-test backbone.

## Exports

| Entry | Contents |
|---|---|
| `@anureo/conformance` | `runConformance`, `ConformanceFactory`, `ConformanceDriver`, `ConformanceReport`, `CONFORMANCE_SCENARIOS`, plus everything from `/fake`, `/fixtures`, and the Claude fake below |
| `@anureo/conformance/fake` | `createScriptedAdapter` (`ScriptedHarnessAdapter`), `FAKE_CAPABILITIES`, `FakeAdapterOptions` — an in-memory, official-API-shaped adapter that records calls and emits scripted results |
| `@anureo/conformance/fixtures` | Native-wire fixture types: `ConformanceFixture`, `NativeFixtureFrame`, `WireFlavor` (`codex` / `claude` / `acp` / `ahp`), `MethodFixture` |

Also included: `ScriptedClaudeQuery` / `createFakeClaudeQuery` — a minimal injectable query facade implementing the Claude SDK's structural surface (messages, interrupt, setModel, rewindFiles, supportedModels…), used to drive `@anureo/adapter-claude` without credentials.

## Scripted backends under scripts/

`scripts/` contains standalone fake backend processes (`fake-acp.ts`, `fake-ahp.ts`, `fake-codex.ts`, `fake-wire.ts`) that speak their real native wire protocols over stdio. They power the pack-verification flows: a clean npm install of the built packages must complete real ACP and AHP conversations — text, rejected approvals, interrupts — against these processes.

## Development

```sh
cd packages/conformance
bun run typecheck
bun test src
bun examples/standalone.ts   # scripted round-trip without any backend
```

## Documentation

- [Architecture](../../docs/architecture.md) — the conformance layer and validation scope (currently in Chinese)
- [AHP v1 protocol](../../spec/ahp-v1.md)
