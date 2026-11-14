import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { WorkflowContext, WorkflowOptions, WorkflowResult } from './workflow-types'
import { RunState, storedFailure } from './workflow-state'
import { runWith } from './run-context'
import { freezeJson, jsonCopy, type JsonValue } from './persistence/json'
import { openFileRun, type RunHandle } from './persistence/store'

/**
 * Run a body with a durable identity, frozen JSON input and journaled agent calls.
 * The initial manifest is saved before body entry. Resume reruns the body in a new run,
 * reusing eligible agent results from the source journal rather than its final result.
 * Input and the awaited body result must be strict JSON values; lossy values reject.
 * Resolves after registered agent work settles, the result is published and the writer lock
 * is released. Caught ordinary agent failures can produce an incomplete result; body errors,
 * fatal agent failures and persistence or lock-release failures reject with runId and directory
 * in the error details. Keep borrowed clients alive until settlement and dispose them separately.
 * Await other background work in the body; only registered agent work participates in the drain.
 */
export async function workflow<Input, Result>(
  options: WorkflowOptions<Input>,
  body: (run: WorkflowContext<Input>) => Result | Promise<Result>,
): Promise<WorkflowResult<Awaited<Result>>> {
  const runId = options?.runId ?? randomUUID()
  const state = new RunState()
  let handle: RunHandle | undefined
  let value: Awaited<Result> | undefined
  try {
    const prepared = prepareRun(options, body)
    handle = await openFileRun({ ...options, runId, input: prepared.input as JsonValue, resumeFrom: prepared.resumeFrom })
    value = await completeRun({ handle, state, body, context: { runId, input: prepared.input } })
  } catch (cause) {
    await abortRun({ cause, state, handle })
  } finally {
    if (handle) {
      try { await handle.close() }
      catch { state.stop(new HarnessSdkError('WORKFLOW_STORAGE_FAILED')) }
    }
  }
  const failure = state.failure
  if (failure) {
    throw new HarnessSdkError(failure.code, failure.message, false, failure.outcomeUnknown,
      { ...failure.details, runId, directory: handle?.identity.directory ?? options?.directory })
  }
  return { runId, status: state.status, result: value as Awaited<Result> }
}

/** Snapshot caller-owned input and resume coordinates before workflow acquires a run handle.
 * Non-object options, a non-function body or non-JSON input throw before storage or body execution. */
function prepareRun<Input, Result>(
  options: WorkflowOptions<Input>,
  body: (run: WorkflowContext<Input>) => Result | Promise<Result>,
) {
  if (!options || typeof options !== 'object' || typeof body !== 'function') {
    throw new HarnessSdkError('INVALID_PARAMS')
  }
  const input = freezeJson(jsonCopy(options.input))
  const resumeFrom = options.resumeFrom && typeof options.resumeFrom === 'object'
    ? { ...options.resumeFrom } : options.resumeFrom
  return { input, resumeFrom }
}

/** Execute workflow's body in the ambient journal, then drain before checking fatal state.
 * Body failures stop dispatch but still wait for registered work. Publication happens only
 * after a successful drain and JSON copy; failures reject for workflow to abort and release. */
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

/** Record workflow's failure and drain before marking an acquired run failed.
 * Abort publication errors join the sticky failures; workflow still owns handle closure
 * and reports the aggregate after closure. Initialization failures may have no handle. */
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
    catch { state.stop(new HarnessSdkError('WORKFLOW_STORAGE_FAILED')) }
  }
}
