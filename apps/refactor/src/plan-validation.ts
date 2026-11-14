// Validates planned IDs and exact inventory coverage; it must not discover files, parse schemas or run agents.
import type { ModulePlan } from './schema'

/** Require filesystem-safe unique module IDs and exactly one assignment of each supplied path.
 * plan in refactor.ts calls this after schema parsing; a thrown Error stops module preparation.
 * Paths are compared literally, without normalization. Throws at the first invalid/duplicate ID or
 * extra/duplicate file in plan order, then reports omissions in inventory order; no mutation or I/O. */
export function validatePlan(plan: ModulePlan, files: readonly string[]): void {
  const expected = new Set(files)
  const assigned = new Set<string>()
  const ids = new Set<string>()
  for (const module of plan.modules) {
    const artifactId = module.id.toLowerCase()
    if (!isSafeModuleId(module.id) || ids.has(artifactId)) {
      throw new Error(`Invalid or duplicate module id: ${module.id}`)
    }
    ids.add(artifactId)
    for (const file of module.files) {
      if (!expected.has(file) || assigned.has(file)) {
        throw new Error(`Unlisted or duplicate module file: ${file}`)
      }
      assigned.add(file)
    }
  }
  const missing = files.filter(file => !assigned.has(file))
  if (missing.length) throw new Error(`Module plan omitted source files: ${missing.join(', ')}`)
}

/** Keep graph artifact IDs to 1–80 ASCII characters: an alphanumeric start, then alphanumerics, _ or -.
 * validatePlan checks this lexical rule before runModules can interpolate an ID into a filename. */
function isSafeModuleId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)
}
