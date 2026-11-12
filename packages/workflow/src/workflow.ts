import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { WorkflowContext, WorkflowOptions, WorkflowResult } from './workflow-types'
import { RunState, storedFailure } from './workflow-state'
import { runWith } from './run-context'
import { freezeJson, jsonCopy, type JsonValue } from './persistence/json'
import { openFileRun, type RunHandle } from './persistence/store'

export async function workflow<Input, Result>(
  options: WorkflowOptions<Input>,
  body: (run: WorkflowContext<Input>) => Result | Promise<Result>,
): Promise<WorkflowResult<Awaited<Result>>> {
  const runId = options?.runId ?? randomUUID()
  const state = new RunState()
  let handle: RunHandle | undefined
  let value: Awaited<Result> | undefined
  try {
    if (!options || typeof options !== 'object' || typeof body !== 'function') {
      throw new HarnessSdkError('INVALID_PARAMS')
    }
    const input = freezeJson(jsonCopy(options.input))
    const resumeFrom = options.resumeFrom && typeof options.resumeFrom === 'object'
      ? { ...options.resumeFrom } : options.resumeFrom
    handle = await openFileRun({ ...options, runId, input: input as JsonValue, resumeFrom })
    const context: WorkflowContext<Input> = { runId, input }
    try {
      value = await runWith({ journal: handle.journal, state }, async () => body(context))
    }
    catch (cause) { state.stop(sdkError(cause, 'WORKFLOW_BODY_FAILED')) }
    await state.closeAndDrain()
    const failure = state.failure
    if (failure) throw failure
    value = jsonCopy(value)
    await handle.finish(state.status, value as JsonValue)
  } catch (cause) {
    state.stop(sdkError(cause, 'WORKFLOW_FAILED'))
    await state.closeAndDrain()
    if (handle) {
      try { await handle.abort(storedFailure(state.failure!)) }
      catch { state.stop(new HarnessSdkError('WORKFLOW_STORAGE_FAILED')) }
    }
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
