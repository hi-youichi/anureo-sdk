// Runs isolated agent sessions and integrates their observed changes.
import { mkdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { agent } from '@anureo/workflow'
import { runChecks, type CheckCommand } from './checks'
import { failure, message } from './errors'
import { inspectGitPath } from './git-path'
import { captureTree, changes, fileFingerprint } from './git-tree'
import type { RefactorOptions } from './options'
import type { StepResult } from './results'
import { workSchema } from './schema'
import { isSource, isTextSource } from './source-policy'
import { createAgentWorktree, mergeWorktree, prepareCheckDependencies, removeAgentWorktree, withWorktreeBaseline, type AgentWorktree, type WorktreeBaseline } from './worktree'

/** Run one callback in a fresh checkout of the supplied baseline. The callback must await all
 * work that uses the checkout. Removal is awaited before returning its result or propagating its
 * error. If the callback and removal both fail, preserve primary diagnostics and report both
 * errors. The caller owns the baseline. */
export async function inAgentWorktree<T>(baseline: WorktreeBaseline, use: (worktree: AgentWorktree) => Promise<T>): Promise<T> {
  const worktree = await createAgentWorktree(baseline)
  let result: T
  try {
    result = await use(worktree)
  } catch (primary) {
    try {
      await removeAgentWorktree(baseline, worktree)
    } catch (cleanup) {
      const { code, outcomeUnknown, retryable, issues } = failure(primary)
      throw Object.assign(new AggregateError([primary, cleanup], `${message(primary)}\n${message(cleanup)}`), {
        code, outcomeUnknown, retryable, details: { issues, cleanupErrors: [message(cleanup)] },
      })
    }
    throw primary
  }
  await removeAgentWorktree(baseline, worktree)
  return result
}

/** Run a session, then validate and merge its edits on the caller's writer queue.
 * Cleanup is awaited. Return null when dispatch stops during checkout setup. */
export async function runAgentWork(input: AgentWorkInput): Promise<StepResult | null> {
  const step: StepResult = { summary: '', changes: [], deferred: [], status: 'unchanged', changedFiles: [], checks: [], error: null, failure: null }
  const recordFailure = (cause: unknown) => {
    markFailed(step, cause)
    if (input.dispatch && (step.failure?.outcomeUnknown || step.failure?.cleanupFailed)) input.dispatch.stopped = true
  }
  try {
    return await inAgentWorktree(input.baseline, async worktree => {
      const before = await captureTree(worktree.root)
      if (input.dispatch?.stopped) return null
      try {
        const { options, prompt } = input
        const work = await agent(prompt, {
          client: options.client, cwd: worktree.cwd, model: options.model,
          permissionMode: options.reviewOnly ? options.readPermissionMode : options.editPermissionMode,
          schema: workSchema, outputFallback: 'json-text',
        })
        if (!work) throw new Error('Agent returned no result')
        Object.assign(step, work)
      } catch (cause) {
        recordFailure(cause)
      }
      const edited = await captureTree(worktree.root)
      await recordAgentEdits(input, worktree, changes(before, edited), before, step)
      if (step.status !== 'failed' && step.changedFiles.length) {
        await input.publish(() => validateAndMerge(input, worktree, step)).catch(recordFailure)
      }
      return step
    })
  } catch (cause) {
    recordFailure(cause)
    return step
  }
}

/** Validate the candidate on the current target snapshot while holding the writer queue. */
async function validateAndMerge(input: AgentWorkInput, candidate: AgentWorktree, step: StepResult): Promise<void> {
  const { baseline, checks, options } = input
  const apply = async (destination: WorktreeBaseline, source: AgentWorktree) => {
    await mergeWorktree(destination, source, step.changedFiles)
    step.appliedFiles = [...step.changedFiles]
    step.status = 'applied'
  }
  if (!checks.length) return apply(baseline, candidate)

  await withWorktreeBaseline(options.cwd, fresh => inAgentWorktree(
    { ...fresh, updateWorktreeRegistry: baseline.updateWorktreeRegistry },
    async validation => {
      const target = join(fresh.root, fresh.scope)
      for (const file of step.changedFiles) {
        // Ignored paths can exist in the target even when absent from both snapshots.
        if (await fileFingerprint(target, file) !== await fileFingerprint(validation.cwd, file)) {
          throw new Error(`Source changed during refactor: ${file}`)
        }
      }
      const beforeOverlay = await captureTree(validation.root)
      await mkdir(join(validation.cwd, '.anureo', 'refactor'), { recursive: true })
      await mergeWorktree({ ...baseline, root: validation.root }, candidate, step.changedFiles)
      await prepareCheckDependencies(fresh, validation)
      const beforeChecks = await captureTree(validation.root)
      const checkedFiles = await Promise.all(step.changedFiles.map(file => fileFingerprint(validation.cwd, file)))
      await runChecks(validation.cwd, checks, step.checks)
      const changedByChecks = changes(beforeChecks, await captureTree(validation.root))
      for (const [index, file] of step.changedFiles.entries()) {
        if (await fileFingerprint(validation.cwd, file) !== checkedFiles[index]) {
          changedByChecks.push(fresh.scope ? join(fresh.scope, file).split(sep).join('/') : file)
        }
      }
      if (changedByChecks.length) throw new Error(`Validation modified source files: ${[...new Set(changedByChecks)].sort().join(', ')}`)
      const changedDuringChecks = changes(beforeOverlay, await captureTree(fresh.root))
      if (changedDuringChecks.length) throw new Error(`Source changed during refactor: ${changedDuringChecks.join(', ')}`)
      await apply(fresh, validation)
    },
  ))
}

/** Preserve the first error's classification and append any later cleanup diagnostics. */
function markFailed(step: StepResult, cause: unknown): void {
  const observed = failure(cause)
  if (step.failure) {
    step.failure.cleanupFailed ||= observed.cleanupFailed
    step.error += `\n${message(cause)}`
    return
  }
  step.status = 'failed'
  step.error = message(cause)
  if (step.appliedFiles?.length) step.error += ` (Files already applied: ${step.appliedFiles.join(', ')})`
  step.failure = observed
}

interface AgentWorkInput {
  baseline: WorktreeBaseline
  options: RefactorOptions
  prompt: string
  checks: readonly CheckCommand[]
  publish: (operation: () => Promise<void>) => Promise<void>
  /** Shared module admission state. Active sessions still settle and record their results. */
  dispatch?: { stopped: boolean }
  /** Editable inventory for design or the validated assignment for a module. */
  assignedFiles: readonly string[]
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

/** Allow assigned deletions and edits or additions that qualify as text source. */
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
  const nonText: string[] = []
  for (const file of changedFiles) {
    if (assigned.has(file)) {
      const { info, linkedAncestor } = await inspectGitPath(cwd, file)
      if ((info || linkedAncestor) && !await isTextSource(cwd, file)) nonText.push(file)
      continue
    }
    if (!before.has(scopePrefix + file) && isSource(file, options.include, options.exclude)
      && await isTextSource(cwd, file)) continue
    violations.push(file)
  }
  if (violations.length) throw new Error(`Module edited paths outside its assignment: ${violations.join(', ')}`)
  if (nonText.length) throw new Error(`Assigned files must remain text source: ${nonText.join(', ')}`)
}
