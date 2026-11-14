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
import { applyWorktreePatch, captureWorktreePatch, createAgentWorktree, removeAgentWorktree, type AgentWorktree, type WorktreeBaseline } from './worktree'

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

/** Run a design or module session and return observed edits after checkout cleanup.
 * runDesign and runModules use the returned step to decide what can be integrated. Session,
 * capture, policy and checkout failures are recorded on the step. Capture still runs after a
 * session failure so any patch can be recovered. Review-only work and out-of-target edits
 * stop before writing a patch. The caller supplies the patch destination and owns the baseline
 * and client. A step with a patch still requires a separate integration decision. */
export async function runAgentWork(input: AgentWorkInput): Promise<StepResult> {
  const step: StepResult = { summary: '', changes: [], deferred: [], status: 'unchanged', changedFiles: [], checks: [], error: null, failure: null }
  try {
    await inAgentWorktree(input.baseline, async worktree => {
      const before = await captureTree(worktree.root)
      await recordSessionResult(input, worktree.cwd, step)
      await recordAgentEdits(input, worktree, before, step)
    })
  } catch (cause) {
    markFailed(step, cause)
  }
  return step
}

/** Apply an available patch and record validation in the target checkout. Design can apply a failed
 * step's patch without running checks. Module integration skips failed steps with their patches
 * intact. Apply and check failures are recorded on the step without rolling back applied edits.
 * Callers serialize integration and publish the mutated step after this settles. */
export async function integrateAgentWork(input: {
  phase: 'design' | 'module'
  baseline: WorktreeBaseline
  cwd: string
  step: StepResult
  checks: readonly CheckCommand[]
}): Promise<void> {
  const { phase, baseline, cwd, step, checks } = input
  if (!step.patch || (step.status === 'failed' && phase === 'module')) return
  try {
    await applyWorktreePatch(baseline, step.changedFiles, step.patch)
    if (step.status === 'failed') return
    step.status = 'applied'
    await runChecks(cwd, checks, step.checks)
  } catch (cause) {
    markFailed(step, cause)
  }
}

/** Mark a step failed in place. Later errors append diagnostics and can record a cleanup
 * failure while preserving the first error's code and outcome uncertainty. recordSessionResult,
 * runAgentWork and integrateAgentWork record caught errors here. integrateModules uses it when
 * an earlier failure blocks a patch. Error conversion itself can throw for custom error objects. */
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
  patchPath: string
  /** Paths already assigned to this module. Omission skips module assignment validation. */
  assignedFiles?: readonly string[]
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

/** Compare the checkout with its pre-session snapshot and record target-relative paths. Reject
 * out-of-target and review-only writes before patch capture. Check the module assignment after
 * persisting the patch so a failed assignment still leaves the edits available for inspection. */
async function recordAgentEdits(
  { baseline, options, patchPath, assignedFiles }: AgentWorkInput,
  worktree: AgentWorktree,
  before: ReadonlyMap<string, string>,
  step: StepResult,
): Promise<void> {
  const touched = changes(before, await captureTree(worktree.root))
  const scopePrefix = baseline.scope ? baseline.scope.split(sep).join('/') + '/' : ''
  const changedFiles = touched.filter(file => file.startsWith(scopePrefix)).map(file => file.slice(scopePrefix.length))
  step.changedFiles = changedFiles
  if (touched.length !== changedFiles.length) throw new Error('Agent changed paths outside the refactor target')
  if (options.reviewOnly && touched.length) throw new Error('Review-only agent modified files')
  if (changedFiles.length) {
    await writeFile(patchPath, await captureWorktreePatch(baseline, worktree, changedFiles))
    step.patch = patchPath
  }
  if (assignedFiles) {
    await validateModuleEdits({ assignedFiles, changedFiles, before, scopePrefix, cwd: worktree.cwd, options })
  }
}

/** Allow assigned paths and newly added files that qualify as text source. Report every other
 * edited path in diff order. Source inspection can also reject, leaving the patch available. */
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
