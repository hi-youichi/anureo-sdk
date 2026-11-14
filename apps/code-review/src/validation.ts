import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { isNonblankReviewId, MAX_REVIEW_ID_BYTES } from './options'
import { assertReviewablePath, isInsideDirectory } from './paths'
import type { Finding, ModulePlan, ReviewModule } from './schema'

/** Check the listed assignments in a schema-parsed plan and return a copy with canonical,
 * slash-separated paths relative to cwd. Pass the canonical absolute review directory and
 * absolute workflow storage path for the source view being checked. Invalid or duplicate IDs,
 * duplicate file ownership, invalid paths and filesystem failures reject in traversal order.
 *
 * analyzeModules checks the agent's source view first and, in fix mode, checks the resulting
 * assignments against the original tree before selecting modules. A rejection prevents dispatch. */
export async function validatePlan(cwd: string, plan: ModulePlan, workflowDirectory: string): Promise<ModulePlan> {
  const claimedIds = new Set<string>()
  const claimedFiles = new Set<string>()
  const modules: ReviewModule[] = []
  for (const module of plan.modules) {
    claimModuleId(module.id, claimedIds)
    const files: string[] = []
    for (const file of module.files) {
      const canonicalFile = await resolveReviewableSourcePath(cwd, file, workflowDirectory)
      claimSourceFile(canonicalFile, claimedFiles)
      files.push(canonicalFile)
    }
    modules.push({ ...module, files })
  }
  return { ...plan, modules }
}

/** Return copies of schema-parsed findings with canonical source paths, preserving order.
 * Requires canonical absolute cwd, absolute workflow storage and a module from validatePlan.
 * Checks ownership and inclusive ranges using one UTF-8 read per canonical file in this call,
 * with no source lock.
 * Aggregate ownership and range errors after resolving paths and reading assigned files.
 * Path and filesystem failures reject immediately. */
export async function validateFindings(cwd: string, module: ReviewModule, findings: Finding[], workflowDirectory: string): Promise<Finding[]> {
  const lineCounts = new Map<string, number>()
  const validated: Finding[] = []
  const issues: string[] = []
  for (const [index, finding] of findings.entries()) {
    const file = await resolveReviewableSourcePath(cwd, finding.file, workflowDirectory)
    if (!module.files.includes(file)) {
      issues.push(`findings[${index}].file: Finding is outside module ${module.id}: ${file}`)
      continue
    }
    let lines = lineCounts.get(file)
    if (lines === undefined) {
      const text = await readFile(resolve(cwd, file), 'utf8')
      lines = countSourceLines(text)
      lineCounts.set(file, lines)
    }
    if (finding.lineStart < 1 || finding.lineEnd < finding.lineStart || finding.lineEnd > lines) {
      issues.push(`findings[${index}]: Invalid finding location: ${file}:${finding.lineStart}-${finding.lineEnd}; expected 1 <= lineStart <= lineEnd <= ${lines}`)
      continue
    }
    validated.push({ ...finding, file })
  }
  if (issues.length > 0) throw new Error(issues.join('\n'))
  return validated
}

/** Invoke the supplied local validator once and await its value. A synchronous throw or rejection
 * becomes REVIEW_VALIDATION_FAILED, with the original Error message or a generic message.
 * analyzeModules and reviewAngle supply callbacks after the agent returns. Analysis propagates
 * this failure, while reviewAngle records it as failed coverage. */
export async function validateOutput<T>(validate: () => Promise<T>): Promise<T> {
  try { return await validate() }
  catch (cause) {
    throw new HarnessSdkError('REVIEW_VALIDATION_FAILED', cause instanceof Error ? cause.message : 'Invalid review output')
  }
}

/** Reserve the exact ID after checking uniqueness and the same 256-byte UTF-8 cap
 * applied to caller-selected module IDs. */
function claimModuleId(id: string, claimedIds: Set<string>): void {
  if (!isNonblankReviewId(id)) throw new Error('Module id must not be blank')
  if (claimedIds.has(id)) throw new Error(`Duplicate module id: ${id}`)
  if (Buffer.byteLength(id) > MAX_REVIEW_ID_BYTES) {
    throw new Error(`Module id is too long (max ${MAX_REVIEW_ID_BYTES} bytes): ${id.slice(0, 64)}`)
  }
  claimedIds.add(id)
}

/** Claim a canonical relative path in the plan-wide ownership set. Reject repeated claims
 * within a module or across modules, including paths that resolved from different aliases. */
function claimSourceFile(file: string, claimedFiles: Set<string>): void {
  if (claimedFiles.has(file)) throw new Error(`Source file assigned more than once: ${file}`)
  claimedFiles.add(file)
}

/** Resolve one relative source path for both validators, rejecting storage, metadata, escapes,
 * non-files and filesystem failures. Resolve symlinks before scope checks so aliases cannot
 * disguise excluded targets; return the canonical path relative to cwd with '/' separators. */
async function resolveReviewableSourcePath(cwd: string, file: string, workflowDirectory: string): Promise<string> {
  if (isAbsolute(file)) throw new Error(`Expected a relative source path: ${file}`)
  if (file.split(sep === '\\' ? /[\\/]/ : '/').includes('..')) {
    throw new Error(`Parent path segments are not allowed in source paths: ${file}`)
  }
  const absolute = await realpath(resolve(cwd, file))
  await assertReviewablePath(cwd, absolute, workflowDirectory)
  if (!isInsideDirectory(cwd, absolute) || !(await stat(absolute)).isFile()) {
    throw new Error(`Source file is outside the review directory or is not a file: ${file}`)
  }
  return relative(cwd, absolute).split(sep).join('/')
}

/** Count addressable source lines across CRLF and single-character line terminators.
 * A final terminator does not create an extra line; empty files have no valid finding location. */
function countSourceLines(text: string): number {
  const segments = text.split(/\r\n|[\n\r\u2028\u2029]/u)
  return text.length === 0 ? 0 : segments.length - (segments.at(-1) === '' ? 1 : 0)
}
