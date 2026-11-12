// Validates planned IDs and exact inventory coverage; it must not discover files, parse schemas or run agents.
import type { ModulePlan } from './schema'

/** Restrict IDs used in graph artifact filenames to short, single path components.
 * Plan validation uses this lexical rule without reading paths or changing filesystem state. */
function isSafeModuleId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)
}

/** Require safe unique module IDs and exactly one assignment of every supplied inventory path.
 * Planning calls this after schema parsing and before dispatch. Throws at the first invalid ID or
 * extra/duplicate file in plan order, then reports omissions in inventory order; no input or I/O effects. */
export function validatePlan(plan: ModulePlan, files: readonly string[]): void {
  const expected = new Set(files)
  const assigned = new Set<string>()
  const ids = new Set<string>()
  for (const module of plan.modules) {
    if (!isSafeModuleId(module.id) || ids.has(module.id)) {
      throw new Error(`Invalid or duplicate module id: ${module.id}`)
    }
    ids.add(module.id)
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
