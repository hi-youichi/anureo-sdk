// Runs a fix agent in an isolated checkout and reports edits integrated into the original tree.
import { HarnessSdkError, type Client } from '@anureo/sdk'
import { relative, resolve, sep } from 'node:path'
import { agent } from '@anureo/workflow'
import { reviewFailure } from './errors'
import { fixResultSchema } from './schema'
import { buildFixPrompt } from './prompts'
import type { FixReport, ModuleReview } from './results'
import { captureWorkingTreeBaseline, inspectWorkingTreeChanges } from './fix-tree'
import { applyFixPatch, capturePatchBaseline } from './fix-patch'
import { reviewGit, reviewRepositoryRoot } from './git'
import { withAgentWorktree, type AgentWorktree } from './worktree'

export type { FixReport } from './results'

/** Execute a fix for validated module reviews. Incomplete reviews are skipped and an empty
 * findings list needs no fix. Eligible runs await worktree cleanup and report actual edits
 * relative to the review directory. A failed report can include edits if integration finished
 * before cleanup or terminal progress reporting failed.
 *
 * createFixRunner calls this with writer and agent capacity held. It uses failed reports or
 * rejections to stop later writers. The coordinator owns final verification and the client
 * remains caller-owned. Workflow-level fatal agent failures can still reject the enclosing run.
 */
export async function fixFindings(options: FixOptions): Promise<FixReport> {
  const { modules } = options
  if (modules.some(module => module.angles.some(angle => angle.status !== 'completed'))) {
    options.onProgress?.('skipped')
    return { status: 'skipped', summary: 'Fix skipped because the selected review is incomplete.', changedFiles: [], error: null }
  }
  const findings = modules.flatMap(({ module, angles }) => angles.flatMap(angle => {
    if (angle.status !== 'completed') return []
    return angle.findings.map(finding => ({ moduleId: module.id, angleId: angle.angle.id, ...finding }))
  }))
  if (findings.length === 0) {
    options.onProgress?.('skipped')
    return { status: 'not-needed', summary: 'No findings to fix.', changedFiles: [], error: null }
  }
  const files = modules.flatMap(module => module.module.files)
  const prompt = buildFixPrompt({ sourceVersion: options.sourceVersion, findings, files })
  options.onProgress?.('started')
  return applyFix(options, prompt, files)
}

/** Inputs for a single writer run. */
interface FixOptions {
  /** Source fingerprint embedded in the fix prompt. Null omits provenance text. */
  sourceVersion: string | null
  /** Borrowed client, kept usable until the fix settles. */
  client: Client
  /** Canonical absolute review directory. The module files must already be validated relative to it. */
  cwd: string
  /** Canonical Git root. Omission resolves it from cwd when a fix is needed. */
  repositoryRoot?: string
  /** Absolute workflow storage directory, excluded when populating the isolated checkout. */
  directory: string
  modules: readonly ModuleReview[]
  /** Omission leaves model selection to the session/backend. */
  model?: string
  /** Forwarded to session creation when supplied. */
  permissionMode?: string
  /** Synchronous observer forwarded by createFixRunner to reviewCode's protected progress
   * observer. Both early exits emit 'skipped'. For direct callers, exceptions before setup
   * or during 'failed' reject. Exceptions after reconciliation produce a failed report
   * if the subsequent 'failed' notification succeeds.
   */
  onProgress?: (status: 'started' | 'completed' | 'failed' | 'skipped') => void
}

type ReconciledFix = Pick<FixReport, 'summary' | 'changedFiles'>

/** Run the eligible fix inside withAgentWorktree's cleanup boundary. Return failures to
 * fixFindings as reports after publishing failed progress, unless that notification throws.
 */
async function applyFix(options: FixOptions, prompt: string, files: readonly string[]): Promise<FixReport> {
  // Keep integration evidence even if withAgentWorktree rejects during cleanup.
  let outcome: ReconciledFix | undefined
  try {
    const root = options.repositoryRoot ?? await reviewRepositoryRoot(options.cwd)
    await withAgentWorktree({ root, cwd: options.cwd, directory: options.directory }, async (cwd, _directory, checkout) => {
      if (!checkout) throw new Error('Fix worktree was not created')
      const allowed = files.map(file => relativePath(root, resolve(options.cwd, file)))
      const baseline = await captureFixBaseline(checkout, allowed)
      const output = await agent(prompt, {
        client: options.client, cwd, model: options.model, schema: fixResultSchema,
        ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      })
      if (output === null) throw new HarnessSdkError('REVIEW_AGENT_INCOMPLETE', 'Fix agent returned no result')
      const changedFiles = await checkFixChanges(baseline)
      if (changedFiles.length > 0) await applyFixPatch(root, checkout, changedFiles)
      outcome = {
        summary: output.summary,
        changedFiles: changedFiles.map(file => relativePath(options.cwd, resolve(root, file))),
      }
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

/** Save scope fingerprints, patch inputs and Git metadata before applyFix starts the agent.
 * A failed read or copy aborts dispatch. Scratch copies live until the worktree is cleaned up.
 */
async function captureFixBaseline(checkout: AgentWorktree, allowed: readonly string[]) {
  const tree = await captureWorkingTreeBaseline(checkout.root, allowed)
  await capturePatchBaseline(checkout, allowed)
  const head = await reviewGit(checkout.root, 'rev-parse', 'HEAD')
  const index = await reviewGit(checkout.root, 'ls-files', '--stage', '-z')
  return { tree, head, index }
}

/** Reject HEAD, index or detected out-of-scope changes after agent settlement. applyFix uses
 * the returned Git-root-relative paths to integrate only observed, eligible edits.
 */
async function checkFixChanges({ tree, head, index }: Awaited<ReturnType<typeof captureFixBaseline>>): Promise<string[]> {
  if (await reviewGit(tree.root, 'rev-parse', 'HEAD') !== head
      || await reviewGit(tree.root, 'ls-files', '--stage', '-z') !== index) {
    throw new HarnessSdkError('REVIEW_FIX_SCOPE', 'Fix changed Git HEAD or the index in its worktree')
  }
  const { changedFiles, violations } = await inspectWorkingTreeChanges(tree)
  if (violations.length > 0) {
    throw new HarnessSdkError('REVIEW_FIX_SCOPE', `Fix changed paths outside the selected source files: ${violations.join(', ')}`)
  }
  return changedFiles
}

/** Use slash-separated paths for Git scope checks and review-directory-relative reports. */
function relativePath(from: string, path: string): string {
  return relative(from, path).split(sep).join('/')
}
