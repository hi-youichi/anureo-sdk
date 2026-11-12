import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { HarnessSdkError, type Client } from '@anureo/sdk'
import { agent } from '@anureo/workflow'
import { reviewFailure, type ReviewFailure } from './errors'
import { isInsideDirectory } from './paths'
import { fixResultSchema } from './schema'
import { buildFixPrompt } from './prompts'
import type { ModuleReview } from './review'

const exec = promisify(execFile)

export interface FixReport {
  status: 'not-needed' | 'skipped' | 'applied' | 'failed'
  summary: string
  changedFiles: string[]
  error: ReviewFailure | null
}
// Post-fix verification reviews are owned by ReviewReport (src/review.ts),
// not by this fix-specific record.

/** One `git status --porcelain=v1 -z` entry with its path normalized relative to cwd. */
interface TreeEntry {
  status: string
  file: string
}

interface TreeState {
  fingerprint: string | null
  regular: boolean
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 1 << 24 })
    return stdout
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new HarnessSdkError('REVIEW_FIX_INVALID', `Fix requires a usable git repository in the review directory: ${detail}`)
  }
}

/** Parse `git status --porcelain=v1 -z --untracked-files=all`; rename entries carry a
 * second NUL-separated field for the original path. */
function parseStatus(output: string): Array<{ status: string; path: string }> {
  const tokens = output.split('\0')
  const entries: Array<{ status: string; path: string }> = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.length === 0) continue
    const status = token.slice(0, 2)
    const path = token.slice(3)
    if (status.includes('R') || status.includes('C')) index++ // Skip the original-path field.
    entries.push({ status, path })
  }
  return entries
}

/** Workflow-storage prefixes relative to the review directory. Both the configured and
 * the real path are included: the review directory is realpath-resolved, while a custom
 * workflow directory may still carry symlinked prefixes such as /tmp vs /private/tmp. */
async function storagePrefixes(cwd: string, directory: string): Promise<string[]> {
  const candidates = [directory]
  try { candidates.push(await realpath(directory)) } catch { /* Storage may not exist yet. */ }
  const prefixes = new Set<string>()
  for (const candidate of candidates) {
    const local = relative(cwd, candidate)
    if (isInsideDirectory(cwd, candidate, false)) prefixes.add(local.split(sep).join('/'))
  }
  return [...prefixes]
}

/** Normalize repo-root-relative porcelain paths to paths relative to the review directory,
 * dropping entries outside it and entries inside the workflow storage directory. */
async function treeEntries(cwd: string, root: string, directory: string): Promise<TreeEntry[]> {
  const prefixes = await storagePrefixes(cwd, directory)
  return parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    .map(({ status, path }) => ({ status, file: relative(cwd, resolve(root, path)).split(sep).join('/') }))
    .filter(({ file }) => file !== '' && !file.startsWith('../')
      && !prefixes.some(prefix => file === prefix || file.startsWith(`${prefix}/`)))
}

async function repositoryRoot(cwd: string): Promise<string> {
  const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
  if (inside !== 'true') throw new HarnessSdkError('REVIEW_FIX_INVALID', 'Fix requires a git repository; rollback relies on git')
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
}

async function fileState(cwd: string, file: string): Promise<TreeState> {
  const path = resolve(cwd, file)
  try {
    const info = await lstat(path)
    const content = info.isFile() ? await readFile(path) : info.isSymbolicLink() ? await readlink(path) : ''
    const fingerprint = createHash('sha256').update(String(info.mode)).update('\0').update(content).digest('hex')
    return { fingerprint, regular: info.isFile() }
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return { fingerprint: null, regular: false }
    }
    throw cause
  }
}

interface WorkingTreeBaseline {
  cwd: string
  root: string
  allowed: readonly string[]
  directory: string
  states: ReadonlyMap<string, TreeState>
}

/** Record existing changes and selected sources without requiring a clean working tree. */
async function captureWorkingTreeBaseline(cwd: string, allowed: readonly string[], directory: string): Promise<WorkingTreeBaseline> {
  const root = await repositoryRoot(cwd)
  const files = new Set([...allowed, ...(await treeEntries(cwd, root, directory)).map(entry => entry.file)])
  const states = new Map(await Promise.all([...files].map(async file => [file, await fileState(cwd, file)] as const)))
  return { cwd, root, allowed, directory, states }
}

