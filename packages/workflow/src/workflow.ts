import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { WorkflowContext, WorkflowOptions, WorkflowResult } from './workflow-types'
import { RunState, runWith, storedFailure } from './workflow-state'
import { freezeJson, jsonCopy, type JsonValue } from './persistence/json'
import { openFileRun, type RunHandle } from './persistence/store'

/**
 * Run a body with a durable identity, frozen JSON input and journaled agent calls. The body
 * receives the new run's ID and input after initial publication. On resume the body starts from
 * the beginning and eligible agent calls reuse saved results. Account for repeated side effects
 * from body code and agent calls that execute again.
 * Supply strict JSON for the input and awaited body result. Await your own background work inside
 * the body. Keep borrowed clients alive until the workflow promise settles, then dispose them separately.
 *
 * Resolve with a JSON copy of the body result after registered agent work settles, publication
 * succeeds and the writer lock is released. A drop or an ordinary failure in registered work can
 * yield an incomplete result if the body still returns. Invalid inputs, uncaught body errors,
 * fatal agent failures, and storage failures reject. Run failures report the run ID and storage
 * root in SDK error details, using the supplied directory if initialization fails. A
 * lock-release failure can reject after the result and terminal manifest have been published.
 */
export async function workflow<Input, Result>(
  options: WorkflowOptions<Input>,
  body: (run: WorkflowContext<Input>) => Result | Promise<Result>,
): Promise<WorkflowResult<Awaited<Result>>> {
  const runId = options?.runId ?? randomUUID()
  const state = new RunState()
  let handle: RunHandle | undefined
  let publishedResult: Awaited<Result> | undefined
  try {
    const { storageOptions, context } = prepareRun(options, body, runId)
    handle = await openFileRun(storageOptions)
    publishedResult = await completeRun({ handle, state, body, context })
  } catch (cause) {
    await abortRun({ cause, state, handle })
  } finally {
    if (handle) {
      try { await handle.close() }
      catch { state.noteStorageFailure() }
    }
  }
  const failure = state.failure
  if (failure) {
    throw new HarnessSdkError(failure.code, failure.message, false, failure.outcomeUnknown, {
      ...failure.details,
      runId,
      directory: handle?.identity.directory ?? options?.directory,
    })
  }
  // A failed publication also stops the run, so only published results reach this return.
  return { runId, status: state.status, result: publishedResult as Awaited<Result> }
}

/** Snapshot input and an object source reference before workflow awaits storage. The body gets a
 * frozen input and the writer snapshots it separately. Malformed options, a non-function body or
 * non-JSON input throw before storage opens. */
function prepareRun<Input, Result>(
  options: WorkflowOptions<Input>,
  body: (run: WorkflowContext<Input>) => Result | Promise<Result>,
  runId: string,
): { storageOptions: WorkflowOptions<JsonValue> & { runId: string }; context: WorkflowContext<Input> } {
  if (!options || typeof options !== 'object' || typeof body !== 'function') {
    throw new HarnessSdkError('INVALID_PARAMS')
  }
  const input = freezeJson(jsonCopy(options.input))
  const resumeFrom = options.resumeFrom && typeof options.resumeFrom === 'object'
    ? { ...options.resumeFrom } : options.resumeFrom
  return {
    storageOptions: { ...options, runId, input: input as JsonValue, resumeFrom },
    context: { runId, input },
  }
}

/** Give the body access to the journal through the async context. Stop dispatch on an uncaught
 * body failure and drain before choosing the terminal outcome, since settling agents can still
 * change it. Return the JSON result after publication. workflow routes rejections through abortRun. */
async function completeRun<Input, Result>({ handle, state, body, context }: {
  handle: RunHandle
  state: RunState
  body: (run: WorkflowContext<Input>) => Result | Promise<Result>
  context: WorkflowContext<Input>
}): Promise<Awaited<Result>> {
  let value: Awaited<Result> | undefined
  try {
    value = await runWith({ journal: handle.journal, state }, async () => body(context))
  }
  catch (cause) { state.stop(sdkError(cause, 'WORKFLOW_BODY_FAILED')) }
  await state.closeAndDrain()
  const failure = state.failure
  if (failure) throw failure
  const result = jsonCopy(value)
  await handle.finish(state.status, result as JsonValue)
  return result as Awaited<Result>
}

/** Record workflow's failure and drain before publishing the aggregate to an acquired handle.
 * Initialization failures can arrive before a handle exists. An abort publication error is
 * recorded as a storage failure. workflow still releases the handle and reports the final aggregate. */
async function abortRun({ cause, state, handle }: {
  cause: unknown
  state: RunState
  handle: RunHandle | undefined
}): Promise<void> {
  const error = sdkError(cause, 'WORKFLOW_FAILED')
  state.stop(error)
  await state.closeAndDrain()
  if (handle) {
    try { await handle.abort(storedFailure(state.failure ?? error)) }
    catch { state.noteStorageFailure() }
  }
}
