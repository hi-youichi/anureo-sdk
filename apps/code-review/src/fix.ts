// Executes eligible fixes and reports outcomes using fix-tree's Git reconciliation.
import { HarnessSdkError, type Client } from '@anureo/sdk'
import { relative, resolve, sep } from 'node:path'
import { agent } from '@anureo/workflow'
import { reviewFailure } from './errors'
import { fixResultSchema } from './schema'
import { buildFixPrompt } from './prompts'
import type { FixReport, ModuleReview } from './results'
import { captureWorkingTreeBaseline, inspectWorkingTreeChanges } from './fix-tree'
import { applyFixPatch, capturePatchBaseline } from './fix-patch'
import { reviewGit, reviewRepositoryRoot, withAgentWorktree } from './worktree'

export type { FixReport } from './results'

/** Isolate a module's fix and apply its validated patch to the original work tree.
 * Incomplete reviews and empty findings skip worktree creation. */
export async function fixFindings(options: FixOptions): Promise<FixReport> {
  const { modules } = options
  if (modules.some(module => module.angles.some(angle => angle.status !== 'completed'))) {
    options.onProgress?.('skipped')
    return { status: 'skipped', summary: 'Fix skipped because the selected review is incomplete.', changedFiles: [], error: null }
  }
  const findings = modules.flatMap(module => module.angles.flatMap(angle => angle.status === 'completed'
    ? angle.findings.map(finding => ({ moduleId: module.module.id, angleId: angle.angle.id, ...finding })) : []))
  if (findings.length === 0) {
    options.onProgress?.('skipped')
    return { status: 'not-needed', summary: 'No findings to fix.', changedFiles: [], error: null }
  }
  const files = modules.flatMap(module => module.module.files)
  const prompt = buildFixPrompt({ sourceVersion: options.sourceVersion, findings, files })
  options.onProgress?.('started')
  return applyFix(options, prompt, files)
}

/** Inputs supplied by createFixRunner after it acquires writer and agent capacity. */
interface FixOptions {
  /** Source fingerprint embedded in the fix prompt; null outside git. */
  sourceVersion: string | null
  client: Client
  /** Canonical absolute review directory; module file paths are validated relative to it. */
  cwd: string
  repositoryRoot?: string
  /** Absolute workflow storage directory, excluded from Git change discovery. */
  directory: string
  modules: readonly ModuleReview[]
  model?: string
  /** Forwarded to session creation; omission selects the session default. */
  permissionMode?: string
  /** Invoked synchronously. 'not-needed' and 'skipped' reports both emit 'skipped'.
   * createFixRunner forwards these to reviewCode's protected progress observer. */
  onProgress?: (status: 'started' | 'completed' | 'failed' | 'skipped') => void
}

type ReconciledFix = Pick<FixReport, 'summary' | 'changedFiles'>

async function applyFix(options: FixOptions, prompt: string, files: readonly string[]): Promise<FixReport> {
  let outcome: ReconciledFix | undefined
  try {
    const root = options.repositoryRoot ?? await reviewRepositoryRoot(options.cwd)
    await withAgentWorktree({ root, cwd: options.cwd, directory: options.directory }, async (cwd, _directory, checkout) => {
      if (!checkout) throw new Error('Fix worktree was not created')
      const allowed = files.map(file => relative(root, resolve(options.cwd, file)).split(sep).join('/'))
      const baseline = await captureWorkingTreeBaseline(checkout.root, allowed)
      await capturePatchBaseline(checkout, allowed)
      const head = await reviewGit(checkout.root, 'rev-parse', 'HEAD')
      const index = await reviewGit(checkout.root, 'ls-files', '--stage', '-z')
      const output = await agent(prompt, {
        client: options.client, cwd, model: options.model, schema: fixResultSchema,
        ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      })
      if (output === null) throw new HarnessSdkError('REVIEW_AGENT_INCOMPLETE', 'Fix agent returned no result')
      if (await reviewGit(checkout.root, 'rev-parse', 'HEAD') !== head
          || await reviewGit(checkout.root, 'ls-files', '--stage', '-z') !== index) {
        throw new HarnessSdkError('REVIEW_FIX_SCOPE', 'Fix changed Git HEAD or the index in its worktree')
      }
      const { changedFiles, violations } = await inspectWorkingTreeChanges(baseline)
      if (violations.length > 0) {
        throw new HarnessSdkError('REVIEW_FIX_SCOPE', `Fix changed paths outside the selected source files: ${violations.join(', ')}`)
      }
      if (changedFiles.length > 0) await applyFixPatch(root, checkout, changedFiles)
      outcome = { summary: output.summary,
        changedFiles: changedFiles.map(file => relative(options.cwd, resolve(root, file)).split(sep).join('/')) }
    })
    if (!outcome) throw new Error('Fix worktree did not produce an outcome')
    if (outcome.changedFiles.length === 0) {
      options.onProgress?.('skipped')
      return { status: 'skipped', ...outcome, error: null }
    }
    options.onProgress?.('completed')
    return { status: 'applied', ...outcome, error: null }
  } catch (cause) {
    options.onProgress?.('failed')
    return { status: 'failed', summary: outcome?.summary ?? 'Fix failed.',
      changedFiles: outcome?.changedFiles ?? [], error: reviewFailure(cause) }
  }
}
