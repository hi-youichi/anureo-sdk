import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { assertReviewablePath, isInsideDirectory } from './paths'
import type { Finding, ModulePlan, ReviewModule } from './schema'

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

export async function validatePlan(cwd: string, plan: ModulePlan, directory: string): Promise<ModulePlan> {
  const ids = new Set<string>()
  const files = new Set<string>()
  const modules: ReviewModule[] = []
  for (const module of plan.modules) {
    if (ids.has(module.id)) throw new Error(`Duplicate module id: ${module.id}`)
    // Workflow step keys (`${phase}:${JSON.stringify([module.id, angle.id])}`) are
    // capped at 1024 bytes by the workflow engine; reject oversized ids before dispatch.
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

export async function validateFindings(cwd: string, module: ReviewModule, findings: Finding[], directory: string): Promise<Finding[]> {
  const lineCounts = new Map<string, number>()
  const validated: Finding[] = []
  for (const finding of findings) {
    const file = await resolveReviewableSourcePath(cwd, finding.file, directory)
    if (!module.files.includes(file)) throw new Error(`Finding is outside module ${module.id}: ${file}`)
    let lines = lineCounts.get(file)
    if (lines === undefined) {
      const text = await readFile(resolve(cwd, file), 'utf8')
      const segments = text.split(/\r\n|[\n\r\u2028\u2029]/u)
      lines = text.length === 0 ? 0 : segments.length - (segments.at(-1) === '' ? 1 : 0)
      lineCounts.set(file, lines)
    }
    if (finding.lineStart < 1 || finding.lineEnd < finding.lineStart || finding.lineEnd > lines) throw new Error(`Invalid finding location: ${file}:${finding.lineStart}-${finding.lineEnd}; expected 1 <= lineStart <= lineEnd <= ${lines}`)
    validated.push({ ...finding, file })
  }
  return validated
}

/** Local validation failures have a known outcome, unlike a lost agent execution. */
export async function validateOutput<T>(validate: () => Promise<T>): Promise<T> {
  try { return await validate() }
  catch (cause) {
    throw new HarnessSdkError('REVIEW_VALIDATION_FAILED', cause instanceof Error ? cause.message : 'Invalid review output')
  }
}
