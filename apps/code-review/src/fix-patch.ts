// Transfers validated edits from the isolated checkout to the original work tree.
import { chmod, copyFile, link, lstat, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { fileState, type TreeState } from './file-state'

/** Paths that still need verification after integration or cleanup failed. */
export class FixIntegrationError extends HarnessSdkError {
  constructor(code: string, message: string, readonly changedFiles: string[], outcomeUnknown: boolean, cause: unknown) {
    super(code, message, false, outcomeUnknown, { cause })
  }
}

/** Stage all replacements beside their targets before moving any original. Keep backups
 * until the installed bytes and modes are verified, and restore originals in reverse order
 * on failure. A failed restoration leaves its backup available for recovery. */
export async function applyFixPatch(root: string, checkout: string, before: ReadonlyMap<string, TreeState>,
  after: ReadonlyMap<string, TreeState>): Promise<string[]> {
  const entries: Replacement[] = []
  const changedFiles: string[] = []
  let failed = false
  try {
    for (const [file, state] of after) {
      const path = resolve(root, file)
      const expected = before.get(file)?.fingerprint
      await checkOriginal(root, file, expected)
      const source = resolve(checkout, file)
      if (await realpath(source) !== source) {
        throw new HarnessSdkError('REVIEW_FIX_SCOPE', `Fix source traverses a symlink: ${file}`)
      }
      const info = await lstat(source)
      if (!info.isFile()) throw new HarnessSdkError('REVIEW_FIX_SCOPE', `Fix source is no longer a regular file: ${file}`)
      const directory = await mkdtemp(resolve(dirname(path), '.anureo-review-fix-'))
      entries.push({ file, path, directory, replacement: state.fingerprint,
        backedUp: false, installed: false, keepBackup: false })
      const staged = resolve(directory, 'staged')
      await copyFile(source, staged)
      await chmod(staged, info.mode & 0o7777)
      if ((await fileState(directory, 'staged')).fingerprint !== state.fingerprint) {
        throw new HarnessSdkError('REVIEW_FIX_APPLY', `Staged replacement differs from the validated edit: ${file}`)
      }
    }
    for (const { file } of entries) await checkOriginal(root, file, before.get(file)?.fingerprint)
    for (const entry of entries) {
      const { file, path, directory } = entry
      const expected = before.get(file)?.fingerprint
      await checkOriginal(root, file, expected)
      await rename(path, resolve(directory, 'backup'))
      entry.backedUp = true
      if ((await fileState(directory, 'backup')).fingerprint !== expected) throw sourceConflict(file)
      // Install without overwriting a file created concurrently after taking the backup.
      await link(resolve(directory, 'staged'), path)
      entry.installed = true
    }
    for (const { file, replacement } of entries) {
      const { fingerprint } = await fileState(root, file)
      if (fingerprint !== replacement) {
        throw new HarnessSdkError('REVIEW_FIX_APPLY', `Installed file differs from the validated edit: ${file}`)
      }
      if (fingerprint !== before.get(file)?.fingerprint) changedFiles.push(file)
    }
  } catch (cause) {
    failed = true
    const recovery = await restoreOriginals(root, entries)
    if (recovery.length > 0) {
      const paths = recovery.map(({ file, directory }) => `${file} (${resolve(directory, 'backup')})`)
      throw new FixIntegrationError('REVIEW_FIX_ROLLBACK',
        `Could not restore original sources. Retained backups for ${paths.join(', ')}`,
        recovery.map(({ file }) => file).sort(), true, cause)
    }
    throw cause
  } finally {
    const cleanupErrors: unknown[] = []
    for (const { directory, keepBackup } of entries) {
      if (keepBackup) continue
      try {
        await rm(directory, { recursive: true, force: true })
      } catch (cause) {
        cleanupErrors.push(cause)
      }
    }
    if (!failed && cleanupErrors.length > 0) {
      throw new FixIntegrationError('REVIEW_FIX_CLEANUP', 'Could not remove fix staging directories',
        changedFiles, false, new AggregateError(cleanupErrors))
    }
  }
  return changedFiles
}

interface Replacement {
  file: string
  path: string
  directory: string
  replacement: TreeState['fingerprint']
  backedUp: boolean
  installed: boolean
  keepBackup: boolean
}

async function restoreOriginals(root: string, entries: Replacement[]): Promise<Replacement[]> {
  const recovery: Replacement[] = []
  for (const entry of [...entries].reverse()) {
    if (!entry.backedUp) continue
    const backup = resolve(entry.directory, 'backup')
    try {
      if (entry.installed) {
        // Preserve concurrent edits and retain the backup for recovery.
        await checkOriginal(root, entry.file, entry.replacement)
        await rename(backup, entry.path)
      } else {
        await link(backup, entry.path)
      }
    } catch {
      entry.keepBackup = true
      recovery.push(entry)
    }
  }
  return recovery
}

async function checkOriginal(root: string, file: string, expected: TreeState['fingerprint'] | undefined): Promise<void> {
  const path = resolve(root, file)
  const canonical = await realpath(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR' || cause.code === 'ELOOP') return null
    throw cause
  })
  const current = canonical === path ? await fileState(root, file) : null
  if (!current?.regular || current.fingerprint !== expected) throw sourceConflict(file)
}

function sourceConflict(file: string): HarnessSdkError {
  return new HarnessSdkError('REVIEW_FIX_CONFLICT', `Source changed during the fix: ${file}`)
}
