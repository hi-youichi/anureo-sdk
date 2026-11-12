import { join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { z } from 'zod'
import type { WorkflowContext } from '@anureo/workflow'
import { analysisSchema, verificationSchema } from './schema'
import { hash, snapshotSchema, SnapshotIntegrityError, type ReviewContext, type Snapshot } from './context'
import { saveJson } from './io'
import type { TaskResult } from './review'
import { planningSchema, validatePlanning, PlanningValidationError, type InventoryPlan, type Planning } from './planning'

const taskSchema = z.strictObject({
  id: z.string(), unitId: z.string(), level: z.literal('module'), view: z.string(),
  moduleId: z.string(), angleId: z.string(), dimensions: z.array(z.string()),
  primaryFiles: z.array(z.string()), packagePaths: z.array(z.string()),
  purpose: z.string(), dependsOn: z.array(z.string()),
})

const taskResultSchema = z.strictObject({
  task: taskSchema, status: z.literal('completed'), error: z.null(),
  snapshotIds: z.array(z.string()), analysis: analysisSchema,
  findings: z.array(analysisSchema.shape.findings.element.extend({ id: z.string(), taskId: z.string() })),
  verification: verificationSchema.nullable(), inputHash: z.string(), reused: z.boolean(),
})
export const taskCheckpointSchema = z.strictObject({
  result: taskResultSchema,
  snapshots: z.array(snapshotSchema),
})

export function fatalReviewError(cause: unknown): boolean {
  const error = cause as { code?: string; outcomeUnknown?: boolean; details?: Record<string, unknown> }
  return error?.outcomeUnknown === true || error?.code === 'RESOURCE_RELEASE_FAILED'
    || error?.code === 'WORKFLOW_STORAGE_FAILED' || error?.code === 'WORKFLOW_CHECKPOINT_INVALID'
    || (Array.isArray(error?.details?.cleanupErrors) && error.details.cleanupErrors.length > 0)
}

/** Agent failures already carry native uncertainty; local evidence/coverage failures are known. */
function reviewError(cause: unknown): HarnessSdkError {
  if (cause instanceof SnapshotIntegrityError) return new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID')
  return cause instanceof HarnessSdkError ? cause
    : new HarnessSdkError('REVIEW_VALIDATION_FAILED', cause instanceof Error ? cause.message : 'Review validation failed')
}

async function matchingSnapshots(context: ReviewContext, snapshots: readonly Snapshot[]) {
  try { return await context.matchesSavedSnapshots(snapshots) }
  catch (cause) { if (cause instanceof SnapshotIntegrityError) throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID'); throw cause }
}

function adoptSnapshots(context: ReviewContext, snapshots: readonly Snapshot[], validate: () => true) {
  try { context.adoptSnapshots(snapshots, validate) }
  catch (cause) { if (cause instanceof SnapshotIntegrityError) throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID'); throw cause }
}

function snapshotsFor(context: ReviewContext, ids: readonly string[]) {
  return ids.map(id => {
    const snapshot = context.snapshots.get(id)
    if (!snapshot) throw new HarnessSdkError('WORKFLOW_EVIDENCE_MISSING')
    return snapshot
  })
}

async function saveSnapshots(outputDir: string, snapshots: readonly Snapshot[]) {
  for (const snapshot of snapshots) await saveJson(join(outputDir, 'snapshots', `${hash(snapshot.id)}.json`), snapshot)
}

export async function checkpointPlanning<Input>(options: {
  run: WorkflowContext<Input>; context: ReviewContext; outputDir: string; inventory: InventoryPlan
  input: unknown; repeatable: boolean
  execute: () => Promise<{ proposal: Planning; snapshotIds: string[] }>
}) {
  const schema = z.strictObject({ proposal: planningSchema, snapshots: z.array(snapshotSchema) })
  const restoreValidateAndSave = async (value: z.output<typeof schema>) => {
    adoptSnapshots(options.context, value.snapshots, () => {
      const issues = validatePlanning(options.context, options.inventory, value.proposal, value.snapshots.map(s => s.id))
      if (value.proposal.status !== 'planned' || issues.length) throw new PlanningValidationError(issues)
      return true
    })
    await saveSnapshots(options.outputDir, value.snapshots)
  }
  return options.run.step({ key: 'planning', schema, input: options.input,
    recovery: options.repeatable ? 'repeatable' : 'manual', reuse: async saved => {
      if (!await matchingSnapshots(options.context, saved.snapshots)) return false
      await restoreValidateAndSave(saved)
      return true
    } }, async () => {
    try {
      const accepted = await options.execute()
      const value = await schema.parseAsync({ proposal: accepted.proposal, snapshots: snapshotsFor(options.context, accepted.snapshotIds) })
      await restoreValidateAndSave(value)
      return value
    } catch (cause) { throw reviewError(cause) }
  })
}

export async function checkpointTask<Input>(options: {
  run: WorkflowContext<Input>
  context: ReviewContext
  outputDir: string
  taskId: string
  input: unknown
  repeatable: boolean
  execute: () => Promise<TaskResult>
  canReuse: (result: TaskResult) => boolean
  validate: (result: TaskResult) => void
}): Promise<TaskResult> {
  const { run, context, outputDir } = options
  let reused = false
  async function materialize(bundle: z.output<typeof taskCheckpointSchema>, reused = false) {
    adoptSnapshots(context, bundle.snapshots, () => { options.validate(bundle.result); return true })
    try {
      await saveSnapshots(outputDir, bundle.snapshots)
      await saveJson(join(outputDir, 'tasks', `${hash(options.taskId)}.json`), { ...bundle.result, reused })
    } catch { throw new HarnessSdkError('WORKFLOW_STORAGE_FAILED') }
  }
  const bundle = await run.step({
    key: `task:${options.taskId}`, input: options.input,
    schema: taskCheckpointSchema, recovery: options.repeatable ? 'repeatable' : 'manual',
    reuse: async saved => {
      if (saved.result.task.id !== options.taskId) {
        throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID')
      }
      const ids = new Set(saved.result.snapshotIds)
      if (ids.size !== saved.result.snapshotIds.length || ids.size !== saved.snapshots.length || saved.snapshots.some(s => !ids.has(s.id))
        || new Set(saved.snapshots.map(s => s.id)).size !== ids.size) {
        throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID')
      }
      if (!await matchingSnapshots(context, saved.snapshots)) return false
      if (!options.canReuse(saved.result)) return false
      await materialize(saved, true)
      reused = true
      return true
    },
  }, async () => {
    try {
      const result = await options.execute()
      if (result.status !== 'completed') throw new HarnessSdkError('WORKFLOW_STEP_INCOMPLETE')
      options.validate(result)
      const snapshots = snapshotsFor(context, result.snapshotIds)
      const value = await taskCheckpointSchema.parseAsync({ result: { ...result, reused: false }, snapshots })
      await materialize(value)
      return value
    } catch (cause) { throw reviewError(cause) }
  })
  return { ...bundle.result, reused }
}
