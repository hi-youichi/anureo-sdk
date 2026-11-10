# @anureo/readability

Discover readability rules across workspace packages, using one or more independent agent tasks per package. This package owns analysis orchestration above `@anureo/sdk`; the SDK runtime and adapters remain independent of the analysis workflow.

The pipeline inventories source files, assigns primary review ownership, collects concrete reading obstacles, derives candidate rules across packages, and starts independent source-review sessions to refine or reject those rules. Findings are not required: an empty observation list is valid.

## Usage

The following uses the current workspace SDK API. Real Codex execution requires a configured executable and account; importing this package never starts an agent or requires a particular backend.

```ts
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import {
  analyzeReadability,
  createSdkReadabilityAgent,
  writeReport,
} from '@anureo/readability'

const agent = createSdkReadabilityAgent({
  // Return a fresh client: each task owns and disposes its client and session.
  createClient: context => createClient({
    adapter: createCodexAdapter({ command: 'codex' }),
    identity: { adapterId: 'codex', runtimeConfigId: 'readability' },
  }, { signal: context.signal }),
  session: { permissionMode: 'read-only' },
  timeoutMs: 600_000,
})

const report = await analyzeReadability({
  root: process.cwd(),
  agent,
  packages: [
    { path: 'packages/core', agents: 3 },
    { path: 'packages/codex', agents: 2 },
  ],
  concurrency: 4,
  onProgress: event => console.log(event.phase, event.taskId, event.state),
})

await writeReport(report, './artifacts/readability')
console.log(report.complete, report.rules)
```

From the repository checkout, run the ready-to-use Codex example with explicit per-package task counts:

```sh
bun run example:readability . packages/core=3 packages/codex=2
```

Omit package arguments for automatic discovery. `--help` prints usage without invoking a model. An incomplete report is still saved and the example exits with code 1. Cancel with Ctrl+C.

`rules.json` contains the structured report, source hashes, task results, observations, rules, coverage gaps and failures. `rules.md` renders the rules with applicability, exceptions and evidence references. Paths in the persisted report are relative to the analyzed root. Reports contain quoted source: store them wherever that source may be stored.

## Assignment and discovery

Omit `packages` to discover `workspaces` in the root `package.json`; both the array form and `{ packages: [...] }` form are accepted. Workspace patterns support literal directory segments, `*` and `**`. Other glob syntax is rejected; select explicit package paths instead. A repository without workspaces uses its root package.

The scanner includes JS/TS implementation files and skips declarations, directory/file symlinks, dot directories, dependencies, `generated`, `vendor`, build, coverage and artifact directories. Tests and fixture directories are excluded unless `includeTests: true`. Nested packages own their files independently. Excluded files are outside the reported coverage denominator.

`agents` is a requested task count, capped by available files. The automatic fallback balances file line counts; this estimates workload, not readability or responsibility boundaries. For meaningful responsibility groups, provide exact repository-relative file lists:

```ts
const packages = [{
  path: 'packages/core',
  groups: [
    { focus: 'Lifecycle and runtime', files: [/* all files in this responsibility */] },
    { focus: 'Process and resource ownership', files: [/* remaining files */] },
  ],
}]
```

Choose `groups` or `agents`. Groups must be nonempty and cover every included file in that package exactly once. Agents may read callers outside their primary scope; reportable evidence must refer to files in this run's inventory. `scanRepository()` and `planAnalysis()` expose the plan before executing any agent.

## Evidence and failure behavior

- Analysis results must account for every assigned file as reviewed or unreviewed. Every observation must cite at least one reviewed owned file.
- The host assigns observation/rule IDs and checks cited paths, exact complete source lines, source hashes, observation references and review coverage claims. Agents cannot supply authoritative IDs or hashes.
- Verification may narrow the rule or reject it. Single-package evidence is allowed; frequency alone does not make a rule valid. `supported` means the reviewing agent supports the scoped rule, not that the host proved its reasoning or actual reading.
- Failed analysis tasks leave explicit coverage gaps. Derivation failures preserve observations. Failed verification leaves the affected rule as a candidate. No automatic retry resubmits a possibly accepted execution.
- Pass a previous `ReadabilityReport` as `resume` to reuse successful, fully reviewed analysis tasks on the exact same source inventory. Failed and partially reviewed tasks run again; derivation and verification always run again. `reusedTaskIds` records reuse. Any inventory change invalidates all cached analyses, including analyses that may have read changed callers.
- End-of-run checks mark changed or removed inventoried files and make dependent rules stale. New files created during execution are outside the initial inventory; use a stable checkout and rerun to include them.
- `complete` describes execution and inventory coverage. A complete report may contain rejected or uncertain candidate rules.

The SDK runner negotiates `outputSchema` support and always validates JSON at runtime. Backends without structured-output support receive the schema in the prompt. Configure backend read-only permissions; the generic agent interface and instructions do not themselves enforce a filesystem sandbox. The runner supplies read-only instructions and does not approve interactions itself; interaction handling belongs to the client factory.

Pass `signal` to cancel scheduling and SDK waits. The scheduler drains started tasks before rejecting. On an execution error, the SDK runner attempts native session interruption when supported, then disposes the owned session and client. Disposal alone does not prove remote execution stopped. Custom `ReadabilityAgent` implementations must honor the provided signal and own their execution cleanup.

## Backend-independent use

Native structured-output schemas omit `uniqueItems`, which Codex rejects in strict mode. The complete host schema still rejects duplicate values. Terminal SDK failures retain their error code and message for diagnosis.

Reviewers may list existing repository-relative contextual files outside the primary analysis inventory in `inspectedFiles`. The host records their hashes in `inspectedSources` at validation time and checks them again before completing the report. This is a review-time snapshot, not the initial analysis baseline. Such reads do not increase the primary coverage count; quoted counterexamples still require initial-inventory evidence.

Implement `ReadabilityAgent` to connect another runner or run deterministic fixtures. Its three methods are `analyze(task, context)`, `derive(observations, context)`, and `verify({ rule, observations, sourceIndex }, context)`. Both SDK and custom-agent results pass the same host-side schemas and evidence checks. No provider adapter is a runtime dependency of this package.

```sh
bun run --filter @anureo/readability typecheck
bun test packages/readability/tests
bun scripts/harness-sdk/pack.ts --only protocol,core,conformance,readability --verify --out artifacts/readability-pack
```