/** Afterwards accept only modifications of the selected module files; anything else —
 * new, deleted, renamed, or out-of-scope paths — is a violation. */
async function inspectWorkingTreeChanges(baseline: WorkingTreeBaseline): Promise<{ changedFiles: string[]; violations: string[] }> {
  const { cwd, root, allowed, directory, states: before } = baseline
  const scope = new Set(allowed)
  const changedFiles: string[] = []
  const violations: string[] = []
  const entries = new Map((await treeEntries(cwd, root, directory)).map(entry => [entry.file, entry.status]))
  for (const file of new Set([...before.keys(), ...entries.keys()])) {
    const previous = before.get(file)
    const current = await fileState(cwd, file)
    if (current.fingerprint === (previous?.fingerprint ?? null)) continue
    if (scope.has(file) && previous?.regular && current.regular) changedFiles.push(file)
    else {
      // '  ' marks a fingerprint-only change (mode/symlink retarget) with no git status code.
      const status = (entries.get(file) ?? '  ').trimEnd() || 'modified'
      violations.push(`${status} ${file}`)
    }
  }
  return { changedFiles: changedFiles.sort(), violations }
}

interface FixOptions {
  /** Source fingerprint embedded in the fix prompt; null outside git. */
  sourceVersion: string | null
  client: Client
  cwd: string
  directory: string
  modules: readonly ModuleReview[]
  model?: string
  /** Session permission mode enabling the fix agent to edit files and run checks. */
  permissionMode?: string
  /** 'not-needed' and 'skipped' FixReport statuses are both reported as 'skipped';
   * consult the returned report for the distinction. */
  onProgress?: (status: 'started' | 'completed' | 'failed' | 'skipped') => void
}

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

/** Capture the baseline before agent dispatch, then reconcile even if execution fails. */
async function applyFix(options: FixOptions, prompt: string, files: readonly string[]): Promise<FixReport> {
  let baseline: WorkingTreeBaseline | undefined
  let outcome: Pick<FixReport, 'summary' | 'changedFiles'> | undefined
  try {
    baseline = await captureWorkingTreeBaseline(options.cwd, files, options.directory)
    const output = await agent(prompt, {
      client: options.client, cwd: options.cwd, model: options.model,
      // An absent permissionMode selects the session default.
      ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      schema: fixResultSchema,
    })
    if (output === null) throw new HarnessSdkError('REVIEW_AGENT_INCOMPLETE', 'Fix agent returned no result')
    const { changedFiles, violations } = await inspectWorkingTreeChanges(baseline)
    if (violations.length > 0) {
      // The agent may already have written files; scope failure does not undo those edits.
      throw new HarnessSdkError('REVIEW_FIX_SCOPE',
        `Fix changed paths outside the selected source files; inspect the working tree and revert with git: ${violations.join(', ')}`)
    }
    outcome = { summary: output.summary, changedFiles }
    // Git reconciliation owns changedFiles; the agent's reported list is advisory.
    if (changedFiles.length === 0) {
      options.onProgress?.('skipped')
      return { status: 'skipped', ...outcome, error: null }
    }
    options.onProgress?.('completed')
    return { status: 'applied', ...outcome, error: null }
  } catch (cause) {
    const result = await recoverFixFailure(cause, baseline, outcome)
    options.onProgress?.('failed')
    return result
  }
}

async function recoverFixFailure(
  cause: unknown, baseline: WorkingTreeBaseline | undefined,
  outcome: Pick<FixReport, 'summary' | 'changedFiles'> | undefined,
): Promise<FixReport> {
  let error = reviewFailure(cause)
  // Report partial edits after failure, but never replace the original execution error.
  const changes = baseline ? await inspectWorkingTreeChanges(baseline).catch(() => null) : null
  if (changes && changes.violations.length > 0 && cause instanceof HarnessSdkError && cause.code !== 'REVIEW_FIX_SCOPE') {
    error = { ...error, message: `${error.message}; out-of-scope changes: ${changes.violations.join(', ')}` }
  }
  return { status: 'failed', summary: outcome?.summary || 'Fix failed.',
    changedFiles: changes?.changedFiles ?? outcome?.changedFiles ?? [], error }
}
