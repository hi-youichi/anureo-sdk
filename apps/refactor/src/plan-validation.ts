import type { ModulePlan } from './schema'

/**
 * Require case-insensitively unique, filename-safe module IDs and one assignment per inventory path.
 * After the planning worktree is released, plan in refactor.ts supplies the schema-validated
 * response and the inventory it sent to the agent. A thrown Error leaves the plan unpublished
 * and stops module dispatch. The run lifecycle records that error in the incomplete report.
 * Compare paths literally. Check each module's ID before its files, and throw on the first invalid
 * ID or assignment. Report omissions in inventory order after checking all assignments.
 */
export function validatePlan(plan: ModulePlan, files: readonly string[]): void {
  const expectedFiles = new Set(files)
  const assignedFiles = new Set<string>()
  const claimedIds = new Set<string>()
  for (const module of plan.modules) {
    claimModuleId(module.id, claimedIds)
    for (const file of module.files) {
      if (!expectedFiles.has(file) || assignedFiles.has(file)) {
        throw new Error(`Unlisted or duplicate module file: ${file}`)
      }
      assignedFiles.add(file)
    }
  }
  const missing = files.filter(file => !assignedFiles.has(file))
  if (missing.length) throw new Error(`Module plan omitted source files: ${missing.join(', ')}`)
}

/**
 * Reserve an ID in validatePlan's set of lowercase keys. IDs are 1–80 ASCII characters
 * and start with a letter or digit. Later characters can also be underscores or hyphens.
 * Throw on an unsafe or repeated ID so runModules can report each assignment using a unique ID.
 */
function claimModuleId(id: string, claimedIds: Set<string>): void {
  const key = id.toLowerCase()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) || claimedIds.has(key)) {
    throw new Error(`Invalid or duplicate module id: ${id}`)
  }
  claimedIds.add(key)
}
