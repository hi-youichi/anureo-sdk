import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { WorkflowContext, WorkflowOptions, WorkflowResult } from './workflow-types'
import { RunState, storedFailure } from './workflow-state'
import { runWith } from './run-context'
import { freezeJson, jsonCopy, type JsonValue } from './persistence/json'
import { openFileRun, type RunHandle } from './persistence/store'

/**
 * Run a body with a durable identity, frozen JSON input and journaled agent calls.
 * After saving the initial manifest, invoke the body with the new run's ID and input.
 * On resume, the body runs from the beginning and eligible agent calls reuse source journal results.
 * The body owns any side effects outside those reused calls and must account for re-execution.
 * Supply strict JSON for the input and the awaited body result, and await any background work
 * other than registered agent calls inside the body. Keep borrowed clients alive until the
 * workflow promise settles and dispose them separately.
 *
 * Resolve with a JSON copy of the body result after registered agent work settles, publication
 * succeeds and the writer lock is released. Drops and recovered ordinary agent failures can
 * yield an incomplete result. Invalid inputs, body errors, fatal agent failures, and storage
 * failures reject. Run failures report the run ID and storage root in SDK error details. A
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

/** Prepare workflow's storage options and body context from the same frozen input snapshot.
 * Missing or non-object options, a non-function body or non-JSON input throw before storage opens. */
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

/** Run workflow's body in the journal context and stop dispatch if it throws or rejects.
 * Drain before checking sticky failure so agent settlement can still change the outcome.
 * Return the JSON copy after publication. A rejection sends workflow through abortRun before release. */
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
