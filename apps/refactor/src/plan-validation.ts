import type { ModulePlan } from './schema'

/**
 * Require case-insensitively unique, filename-safe module IDs and one assignment per inventory path.
 * After the planning worktree is released, plan in refactor.ts supplies the schema-validated
 * response and the inventory it sent to the agent. A thrown Error leaves the plan unpublished
 * and stops module dispatch. The run lifecycle records that error in the incomplete report.
 * Compare paths literally. Report ID and assignment errors in traversal order, then omissions
 * in inventory order.
 */
export function validatePlan(plan: ModulePlan, files: readonly string[]): void {
  const expectedFiles = new Set(files)
  const assignments = new Map<string, string>()
  const claimedIds = new Map<string, string>()
  const issues: string[] = []
  for (const [index, module] of plan.modules.entries()) {
    const location = `modules[${index}]`
    const key = module.id.toLowerCase()
    const firstId = claimedIds.get(key)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(module.id)) {
      issues.push(`${location}.id: ${JSON.stringify(module.id)} must start with an ASCII letter or digit and contain at most 80 letters, digits, underscores or hyphens`)
    }
    if (firstId) issues.push(`${location}.id: ${JSON.stringify(module.id)} duplicates ${firstId} ignoring case`)
    else claimedIds.set(key, `${location}.id`)
    for (const [fileIndex, file] of module.files.entries()) {
      const assignment = `${location}.files[${fileIndex}]`
      const firstAssignment = assignments.get(file)
      if (!expectedFiles.has(file)) {
        issues.push(`${assignment}: ${JSON.stringify(file)} is absent from the inventory`)
      }
      if (firstAssignment) issues.push(`${assignment}: ${JSON.stringify(file)} was already assigned at ${firstAssignment}`)
      else assignments.set(file, assignment)
    }
  }
  const missing = files.filter(file => !assignments.has(file))
  if (missing.length) issues.push(`Module plan omitted source files: ${missing.map(file => JSON.stringify(file)).join(', ')}`)
  if (issues.length) throw new Error(issues.join('\n'))
}
