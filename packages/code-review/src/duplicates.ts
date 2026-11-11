/** Resolve aliases once per node. Missing targets, cycles and their dependants have no valid root. */
export function resolveDuplicateRoots(findings: readonly { id: string; duplicateOf: string | null }[]): Map<string, string | null> {
  const aliases = new Map(findings.map(finding => [finding.id, finding.duplicateOf]))
  if (aliases.size !== findings.length) throw new Error('Duplicate finding IDs')
  const roots = new Map<string, string | null>()
  for (const finding of findings) {
    const path: string[] = []
    const visited = new Set<string>()
    let id = finding.id, root: string | null
    while (true) {
      if (roots.has(id)) { root = roots.get(id)!; break }
      if (!aliases.has(id) || visited.has(id)) { root = null; break }
      visited.add(id)
      path.push(id)
      const next = aliases.get(id)!
      if (next === null) { root = id; break }
      id = next
    }
    for (const member of path) roots.set(member, root)
  }
  return roots
}
