import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { z } from 'zod'
import { prepareOutputSchema, type AgentOutputSchema } from './output-schema'
import type { StepOptions } from './workflow-types'
import { RunState, isFatal, storedFailure } from './workflow-state'
import { canonicalJson, digest, freezeJson, jsonCopy, type JsonValue } from './persistence/json'
import type { AttemptRef, RunStore, StepSpec } from './persistence/store'

export class StepRunner {
  constructor(private readonly store: RunStore, private readonly state: RunState) {}

  step<S extends z.ZodObject>(
    options: StepOptions<S>,
    execute: () => z.output<S> | null | Promise<z.output<S> | null>,
  ): Promise<z.output<S>> {
    return this.state.track(options?.key, () => {
      if (!options || typeof options !== 'object') throw new HarnessSdkError('INVALID_PARAMS')
      const output = prepareOutputSchema(options.schema)
      const input = jsonCopy(options.input) as JsonValue
      const schema = jsonCopy(output.schema) as JsonValue
      const schemaDigest = digest(schema)
      const { name, revision, input: workflowInput } = this.store.identity
      const spec: StepSpec = {
        key: options.key, input, schema, schemaDigest,
        inputDigest: digest({ fingerprintVersion: 1, name, revision, workflowInput,
          stepKey: options.key, stepInput: input, schemaDigest }),
      }
      const recovery = options.recovery ?? 'manual'
      if (!['manual', 'repeatable'].includes(recovery) || typeof execute !== 'function'
        || (options.reuse !== undefined && typeof options.reuse !== 'function')) {
        throw new HarnessSdkError('INVALID_PARAMS')
      }
      return this.perform(spec, output, execute, recovery, options.reuse)
    })
  }

  private async io<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (cause) {
      const error = cause instanceof HarnessSdkError && isFatal(cause) ? cause
        : new HarnessSdkError('WORKFLOW_STORAGE_FAILED')
      this.state.stop(error)
      throw error
    }
  }

  private async perform<S extends z.ZodObject>(
    spec: StepSpec,
    output: AgentOutputSchema<S>,
    execute: () => z.output<S> | null | Promise<z.output<S> | null>,
    recovery: 'manual' | 'repeatable',
    reuse: StepOptions<S>['reuse'],
  ): Promise<z.output<S>> {
    let attempt: AttemptRef | undefined
    let executing = false
    try {
      const old = await this.io(() => this.store.prior(spec.key))
      this.state.assertDispatch()
      if (old.kind === 'committed' && old.inputDigest === spec.inputDigest
        && old.schemaDigest === spec.schemaDigest) {
        let value: z.output<S>
        try { value = await output.parse(canonicalJson(old.value)) }
        catch { throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID') }
        this.state.assertDispatch()
        const accepted = !reuse || await reuse(freezeJson(jsonCopy(value)))
        if (typeof accepted !== 'boolean') throw new HarnessSdkError('WORKFLOW_INVALID_REUSE_RESULT')
        if (accepted) {
          this.state.assertDispatch()
          attempt = await this.io(() => this.store.begin(spec, 'reuse'))
          await this.io(() => this.store.commit(attempt!, jsonCopy(value) as JsonValue, old.origin))
          return jsonCopy(value)
        }
      }
      if (old.kind !== 'missing' && recovery === 'manual') {
        const unknown = old.kind === 'uncommitted'
          && (old.outcome === 'started' || old.outcome === 'outcome_unknown')
        throw new HarnessSdkError('WORKFLOW_RECONCILIATION_REQUIRED',
          'Step requires application reconciliation', false, unknown)
      }
      this.state.assertDispatch()
      attempt = await this.io(() => this.store.begin(spec, 'execute'))
      this.state.assertDispatch() // started 写入期间，其他步骤可能已触发停止。
      executing = true
      const raw = await execute()
      executing = false
      if (raw === null) throw new HarnessSdkError('WORKFLOW_STEP_INCOMPLETE')
      const value = await output.parse(canonicalJson(raw))
      await this.io(() => this.store.commit(attempt!, jsonCopy(value) as JsonValue, null))
      return jsonCopy(value)
    } catch (cause) {
      const error = sdkError(cause, 'WORKFLOW_STEP_FAILED', executing)
      if (isFatal(error)) this.state.stop(error)
      // I/O 可能已发布完成记录；存储出错后不再追加矛盾的失败终态。
      if (attempt && error.code !== 'WORKFLOW_STORAGE_FAILED') {
        await this.io(() => this.store.fail(attempt!, storedFailure(error)))
      }
      throw error
    }
  }
}
