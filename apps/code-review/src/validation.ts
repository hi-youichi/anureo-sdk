import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { assertReviewablePath, isInsideDirectory } from './paths'
import type { Finding, ModulePlan, ReviewModule } from './schema'

/** Validate a schema-parsed plan against the filesystem and return a copy with canonical,
 * slash-separated paths relative to the canonical absolute cwd. Requires an absolute workflow
 * directory to exclude storage. Rejects duplicate/oversized IDs, duplicate file ownership,
 * invalid source paths and filesystem failures, in plan order. analyzeModules awaits this via
 * validateOutput before dispatch; this checks listed files, not exhaustive source coverage. */
export async function validatePlan(cwd: string, plan: ModulePlan, directory: string): Promise<ModulePlan> {
  const ids = new Set<string>()
  const files = new Set<string>()
  const modules: ReviewModule[] = []
  for (const module of plan.modules) {
    if (ids.has(module.id)) throw new Error(`Duplicate module id: ${module.id}`)
    // Keep analyzed IDs within the same byte limit as caller-selected module and angle IDs.
    if (Buffer.byteLength(module.id) > 256) throw new Error(`Module id is too long (max 256 bytes): ${module.id.slice(0, 64)}`)
    ids.add(module.id)
    const owned: string[] = []
    for (const file of module.files) {
      const local = await resolveReviewableSourcePath(cwd, file, directory)
      if (files.has(local)) throw new Error(`Source file assigned more than once: ${local}`)
      files.add(local)
      owned.push(local)
    }
    modules.push({ ...module, files: owned })
  }
  return { ...plan, modules }
}

/** Return copies of schema-parsed findings with canonical source paths, preserving order.
 * Requires canonical absolute cwd, absolute workflow storage and a module from validatePlan.
 * Reads current source files, rejecting invalid paths, ownership, line ranges or filesystem
 * failures. reviewAngle awaits this via validateOutput; rejection becomes failed angle coverage.
 * Line counts are cached only for this call; validation neither locks nor freezes the sources. */
export async function validateFindings(cwd: string, module: ReviewModule, findings: Finding[], directory: string): Promise<Finding[]> {
  const lineCounts = new Map<string, number>()
  const validated: Finding[] = []
  for (const finding of findings) {
    const file = await resolveReviewableSourcePath(cwd, finding.file, directory)
    if (!module.files.includes(file)) throw new Error(`Finding is outside module ${module.id}: ${file}`)
    let lines = lineCounts.get(file)
    if (lines === undefined) {
      const text = await readFile(resolve(cwd, file), 'utf8')
      lines = countSourceLines(text)
      lineCounts.set(file, lines)
    }
    assertFindingLocation(finding, file, lines)
    validated.push({ ...finding, file })
  }
  return validated
}

/** Invoke and await a local output validator, returning its value or rejecting with
 * REVIEW_VALIDATION_FAILED. Replaces failure metadata with a known-outcome error, retaining
 * Error messages or a generic message for other causes. analyzeModules lets this reject analysis;
 * reviewAngle catches it as failed coverage. Supply local validation, not agent execution. */
export async function validateOutput<T>(validate: () => Promise<T>): Promise<T> {
  try { return await validate() }
  catch (cause) {
    throw new HarnessSdkError('REVIEW_VALIDATION_FAILED', cause instanceof Error ? cause.message : 'Invalid review output')
  }
}

/** Resolve one relative source path for both validators, rejecting storage, metadata, escapes,
 * non-files and filesystem failures. Resolve symlinks before scope checks so aliases cannot
 * disguise excluded targets; return the canonical path relative to cwd with '/' separators. */
async function resolveReviewableSourcePath(cwd: string, file: string, directory: string): Promise<string> {
  if (isAbsolute(file)) throw new Error(`Expected a relative source path: ${file}`)
  const absolute = await realpath(resolve(cwd, file))
  await assertReviewablePath(cwd, absolute, directory)
  const local = relative(cwd, absolute)
  // Check containment after resolving symlinks, then require a regular source file.
  if (!isInsideDirectory(cwd, absolute) || !(await stat(absolute)).isFile()) {
    throw new Error(`Source file is outside the review directory or is not a file: ${file}`)
  }
  return local.split(sep).join('/')
}

/** Count addressable source lines across CRLF and single-character line terminators.
 * A final terminator does not create an extra line; empty files have no valid finding location. */
function countSourceLines(text: string): number {
  const segments = text.split(/\r\n|[\n\r\u2028\u2029]/u)
  return text.length === 0 ? 0 : segments.length - (segments.at(-1) === '' ? 1 : 0)
}

/** Reject a schema-parsed finding unless its inclusive range fits the observed source line count.
 * Keep the normalized path in the diagnostic, matching the finding returned on success. */
function assertFindingLocation(finding: Finding, file: string, lines: number): void {
  if (finding.lineStart < 1 || finding.lineEnd < finding.lineStart || finding.lineEnd > lines) {
    throw new Error(`Invalid finding location: ${file}:${finding.lineStart}-${finding.lineEnd}; expected 1 <= lineStart <= lineEnd <= ${lines}`)
  }
}
