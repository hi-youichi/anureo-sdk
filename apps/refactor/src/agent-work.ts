// Runs isolated agent sessions and integrates their observed changes.
import { writeFile } from 'node:fs/promises'
import { sep } from 'node:path'
import { agent } from '@anureo/workflow'
import { runChecks, type CheckCommand } from './checks'
import { failure, message } from './errors'
import { captureTree, changes } from './git-tree'
import type { RefactorOptions } from './options'
import type { StepResult } from './results'
import { workSchema } from './schema'
import { isSource, isTextSource } from './source-policy'
import { applyWorktreePatch, captureWorktreePatch, createAgentWorktree, removeAgentWorktree, type WorktreeBaseline } from './worktree'

/** Wait for a read-only session and release its checkout before returning its result. */
export async function inAgentWorktree<T>(baseline: WorktreeBaseline, use: (cwd: string) => Promise<T>): Promise<T> {
  const worktree = await createAgentWorktree(baseline)
  try {
    return await use(worktree.cwd)
  } finally {
    await removeAgentWorktree(baseline, worktree)
  }
}

/** Capture edits in a private worktree and persist a patch before releasing it.
 * Failed module work can be recovered from its patch, while review-only sessions produce no patch. */
export async function runAgentWork(input: {
  baseline: WorktreeBaseline
  options: RefactorOptions
  prompt: string
  patchPath: string
  assignedFiles?: readonly string[]
}): Promise<StepResult> {
  const { baseline, options, prompt, patchPath, assignedFiles } = input
  const step: StepResult = { summary: '', changes: [], deferred: [], status: 'unchanged', changedFiles: [], checks: [], error: null, failure: null }
  try {
    const worktree = await createAgentWorktree(baseline)
    try {
      const before = await captureTree(worktree.root)
      try {
        const work = await agent(prompt, {
          client: options.client, cwd: worktree.cwd, model: options.model,
          permissionMode: options.reviewOnly ? options.readPermissionMode : options.editPermissionMode,
          schema: workSchema, outputFallback: 'json-text',
        })
        if (!work) throw new Error('Agent returned no result')
        Object.assign(step, work)
      } catch (cause) {
        markFailed(step, cause)
      }

      const touched = changes(before, await captureTree(worktree.root))
      const prefix = baseline.scope ? baseline.scope.split(sep).join('/') + '/' : ''
      const scoped = touched.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length))
      step.changedFiles = scoped
      if (touched.length !== scoped.length) throw new Error('Agent changed paths outside the refactor target')
      if (options.reviewOnly && touched.length) throw new Error('Review-only agent modified files')
      if (scoped.length) {
        await writeFile(patchPath, await captureWorktreePatch(baseline, worktree, scoped))
        step.patch = patchPath
      }
      if (assignedFiles) {
        const assigned = new Set(assignedFiles)
        const violations = []
        for (const file of scoped) {
          if (assigned.has(file)) continue
          if (!before.has(prefix + file) && isSource(file, options.include, options.exclude)
            && await isTextSource(worktree.cwd, file)) continue
          violations.push(file)
        }
        if (violations.length) throw new Error(`Module edited paths outside its assignment: ${violations.join(', ')}`)
      }
    } finally {
      await removeAgentWorktree(baseline, worktree)
    }
  } catch (cause) {
    markFailed(step, cause)
  }
  return step
}

/** Integrate a step and run checks against the target with its existing local dependencies.
 * Design can retain partial edits on agent failure. Module failures leave their patch for inspection. */
export async function integrateAgentWork(input: {
  baseline: WorktreeBaseline
  options: RefactorOptions
  step: StepResult
  checks: readonly CheckCommand[]
  retainPartial?: boolean
}): Promise<void> {
  const { baseline, options, step, checks, retainPartial } = input
  if (!step.patch || (step.status === 'failed' && !retainPartial)) return
  try {
    await applyWorktreePatch(baseline, step.changedFiles, step.patch)
    if (step.status === 'failed') return
    step.status = 'applied'
    await runChecks(options.cwd, checks, step.checks)
  } catch (cause) {
    markFailed(step, cause)
  }
}

/** Record a failed session, merge, or check while preserving a primary agent error. */
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
