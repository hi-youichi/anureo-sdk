// Captures fix baselines and reconciles allowed edits, including pre-existing changes and storage exclusions.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { isInsideDirectory } from './paths'

/** Internal baseline captured by applyFix and retained through executeFix and failure recovery.
 * The caller serializes writers and keeps allowed paths stable until reconciliation finishes;
 * mode/content reads and Git status are not an atomic snapshot. */
export interface WorkingTreeBaseline {
  /** Canonical absolute review directory; state keys and allowed paths are relative to it. */
  cwd: string
  /** Git work-tree root used to interpret porcelain paths, which may be above cwd. */
  root: string
  /** Validated source paths eligible for modification; creating/deleting them is not allowed. */
  allowed: readonly string[]
  /** Absolute workflow storage path to exclude from Git change discovery. */
  directory: string
  /** Selected files plus existing Git-visible changes, excluding workflow storage entries. */
  states: ReadonlyMap<string, TreeState>
}

/** Record existing changes and selected sources without requiring a clean working tree. applyFix
 * awaits this before dispatch; Git/filesystem failures reject. cwd/directory must be absolute and
 * allowed must contain validated cwd-relative source paths. The caller must serialize writers. */
export async function captureWorkingTreeBaseline(cwd: string, allowed: readonly string[], directory: string): Promise<WorkingTreeBaseline> {
  const root = await repositoryRoot(cwd)
  const files = new Set([...allowed, ...(await treeEntries(cwd, root, directory)).map(entry => entry.file)])
  const states = new Map(await Promise.all([...files].map(async file => [file, await fileState(cwd, file)] as const)))
  return { cwd, root, allowed, directory, states }
}

/** Compare selected files and Git-visible changes against the baseline for reconcileFix and
 * recoverFixFailure. Return sorted changedFiles only for allowed paths that remain regular files;
 * other fingerprint changes become diagnostic violations. Unchanged pre-existing edits do not count.
 * Discovery excludes workflow storage and unselected Git-ignored files; index-only changes do not
 * affect fingerprints. Read failures reject; no edits are reverted or otherwise written. */
export async function inspectWorkingTreeChanges(baseline: WorkingTreeBaseline): Promise<{ changedFiles: string[]; violations: string[] }> {
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

/** One `git status --porcelain=v1 -z` entry with its path normalized relative to cwd. */
interface TreeEntry {
  status: string
  file: string
}

interface TreeState {
  /** Mode and regular-file bytes or symlink target; null when the path is missing. */
  fingerprint: string | null
  /** Both snapshots must be regular files for a change to qualify as an allowed modification. */
  regular: boolean
}

/** Run a read-only Git probe for baseline/reconciliation; reject with REVIEW_FIX_INVALID on
 * process failure so fix execution can retain a normalized failure without dispatching further work. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 1 << 24 })
    return stdout
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new HarnessSdkError('REVIEW_FIX_INVALID', `Fix requires a usable git repository in the review directory: ${detail}`)
  }
}

/** Parse `git status --porcelain=v1 -z --untracked-files=all`, retaining destination paths.
 * Rename/copy entries include a second original-path field, not another status entry. */
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

/** Require a work tree and resolve its root for porcelain path normalization; reject invalid
 * repositories before captureWorkingTreeBaseline records files or applyFix starts its agent. */
async function repositoryRoot(cwd: string): Promise<string> {
  const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
  if (inside !== 'true') throw new HarnessSdkError('REVIEW_FIX_INVALID', 'Fix requires a git repository; rollback relies on git')
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
}

/** Fingerprint mode plus regular-file bytes or symlink text for scope comparison. Missing paths
 * return a null fingerprint; other filesystem failures reject rather than silently omit an edit.
 * Directory entries carry mode only; Git change discovery supplies their individual file paths. */
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

const exec = promisify(execFile)
