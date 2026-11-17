# @anureo/adapter-swarm

The swarm adapter gives an Anureo SDK client one conversation that can switch between direct execution and a temporary team. The main agent receives every turn and decides whether to work directly or create and delegate to other bees through management tools. It retains conversation context and owns the final answer.

## Quick start

This example requires an authenticated Codex CLI on PATH. Run the [three-turn example](examples/codex.ts) from the workspace root with `bun packages/adapter/swarm/examples/codex.ts`.

```ts
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createSwarmAdapter } from '@anureo/adapter-swarm'

const backend = await createClient({
  adapter: createCodexAdapter({ command: 'codex' }),
  identity: { adapterId: 'codex', runtimeConfigId: 'local' },
})

try {
  const client = await createClient({
    adapter: createSwarmAdapter({ backend }),
    identity: { adapterId: 'swarm', runtimeConfigId: 'local' },
  })
  try {
    const session = await client.sessions.create({ cwd: process.cwd(), permissionMode: 'read-only' })
    const turn = await session.submit({ input: 'Explain what Array.prototype.map does.' })
    const result = await turn.result({ timeoutMs: null })
    if (result.status !== 'completed') throw new Error(result.error?.message ?? result.status)
    console.log(result.text)
    await session.close()
  } finally {
    await client.dispose()
  }
} finally {
  await backend.dispose()
}
```

## API overview

`createSwarmAdapter(options: SwarmAdapterOptions)` is the package entry point. Pass an initialized SDK Client as `backend`. The main agent and team members can all create independent sessions on this Client. Optionally set `memberBackends: { reviewer: claudeClient, tester: codexClient }` to select other initialized Clients by fixed profile ID or temporary role. Unmapped members use `backend`. The caller owns all backend Clients and releases them after disposing the swarm Client.

