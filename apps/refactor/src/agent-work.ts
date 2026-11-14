// Runs isolated agent sessions and integrates their observed changes.
import { sep } from 'node:path'
import { agent } from '@anureo/workflow'
import { runChecks, type CheckCommand } from './checks'
import { failure, message } from './errors'
import { captureTree, changes } from './git-tree'
import type { RefactorOptions } from './options'
import type { StepResult } from './results'
import { workSchema } from './schema'
import { isSource, isTextSource } from './source-policy'
import { createAgentWorktree, mergeWorktree, prepareCheckDependencies, removeAgentWorktree, type AgentWorktree, type WorktreeBaseline } from './worktree'

/** Run one callback in a fresh checkout of the supplied baseline. The callback must await all
 * work that uses the checkout. Removal is awaited before returning its result or propagating its
 * error. Creation and removal failures propagate, and a removal failure takes precedence over
 * a callback failure. The caller owns the baseline. */
export async function inAgentWorktree<T>(baseline: WorktreeBaseline, use: (worktree: AgentWorktree) => Promise<T>): Promise<T> {
  const worktree = await createAgentWorktree(baseline)
  try {
    return await use(worktree)
  } finally {
    await removeAgentWorktree(baseline, worktree)
  }
}

/** Run a session, validate its edits in the worktree, and merge on the caller's writer queue.
 * A failed session, policy check or validation leaves the target untouched. Cleanup is awaited. */
export async function runAgentWork(input: AgentWorkInput): Promise<StepResult> {
  const step: StepResult = { summary: '', changes: [], deferred: [], status: 'unchanged', changedFiles: [], checks: [], error: null, failure: null }
  try {
    await inAgentWorktree(input.baseline, async worktree => {
      const before = await captureTree(worktree.root)
      await recordSessionResult(input, worktree.cwd, step)
      const edited = await captureTree(worktree.root)
      await recordAgentEdits(input, worktree, changes(before, edited), before, step)
      if (step.status === 'failed' || !step.changedFiles.length) return
      if (input.checks.length) {
        await prepareCheckDependencies(input.baseline, worktree)
        const beforeChecks = await captureTree(worktree.root)
        await runChecks(worktree.cwd, input.checks, step.checks)
        const changedByChecks = changes(beforeChecks, await captureTree(worktree.root))
        if (changedByChecks.length) throw new Error(`Validation modified source files: ${changedByChecks.join(', ')}`)
      }
      await input.publish(async () => {
        await mergeWorktree(input.baseline, worktree, step.changedFiles)
        step.status = 'applied'
      })
    })
  } catch (cause) {
    markFailed(step, cause)
  }
  return step
}

/** Mark a step failed in place. Later errors append diagnostics and can record a cleanup
 * failure while preserving the first error's code and outcome uncertainty. recordSessionResult and
 * runAgentWork record caught errors here. Error conversion itself can throw for custom error objects. */
export function markFailed(step: StepResult, cause: unknown): void {
  const observed = failure(cause)
  if (step.failure) {
    step.failure.cleanupFailed ||= observed.cleanupFailed
    step.error += `\n${message(cause)}`
    return
  }
  step.status = 'failed'
  step.error = message(cause)
  step.failure = observed
}

interface AgentWorkInput {
  baseline: WorktreeBaseline
  options: RefactorOptions
  prompt: string
  checks: readonly CheckCommand[]
  publish: (operation: () => Promise<void>) => Promise<void>
  /** Editable inventory for design or the validated assignment for a module. */
  assignedFiles: readonly string[]
}

/** Merge the schema-validated response into the step after the workflow agent settles. Record
 * session failure, including a missing result, so runAgentWork can still inspect the checkout. */
async function recordSessionResult({ options, prompt }: AgentWorkInput, cwd: string, step: StepResult): Promise<void> {
  try {
    const work = await agent(prompt, {
      client: options.client, cwd, model: options.model,
      permissionMode: options.reviewOnly ? options.readPermissionMode : options.editPermissionMode,
      schema: workSchema, outputFallback: 'json-text',
    })
    if (!work) throw new Error('Agent returned no result')
    Object.assign(step, work)
  } catch (cause) {
    markFailed(step, cause)
  }
}

/** Record target-relative edits and reject writes outside the worktree assignment. */
async function recordAgentEdits(
  { baseline, options, assignedFiles }: AgentWorkInput,
  worktree: AgentWorktree,
  touched: readonly string[],
  before: ReadonlyMap<string, string>,
  step: StepResult,
): Promise<void> {
  const scopePrefix = baseline.scope ? baseline.scope.split(sep).join('/') + '/' : ''
  const changedFiles = touched.filter(file => file.startsWith(scopePrefix)).map(file => file.slice(scopePrefix.length))
  step.changedFiles = changedFiles
  if (touched.length !== changedFiles.length) throw new Error('Agent changed paths outside the refactor target')
  if (options.reviewOnly && touched.length) throw new Error('Review-only agent modified files')
  await validateModuleEdits({ assignedFiles, changedFiles, before, scopePrefix, cwd: worktree.cwd, options })
}

/** Allow assigned paths and newly added files that qualify as text source. Report every other
 * edited path in diff order. Source inspection can also reject. */
async function validateModuleEdits(input: {
  assignedFiles: readonly string[]
  changedFiles: readonly string[]
  before: ReadonlyMap<string, string>
  scopePrefix: string
  cwd: string
  options: RefactorOptions
}): Promise<void> {
  const { assignedFiles, changedFiles, before, scopePrefix, cwd, options } = input
  const assigned = new Set(assignedFiles)
  const violations: string[] = []
  for (const file of changedFiles) {
    if (assigned.has(file)) continue
    if (!before.has(scopePrefix + file) && isSource(file, options.include, options.exclude)
      && await isTextSource(cwd, file)) continue
    violations.push(file)
  }
  if (violations.length) throw new Error(`Module edited paths outside its assignment: ${violations.join(', ')}`)
}
