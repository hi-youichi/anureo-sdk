# @anureo/conformance

The Anureo SDK conformance suites drive the revised AHP v1 client through the public runtime API.
The shared suite, `runConformance`, drives any `HarnessAdapter` to verify the shared behavioral contract that AHP implies.
Passing the shared suite establishes conformance only within that shared acceptance scope.
Full adapter conformance also requires the native suite, `runNativeConformance`, which covers overlap,
active close and independent observations, with native evidence supplied by adapter fixtures.
Passing a subset does not establish full adapter conformance. See the [acceptance plan](../../docs/native-harness-lifecycle.md#9-实施顺序与验收).

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

- A scenario is **not-applicable** when its capability was not declared at initialization (e.g. `steer` for a backend without `input.steer.atomicMatch`).
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

`scripts/` contains standalone fake backend processes (`fake-acp.ts`, `fake-ahp.ts`, `fake-codex.ts`, `fake-wire.ts`) that speak their real native wire protocols over stdio. Conformance tests use these processes to exercise real wire conversations over stdio.

## Development

```sh
cd packages/conformance
bun run typecheck
bun test src
```

## Documentation

- [Architecture](../../docs/architecture.md) — the conformance layer and validation scope (currently in Chinese)
- [AHP v1 protocol](../../spec/ahp-v1.md)
