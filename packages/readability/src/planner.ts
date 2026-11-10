import path from 'node:path'
import { positiveInteger } from './scheduler'
import type { AnalysisTask, Inventory, PackageSelection } from './types'

/** Explicit responsibility groups take precedence; the fallback estimates file workloads. */
export function planAnalysis(inventory: Inventory, selections?: PackageSelection[]): AnalysisTask[] {
  const tasks: AnalysisTask[] = []
  for (const pkg of inventory.packages) {
    const selection = selections?.find(value => path.resolve(inventory.root, value.path) === path.resolve(inventory.root, pkg.path))
    if (selection?.agents !== undefined) positiveInteger(selection.agents, 'agents')
    if (selection?.groups && selection.agents !== undefined) throw new Error('Specify groups or agents, not both')
    const files = inventory.files.filter(file => file.packagePath === pkg.path)
    if (selection?.groups) {
      if (!selection.groups.length) throw new Error(`Empty groups: ${pkg.path}`)
      for (const group of selection.groups) {
        if (!group.focus.trim() || !group.files.length) throw new Error(`Empty responsibility group: ${pkg.path}`)
        const ownedFiles = group.files.map(filename => {
          const file = files.find(value => value.path === filename)
          if (!file) throw new Error(`Unknown group file: ${filename}`)
          return file
        })
        tasks.push({ id: `task-${tasks.length + 1}`, packagePath: pkg.path, focus: group.focus, ownedFiles })
      }
      continue
    }
    const count = Math.min(selection?.agents ?? 1, files.length)
    const buckets = Array.from({ length: count }, () => ({ files: [] as typeof files, weight: 0 }))
    // Directory order makes assignment deterministic. Counts estimate workload, not quality.
    const ordered = [...files].sort((a, b) => path.posix.dirname(a.path).localeCompare(path.posix.dirname(b.path)) || b.lines - a.lines || a.path.localeCompare(b.path))
    for (const file of ordered) {
      const bucket = buckets.reduce((lightest, current) => current.weight < lightest.weight ? current : lightest)
      bucket.files.push(file)
      bucket.weight += file.lines
    }
    for (const bucket of buckets) tasks.push({ id: `task-${tasks.length + 1}`, packagePath: pkg.path,
      focus: `Trace responsibilities and caller flows for the assigned files in ${pkg.path}`, ownedFiles: bucket.files })
  }
  const assigned = tasks.flatMap(task => task.ownedFiles.map(file => file.path))
  if (assigned.length !== inventory.files.length || new Set(assigned).size !== assigned.length) {
    throw new Error('Every inventoried file must have exactly one primary analysis task')
  }
  return tasks
}