- **Fixed bees.** Supply `profiles` as a list of `BeeProfile` objects. Each has an `id`, `name`, `description`, `instructions`, and optional `model` for its backend. IDs are lowercase slugs up to 40 characters and start with a letter. The main agent uses the description to select a bee. Each created bee opens its session on first assignment using the profile's model and instructions, then retains that session for follow-up assignments. For backends that reject session instructions, Swarm includes them in the assignment prompt. Start a prompt with `@<id>` to instruct the main agent to delegate to that fixed bee before answering.
- **Profile loading.** Applications can import `parseBeeProfile(value)` from `@anureo/adapter-swarm` to validate their own data. The [CLI](../../../apps/cli/README.md#fixed-swarm-bees) loads profiles from user and project files.
- **Profile origins.** To retain same-ID profiles from different directories, supply `profileEntries: BeeProfileRegistration[]` instead of `profiles` (the options are mutually exclusive). Each registration has `profile`, optional `source: { scope: 'user' | 'project', namespace?: string }`, and optional `sourceFile`. The package also exports `BeeProfileScope`, `BeeProfileSource` and `BeeProfileReference`. The application discovers files and supplies a stable namespace such as their absolute directory; the adapter does not scan the filesystem. Duplicate IDs within one scope are rejected. Default selection prefers project, then user, then unscoped entries. Start a prompt with `@user/<id>` or `@project/<id>` to select an origin explicitly; missing explicit origins fail without fallback. The main agent sees both origins and the default selection. Creation results, status and assignment events include `profileId` and, when registered, `profileScope`, `profileSource` and `sourceFile`. Hooks and `BeeProfileReview` carry `profileSource` and `sourceFile` independently of profile content.
- **Profile review.** Set `profileReview: { onResult, feedback? }` to review successful fixed-bee assignments. Swarm forks the member's underlying Session through its completed Turn and appends a review prompt. The fork uses the member's opening configuration and permissions. The foreground Turn can finish before the callback fires. Dispose the swarm Client before releasing borrowed backend Clients to drain reviews and callbacks. `BeeProfileReview` reports a proposed patch, a skip, or a failure, with native cache usage when available. Backends without a completed-turn fork capability report a skip.

- **Conversation.** Open a new Session and call `submit({ input })` for each text prompt. One turn can be active at a time. The outer Turn handle is available while execution is in progress. The main agent's Session stays open for the conversation. Main and member execution have no default result-wait deadline. Use `turn.result({ timeoutMs: null })` for an unlimited caller wait; explicit interruption and bounded submission, stop, and cleanup waits remain available.
- **Main instructions.** Swarm supplies default guidance for conversation, delegation, evidence review, and final responsibility. Session `instructions` are appended as application guidance. Fixed profile descriptions and configured backend roles are included. The main backend must support session instructions and HTTP MCP servers; unsupported configuration fails session opening without a router fallback.
- **Limits.** Set `limits: { maxBees, maxConcurrentTasks, maxTasksPerTurn }` on adapter options. Defaults are 8 live bees per session, 3 concurrent member tasks, and 16 assignments per turn. Values must be positive safe integers. Each bee runs one task at a time.
- **Member lifecycle.** Bees persist across user turns until explicitly closed or the swarm session closes. Task IDs, attempt IDs and bee IDs are distinct. Reports and result text retain the current turn plus up to eight past turns and 128 historical tasks; old full native item trees and hook snapshots are released on the next turn. Bees remain occupied until task settlement and `afterTask` finish. Remaining tasks are cancelled and settled when the main turn ends. Unknown stop outcomes fail the outer turn and require session closure.
- **Full report text.** `results: SwarmResultOptions` configures `maxBytes` (default 32 MiB per swarm Session) and `maxTextBytesPerTask` (8 MiB). These limits cover the additional text store, independently of SDK event and result limits. Reports expose a bounded `text` preview, `textTruncated` and a `ResultDescriptor`; the main agent reads complete text through `bee_result_read`. Capacity or invalid Unicode produces `availability: 'omitted'` without changing a successful native task's status. Expired references fail explicitly. Text is in-memory and is released when the swarm Session closes.
- **Completion notifications.** `mailbox: SwarmMailboxOptions` configures `maxNotices` (256) and `maxBytes` (1 MiB, at least 4096). Each accepted task reserves a 4096-byte notification slot; capacity exhaustion rejects delegation before submission. Current-turn notices are retained; older-turn notices may be evicted to admit work. `CompletionNotice` carries stable sequence and message IDs, task/attempt IDs, a bounded preview and result reference. Reads do not consume notices. This notification history does not provide process-restart recovery.
- **Progress and results.** Subscribe with `session.events()` before submitting. Each assignment emits a `subagent` item: `id` identifies the task, `subagentId` identifies the reusable bee, and `state` describes the task. Creating or closing an idle bee does not emit task lifecycle events. Member messages, tool calls, and other public items are nested beneath the assignment using `parentItemId`. Backend-local item IDs are remapped; deeper parent relationships are preserved. All events belong to the outer turn. Unfinished child items are completed before their assignment ends. Assignment completion includes elapsed time and the real backend `nativeRef` when available. `turn.result()` waits for the whole swarm turn; `items` include member evidence while `text` contains the main assistant's final answer. The main agent collects findings and failures through management tools and can delegate follow-up work.
- **Interruption and cleanup.** `turn.interrupt()` requests cancellation. Wait for `turn.result()` to observe its outcome. If a backend may still be running, the result carries `outcomeUnknown` and the swarm Session must be closed before starting work in a new Session. `session.close()` releases the swarm's sessions and reports whether execution stop was confirmed. Dispose the swarm Client even if a turn or session fails.

The adapter advertises text input, member lifecycle events, and turn interruption. Configure sandboxing on each backing harness. Swarm passes `permissionMode` to the backing sessions, and the member prompt requests read-only work. Use permission modes understood by your configured backends. See the [SDK guide](../../core/README.md) for standard session and turn contracts.

When the user asks to persist a reusable profile, main instructions guide general skills into user scope and project-specific rules into project scope, honoring explicit destinations. Project details can be supplied as assignment context or kept in a project specialization; using a general skill in one repository does not itself make that skill project-specific. For file-backed creation, the host supplies storage paths and reload behavior through session instructions, as the CLI does. The main assistant performs authorized writes; `bee_create` creates an instance and does not persist files.

For example, register both origins on your initialized backend Client:

```ts
const adapter = createSwarmAdapter({
  backend,
  profileEntries: [
    { profile: userTester, source: { scope: 'user', namespace: '/home/me/.anureo/bees' }, sourceFile: '/home/me/.anureo/bees/tester.json' },
    { profile: projectTester, source: { scope: 'project', namespace: '/repo/.anureo/bees' }, sourceFile: '/repo/.anureo/bees/tester.json' },
  ],
})
// Both profiles may have id: 'tester'. @tester defaults to projectTester;
// @user/tester explicitly selects userTester.
```

### Model selection

Applications can pass `modelCatalog` to `createSwarmAdapter`. Import `SwarmModel`, `SwarmBackendModelCatalog`, and `SwarmModelCatalog` from `@anureo/adapter-swarm` to describe the snapshot. Each model has an exact execution `id` and optional `name`, `description`, `isDefault`, and `hidden`. Native metadata may also include `efforts` (`id`, optional `description`), `defaultEffort`, `serviceTiers`, and `inputModalities`. Preserve the owning backend's execution value, including Claude model values and Pi's full `provider/model` references. Effort IDs retain their backend meaning; they are not a universal cross-backend scale. Applications query and release their catalog resources; Swarm receives the data and creates no discovery connections.

```ts
// backend is the initialized Client from the quick start.
const adapter = createSwarmAdapter({
  backend,
  modelCatalog: {
    default: {
      status: 'available',
      policy: 'recommend',
      models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }],
    },
  },
})
```

Swarm copies and validates the snapshot at adapter construction. The same snapshot supplies main instructions and tool validation. Catalogs have `status: 'available'` with a `models` array, or `status: 'unavailable'` with an optional diagnostic `reason`. `default` describes `backend`; `members` describes `memberBackends` using the same keys. For example, `memberBackends.reviewer` uses `modelCatalog.members.reviewer`. Member catalogs without a matching backend route are rejected. A mapped member without a catalog has unknown discovery status; unmapped roles retain the default-backend fallback. Catalog display omits hidden entries and failure reasons.

The main assistant calls `bee_create({ role, name, model?, effort?, selectionReason? })` for a temporary bee. The selected backend, explicit model and effort stay with that bee; its first assignment opens the Session and subsequent assignments reuse it. Changing model or effort requires another bee. Omit either option to use that backend's configured default. Members do not inherit the main Session's model or config. `isDefault` and `defaultEffort` are catalog metadata and do not populate execution parameters. Fixed bees use `bee_create({ profileId, profileScope? })`, prohibit model/effort overrides, and use `model` and `effort` from the pinned profile revision. Revision rotation, origin selection, and review forks retain these settings.

Applications enable effort control separately on each backend catalog with `effortConfigKey: 'effort'` (Codex/Claude adapters) or `'thinkingLevel'` (Pi adapter). This mapping can accompany either available or unavailable discovery; only declare it for a backend that honors that Session config key. Swarm never derives mappings from model names or Client identity labels. For example:

```ts
const adapter = createSwarmAdapter({
  backend,
  modelCatalog: { default: {
    status: 'available', effortConfigKey: 'effort',
    models: [{ id: 'gpt-6-luna', efforts: [{ id: 'low' }, { id: 'high' }] }],
  } },
})
// Main-agent tool call:
// bee_create({ role: 'extractor', name: 'Extract facts',
//   model: 'gpt-6-luna', effort: 'low', selectionReason: 'Simple bounded extraction' })
```

Effort IDs are exact, nonblank strings of at most 128 characters, without surrounding whitespace. Missing mappings reject explicit effort with `SWARM_EFFORT_UNSUPPORTED`. A known model's `efforts` list constrains explicit effort regardless of recommend/allowlist model policy; an empty list rejects every explicit effort with `SWARM_EFFORT_NOT_ALLOWED`. When the model is omitted or unknown, or its efforts are undiscovered, support is left to the backend; Swarm does not assume the catalog's default model is the effective default. Backend failures propagate without removing effort or retrying on another model. Fixed profile JSON accepts optional `effort` with the same ID syntax; routing and support are checked when creating the bee and again when resolving a pinned revision. Profile reviews preserve the resolved effort. Advice in `recommendedEffort` applies only when explicitly selected, never automatically.

Main instructions guide delegated model selection by task complexity: use the lowest-cost suitable model for simple, bounded assignments, and prioritize greater reasoning capability and reliability for complex assignments. Supply relative cost and capability information in model descriptions or application guidance; model names alone do not establish either. Explicit model requests, backend policies, and fixed-profile contracts take precedence. Insufficient results can be escalated to a new bee with a more capable model, carrying forward the findings and gaps for verification. Simple work can still be handled directly when delegation adds unnecessary cost.

For application owners, attach `guidance: ModelGuidance` to individual catalog models. This is application-authored advice, separate from native facts:

| Field | Contract |
| --- | --- |
| `summary` | Required nonempty explanation, at most 2,000 characters. |
| `relativeCost` | Optional `low`, `medium`, `high`, or `unknown`; no prices are inferred from names. |
| `comparisonGroup` | Required for a known cost tier; only compare tiers within the same billing environment/group. |
| `preferredTasks`, `limitations` | Optional arrays of up to 32 nonempty strings, each at most 512 characters. Task fit is advice, not a guarantee. |
| `recommendedEffort` | Optional exact native effort ID, checked against `efforts` when supplied. Advisory only: explicit `bee_create.effort` or profile `effort` configures execution. Catalog defaults can differ from the backend's configured execution default. |
| `source`, `reviewedAt` | Required provenance (at most 2,000 characters) and valid `YYYY-MM-DD` review date. The application owns freshness and accuracy. |

`parseModelGuidance(value)` validates and returns a detached copy; it rejects unknown guidance fields. `parseModelCatalog(value, memberKeys?)` validates and copies a complete catalog; supply the configured member route keys when using `members`. Both are synchronous package-root exports for application configuration loaders, and both report `SWARM_INVALID_MODEL_CATALOG`. Adapter construction validates again. Arrays and nested advice are copied, so later mutations cannot alter the running catalog.

The main assistant is instructed to supply `selectionReason` for every temporary bee, explaining task fit or backend-default fallback. When the selected backend has at least one visible model with guidance, the runtime requires a nonblank reason (at most 2,000 characters), even if `model` is omitted or selects an unguided model. Missing reasons fail with `SWARM_INVALID_ARGUMENTS` before bee creation. Catalogs without visible guidance preserve compatibility with older callers that omit reasons. Fixed-profile creation prohibits `selectionReason` overrides. Reasons are explanations supplied by the caller, not verified assessments.

| Catalog policy | Explicit temporary model | Omitted model |
| --- | --- | --- |
| `recommend` (default) | Exact nonempty IDs may pass through even when absent from discovery; the backend decides availability. | Backend default. |
| `allowlist`, available | Must occur in `models`; an empty list rejects every explicit choice. Hidden entries remain eligible by exact ID. | Backend default. |
| `allowlist`, unavailable | Rejected. | Backend default. |

Absent or failed discovery preserves legacy default-model behavior. Allowlists apply to explicit temporary choices; existing fixed profiles remain application-configured. IDs are case-sensitive, at most 512 characters, and cannot have surrounding whitespace. Duplicate IDs and malformed catalogs fail with `SWARM_INVALID_MODEL_CATALOG`; invalid tool fields fail with `SWARM_INVALID_ARGUMENTS`, and excluded choices fail with `SWARM_MODEL_NOT_ALLOWED`. Backend model failures propagate without changing model or backend.

`BeeExecutionSelection`, exported from the package root, describes the requested backend identity, route, optional `requestedModel` and `requestedEffort`, plus `modelSource` and `effortSource` (each `bee`, `profile`, or `backend-default`). Optional `selectionReason` records the caller's explanation. For an explicitly requested catalog model with guidance, `guidanceRevision` is the SHA-256 of its validated guidance JSON; omitted models have no guidance revision because the actual backend default is unknown. Creation responses, bee/task status, lifecycle snapshots, and `subagent.extensions.swarm.execution` expose these fields. Task snapshots retain their choice after the bee closes. These values record requests; creating a bee does not verify provider access or confirm the actual model or effort used. `beforeDelegate` can observe and deny the request; its enrichment contract only changes assignment text.

## Management tools

Swarm injects a session-isolated, authenticated local HTTP MCP server named `anureo-swarm` into the main session. This name is reserved. Members do not receive this server. These tools are called by the main assistant; applications use the SDK session API above.

| Tool | Contract |
| --- | --- |
| `bee_create` | Provide `profileId` and optional `profileScope` (`user` or `project`), or temporary `role`, `name`, optional exact `model` and `effort`, and `selectionReason` (required when that backend has visible guidance). Omitted scope uses default precedence; explicit scope never falls back. Temporary bees cannot specify a scope. Returns `beeId`, `name`, requested execution settings and the resolved profile origin when fixed. |
| `bee_delegate` | Provide `beeId`, `task`, `context`, `constraints`, and `expectedOutput`; reserves work and returns `taskId`, `attemptId` and `operationScope` immediately. |
| `bee_status` | Inspects `taskId`, or lists current tasks and bees. List `history: true` includes retained past tasks; `limit` defaults to 16 (maximum 32), and `cursor` takes the previous `nextCursor`. Reports expose preparation/execution/settlement `phase`, messaging capability and requested execution settings. |
| `bee_wait` | Use `taskId` for the compatible single-task report, or `taskIds` (1–32 unique IDs) and `mode: 'any' \| 'all'` for a batch result with `tasks`, `remainingTaskIds`, `reason` and `timedOut`. `timeoutMs` defaults to 30000, accepts 0–30000; zero polls immediately. Timeout or request cancellation leaves tasks running. |
| `bee_receive` | Reads completion notices with optional `after`, `limit` (default 16, maximum 64) and `timeoutMs` (default 30000, 0–30000). Feed returned `nextCursor` back as `after`. Omitted `after` starts at the retained window; zero requests the session origin. An expired cursor fails with the first available cursor rather than silently skipping notices. |
| `bee_result_read` | Reads full text with `resultRef`, optional `cursor` and `maxBytes` (default 16384, range 4–32768). Follow `nextCursor` until `done`. UTF-8 boundaries are preserved; actual pages can be smaller to bound JSON-escaped output. References and authenticated cursors are Session-local. |
| `bee_send` | Provide `taskId`, `message` (at most 16 KiB UTF-8), `delivery` and required `operationKey`. `currentTurn` requires an active matched Turn and backend atomic steering; `nextAssignment` queues data for the bee's next explicit delegation without starting work. Receipt state is `queued`, `submitted`, `rejected` or `unknown`. |
| `bee_assess` | Records the main agent's assessment of a terminal current-turn task: `taskId`, `verdict` (`accepted`, `needs_revision`, `rejected`), `reason`, and `evidence` string array. Identical retries are idempotent; conflicting retries fail. Unassessed tasks are not accepted. Acceptance does not validate improvement. |
| `bee_cancel` | Cancels `taskId` and waits for its terminal outcome. |
| `bee_close` | Cancels a bee's current task and releases its session. |
| `workflow_list` | Lists registered workflows (`id`, `description`, `revision`). Served only when `workflows` is configured. |
| `workflow_run` | Starts a registered workflow (`workflowId`, optional JSON `args`, optional `resumeFrom` runId) and returns `runId` immediately; steps execute as bee tasks in the background within the current turn. |
| `workflow_status` | Reads one run (`runId`, optional `timeoutMs` 0–30000 that waits like `bee_wait`): `status` (`running`, `completed`, `incomplete`, `failed`, `interrupted`), step counts, `taskIds` and a bounded `result`. |

Members receive explicit task context rather than the main conversation history. Their prompts request read-only work; backend permissions enforce the actual sandbox. Only management tools are injected automatically; configure other member tools on their backends. When workflow execution is configured, every bee also receives a dedicated `anureo-swarm-member` server (see Workflow execution). Profile reviews run in background forks. Reusing or closing a reviewed member waits only for fork acquisition to preserve the source; full analysis and callbacks are drained at adapter disposal.

Task waits and completion reads are independent, non-consuming observations of the same work; de-duplicate by task/attempt ID. They share at most 16 concurrent waiters per Session, leaving bridge request capacity for control tools. Batch reports share a 32 KiB serialized-preview budget, complete MCP responses are bounded to 128 KiB, and unusually large metadata can fail with `SWARM_RESPONSE_TOO_LARGE`. Omitted/expired text is not an empty successful report. The public root exports `SwarmResultOptions`, `ResultDescriptor`, `SwarmMailboxOptions` and `CompletionNotice` for applications; the text store and waiting implementations are internal.

`bee_send` receipts report backend acceptance, not model comprehension. Session-level input and `afterTurn` delivery are not substituted for atomic current-turn steering. At most 16 current-turn messages are accepted per task, and next-assignment queues retain at most 16 messages per bee and 256 KiB per Session. Failed preparation keeps queued next-assignment data available; dispatch binds it to that new attempt. A changed fixed-profile revision rejects carried data rather than silently applying it to new instructions. Closing a bee rejects its remaining queued data. An unknown current-turn delivery blocks later messages for that attempt; it is never automatically resent or moved to another task.

Mutating tools also accept optional `operationKey`, while `bee_send` requires it. Obtain `operationScope` from creation, delegation or status and form `<operationScope>:<unique nonce>`. Retrying the same tool/key and arguments reuses its command/receipt; changing arguments produces `SWARM_OPERATION_CONFLICT`. New commands require the current scope. Keep the same key after a transport timeout, because cancellation of the caller's observation does not undo an admitted command. Scopes are bounded (128 commands each, normally eight scopes); queued/unknown message receipts pin their scope, with a hard limit of 64 scopes. Expired scopes fail rather than start duplicate work. These records are in-memory; operations without a key have no business-level retry guarantee.

## Workflow execution

Set `workflows` on adapter options to register workflow files whose steps run as bees. A registration is a plain object validated by `parseSwarmWorkflowRegistration`; the CLI discovers them from `.anureo/workflows/` (project files override user files with the same id).

```ts
import { parallel } from '@anureo/workflow'
import { createSwarmAdapter } from '@anureo/adapter-swarm'
import { beer } from '@anureo/adapter-swarm/workflow'

const adapter = createSwarmAdapter({
  backend,
  workflows: {
    registrations: [{
      id: 'review-files',
      description: 'Review a file list with one bee per file',
      revision: '1',
      run: async (args: { files: string[] }, ctx) =>
        parallel(args.files.map(file => () => beer(`Review ${file} and report defects.`, { client: ctx.client, cwd: ctx.cwd, instructions: 'You are a careful reviewer.' }))),
    }],
    journalDirectory: './.anureo/workflow-runs',
  },
})
```

`ctx.client` is a swarm façade client: `beer(prompt, { ...options, client: ctx.client })` — and plain `agent(prompt, { client: ctx.client })` — execute each call as one bee task of the outer turn instead of an isolated session. Bees pool per `(backend route, model, instructions)`; identical keys reuse one bee and its member session across steps of the same turn. `beer()` without a swarm client degrades to `agent()`, and bee-only options (`role`, `name`, `context`, `constraints`, `expectedOutput`) on a non-swarm client fail with `SWARM_OPTION_REQUIRES_SWARM` instead of being ignored. Structured output is advertised optimistically (set `workflows.outputSchema: false` to disable) and passes the prepared schema to the member turn.

Three entry points share one runner per session:

- **Host** — submit a directive turn: `/workflow run <id> <json-args>`, `/workflow resume <id> <runId>`, `/workflow list`. The main agent is bypassed; the turn result text is the run status JSON. `runSwarmWorkflow(session, id, args)` from `@anureo/adapter-swarm/workflow` wraps this.
- **Main agent** — the `workflow_list`/`workflow_run`/`workflow_status` tools above; runs continue in the background while the main agent works and steps appear as normal bee tasks.
- **Members** — every bee gets its own `anureo-swarm-member` MCP server (unique credential per bee) exposing `workflow_list`, `workflow_run`, `workflow_status` and `workflow_send`. A member-triggered run's step tasks nest under the triggering task (`parentItemId`) and count one nesting level of `maxDepth`; `workflow_send` may only target tasks of runs that bee started, with `nextAssignment` data bound to that run and rejected when it ends.

Admission and lifecycle contracts:

- Steps beyond `maxConcurrentSteps` (default 8) queue (up to `maxQueueDepthPerRun`, default 64) instead of failing; per-run delegations are capped by `maxStepsPerRun` (default 128). Workflow tasks do not consume the manual `maxTasksPerTurn`/`maxConcurrentTasks` budgets but do share the `maxBees` ceiling, waiting on bee release when full.
- When the outer turn ends, queued and running steps are cancelled and the run is marked `interrupted`. With a `journalDirectory`, every completed step is journaled (the `@anureo/workflow` journal: manifest, chained keys by prompt plus canonical options); `workflow_run` with `resumeFrom` (or `/workflow resume`) replays completed steps from the longest unchanged prefix and runs only the remainder. Resumed runs continue in a fresh journal directory; `workflow_status` reports it as `journalRunId`. Runs without `journalDirectory` journal in memory only and cannot be resumed.
- Step prompts/fields are bounded to 256 KiB on the programmatic path (the 16 KiB MCP limits still apply to model-called tools), run results are bounded to 64 KiB, and status previews to 16 KiB. Step items carry `extensions.swarm.workflow` (`runId`, `depth`) and respect the existing subagent nesting pipeline.

## Application lifecycle hooks

Import `SwarmHooks`, `SwarmHookOptions`, `HookContext`, `HookDiagnostic`, and the snapshot types from `@anureo/adapter-swarm`. Applications implement these callbacks; Swarm invokes them. `beforeDelegate` receives a `DelegationSnapshot` after reservation and revision resolution, before member submission. Return nothing to allow, `{ deny: reason }` to fail setup, or `{ enrich: { context, constraints, expectedOutput } }` to append assignment guidance. Errors and deadlines fail that assignment before submission.

`afterTask` receives a terminal `TaskSnapshot`; `afterAssessment` receives an explicit `AssessmentSnapshot`; `afterTurn` receives a `TurnSnapshot` after member settlement and assessment callbacks, once per outer turn including failures. These observers cannot change successful task results. Snapshots are cloned and deeply frozen (`Immutable<T>`); `SwarmAssignment` and `AssignmentRevisionPin` describe assignment content and version identity. Hooks do not receive live sessions. An aborted callback must stop its own work; late return values are ignored.

Set `hooks`, `hookTimeoutMs` (default 1000, maximum 30000), and `onError` on adapter options. Each callback and error handler has its own deadline and abort signal. The latest 100 hook diagnostics are available through `bee_status`; background evolution errors are available on `controller.diagnostics` and its `onError`. Queue overflow is reported by the hook error path. Evolution evidence hooks compose with application observers independently, including when an observer fails. Do not register the controller hooks twice.

## Persistent evolution for SDK applications

The `@anureo/adapter-swarm/evolution` entry point exports the opt-in persistence and analysis API. No default validator exists. Completion, acceptance, and proposer confidence never authorize publication. The CLI's legacy review flags remain proposal-only.

```ts
import { FileEvolutionStore, createEvolutionController } from '@anureo/adapter-swarm/evolution'

const store = new FileEvolutionStore({ directory: './.swarm-evolution', scope: 'my-project' })
const controller = createEvolutionController({
  store,
  proposer: ({ baseline }) => ({
    instructions: baseline.profile.instructions + '\nCheck boundary cases.',
    rationale: 'Application proposal; requires comparative validation',
  }),
  // Omit validator for proposal-only operation.
})
// Pass evolution: { controller } alongside backend and profiles to createSwarmAdapter.
// Dispose the swarm client first, then await controller.close(), then dispose backends.
```

The runnable [SDK lifecycle example](examples/evolution.ts) supplies a proposer and a validator that evaluates baseline and candidate in real isolated backend sessions. Its tiny demonstration suite is explicitly not general proof of improvement. Run `bun packages/adapter/swarm/examples/evolution.ts` with authenticated Codex. It shows evidence collection, assessment, background draining, next-assignment resolution, history and rollback; publication is conditional on a strict measured improvement.

For application owners, `EvolutionController` exposes `seed(profile, experiences?, source?)`, `resolve(profileId)`, `rollback(profileId, targetRevisionId, expectedGeneration, reason)`, `drain()`, `close()`, `hooks`, and `diagnostics`. `createEvolutionHooks(controller)` returns its handlers for standalone composition. `drain()` waits for admitted work without stopping admission. `close()` stops admission, aborts callbacks, discards queued work, and awaits owned storage cleanup; no controller publication occurs after it resolves. Uncooperative callback code can continue but its values cannot publish. Assignment resolution and administrative operations bypass the bounded background worker queue. Defaults: concurrency 2, queued jobs 64, callback deadline 1000ms; configure these via `EvolutionOptions`. Evidence is limited to 8 MiB per admitted payload.

For scoped profiles, pass a `BeeProfileReference` such as `{ id: 'tester', source: { scope: 'user', namespace: '/home/me/.anureo/bees' } }` to `resolve`, `rollback`, and the store's `publish`/`history` methods. Strings still address legacy unscoped profiles. Store `seed(profile, experiences?, context?, source?)` and `saveRevision(profile, experiences?, parentId?, context?, source?)` accept origin metadata; child revisions inherit their parent's source. Revisions, proposals and head transitions retain `profileSource`. Source scope and namespace isolate heads, experiences, publication and rollback even when profiles have identical content. Custom stores must honor this identity as well as the application store scope. If unscoped history exists and a scoped profile has no head yet, seeding fails with `EVOLUTION_LEGACY_PROFILE_REQUIRES_MIGRATION`; explicitly migrate its origin or use a new store scope/directory. Existing string-based callers continue using their original history.

Pass `evolution: { controller, ownership: 'caller' }` (the default) to retain control across adapters. Close caller-owned controllers after their Swarm clients. With `ownership: 'adapter'`, disposal starts controller cancellation and awaits cleanup; do not share an adapter-owned controller. Backend Clients always remain caller-owned.

Each fixed assignment seeds from the configured source profile and pins its resolved revision, experiences, head ID and generation. Publishing cannot change a running task. Future assignments rotate the member session only when revision ID changes, preserving bee identity; same-version assignments reuse it. Human edits to any configured profile field fail with `EVOLUTION_SOURCE_PROFILE_MISMATCH` against the stored original baseline. Explicitly migrate and validate edited profiles or use a new scope/directory. Source files are never overwritten or silently ignored.

### Proposer, validator and store extension contracts

Applications implement `EvolutionProposer` using `ProposalInput` to return `ProposedChange` or no change. Only instructions and reusable experiences can change. `TrustedValidator` is trusted application code with a stable `identity` (`id`, `version`); it receives baseline, candidate and proposal and must return `ValidationResult` bound to their exact IDs. Use held-out comparisons relevant to the application, enforce regressions, and supply a `suiteId` and nonempty comparative `evidence` with check names, baseline/candidate observations and outcomes. All checks must pass for a passing verdict. Missing, throwing, timed-out, mismatched, failing or inconclusive validation leaves a proposal without publication. Agent-generated assertions alone are not a trusted validator.

Applications may implement `EvolutionStore` (using `StoreContext.signal` to cancel mutations) or use `FileEvolutionStore` with `FileEvolutionStoreOptions`. `scope` isolates a project under the supplied directory. Separate immutable content-addressed records persist `EvolutionEvidence`/`EvidencePayload`, `EvolutionProposal`, `ProfileRevision`, `ValidationRecord`, and append-only `HeadTransition` history. `ResolvedProfile` pairs head and revision; `TransitionResult` reports committed or conflict. `EvolutionDiagnostic` describes controller errors. All these types and `EvolutionOptions` are exported from the evolution entry point for extension authors.

Store operations `appendEvidence`, `saveRevision`, `saveProposal`, and `saveValidation` persist records; `seed` establishes or checks the source baseline; `resolve` reads the current head; `publish` requires a passing persisted validation against the current baseline and expected generation. `rollback` accepts only a previously active revision and advances generation. CAS guards concurrent/stale publication, including after rollback. Store callers are trusted application code; raw storage methods are not an authorization boundary against an application forging validation records. Custom stores must preserve these contracts and complete or abort owned mutations before their promises settle.

For diagnostics and administration, `FileEvolutionStore` also provides `readRevision`, `readEvidence`, `readProposal`, `readValidation`, `listIds`, and `history`, plus its `scope` and resolved `directory`. Hashes use locale-independent canonical key ordering. Corrupt records/history fail closed. On a local filesystem supporting atomic hard links, each writer reads generation G, checks the expected generation and exact baseline, then exclusively links a complete transition into the fixed G+1 journal filename. The link is the commit point across independent local processes. An existing filename means conflict even for identical transition content; immutable content-addressed record writes remain idempotent. Losing seeders reload the winner and verify its original configured source. Generations only increase, so restoring an earlier revision cannot revive stale publication authority.

There are no mutable lock or recovery markers and no lock-timeout option. Legacy `.lock`/`.recovery` files or directories are ignored and left untouched. A crashed writer can leave ignored temporary files or unpublished immutable records; these do not block later writes. Published journal entries must never be deleted or overwritten. The store does not provide automatic retention/compaction, network-filesystem coordination guarantees, or power-loss durability beyond the filesystem's guarantees. Legacy profile reviews have per-review deadlines but no global concurrency cap. No internal hook runner or management transport is a supported package entry point.

## Backend integration

Applications implement/configure the SDK backend Clients; Swarm calls their Session APIs. A backend that cannot accept Session instructions can report `HarnessSdkError('CAPABILITY_UNSUPPORTED', message, false, false, { capability: 'session.instructions' })`. Swarm retries once with those instructions included in assignment text, preserving backend and model. Other capability failures propagate without this retry. The included ACP and Hermes adapters identify instruction failures this way. Backends release partially opened sessions when model validation or configuration fails.

## Code structure

`src/index.ts` owns adapter construction, backend routing and bridge wiring; `session.ts` one swarm session per SDK session including `/workflow` directives; `bee-manager.ts` the bee/task lifecycle and programmatic workflow delegation; `tasks/store.ts` turn admission with separate workflow budgets; `results.ts` and `coordination/` the result store, mailbox, operation store and signals; `management-bridge.ts` per-session/per-bee authenticated MCP leases; `instructions.ts`, `profiles.ts`, `models.ts` and `hooks.ts` guidance, profile registry, model catalogs and lifecycle hooks; `evolution/` persistent profile analysis; `workflow/` the workflow runner, bee pool, façade client, `beer()` and tool surfaces re-exported through `@anureo/adapter-swarm/workflow`.

| Module | Responsibility |
| --- | --- |
| [src/index.ts](src/index.ts) | Exports the adapter factory, validates configuration, and opens the main session with its management endpoint. |
| [src/session.ts](src/session.ts) | Owns outer turns, main execution, interruption, and cleanup. |
| [src/instructions.ts](src/instructions.ts) | Builds default main instructions, member catalog, and application guidance. |
| [src/models.ts](src/models.ts) | Defines model catalog and execution-selection types; validates copied snapshots, selects temporary models and renders backend catalogs. |
| [src/bee-manager.ts](src/bee-manager.ts) | Owns reusable members, tasks, limits, results, and lifecycle events. |
| [src/tasks/store.ts](src/tasks/store.ts) | Separates current-turn admission from bounded task history and coordinates any/all completion waits. |
| [src/coordination/change-signal.ts](src/coordination/change-signal.ts) | Versioned, cancellable broadcast waits without consuming another observer's wakeup. |
| [src/coordination/mailbox.ts](src/coordination/mailbox.ts) | Reserves notification capacity before delegation and serves non-consuming completion cursors. |
| [src/coordination/operations.ts](src/coordination/operations.ts) | Bounded operation scopes and command retry/conflict handling. |
| [src/results.ts](src/results.ts) | Session-local report text retention, explicit omission, authenticated cursors and UTF-8 pagination. |
| [src/management-tools.ts](src/management-tools.ts) | Defines the ten management tool contracts and their mutation annotations. |
| [src/management-dispatch.ts](src/management-dispatch.ts) | Validates calls against the same schemas advertised to the model, before command admission. |
| [src/management-bridge.ts](src/management-bridge.ts) | Serves authenticated local MCP endpoints isolated by session. |
| [src/profiles.ts](src/profiles.ts) | Defines profile content and origin contracts; validates registrations and resolves scoped/default selections. |
| [src/profile-review.ts](src/profile-review.ts) | Forks completed member turns, validates proposals, and drains reviews. |
| [src/hooks.ts](src/hooks.ts) | Defines immutable lifecycle snapshots, callback deadlines and hook diagnostics. |
| [src/evolution/](src/evolution/) | Separate public evolution entry point: controller owns background analysis; store owns immutable records, exclusive journal CAS and history; types define application extension contracts. |
| [src/workflow/](src/workflow/) | Workflow runner, bee pool, façade client, `beer()` and tool surfaces; re-exported for authors through `@anureo/adapter-swarm/workflow`. |
| [src/execution.ts](src/execution.ts) | Observes backend turns, forwards cancellation, and releases sessions. |
| [src/events.ts](src/events.ts) | Maps main messages to outer identities, nests member items, and settles unfinished child streams. |
