/** Resolve workspace versions and reject dependencies outside the SDK boundary. */
export function distributableDependencies(
  field: Record<string, string> | undefined,
  internalVersions: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  if (!field) return undefined
  return Object.fromEntries(Object.entries(field).map(([name, version]) => {
    if (name.startsWith('@cowork/') || (name.startsWith('@anureo/') && !internalVersions.has(name))) {
      throw new Error(`Forbidden external workspace dependency in distributable: ${name}`)
    }
    if (/^(?:file:|link:|portal:)/.test(version)) throw new Error(`Local dependency cannot be distributed: ${name}`)
    if (version.startsWith('workspace:')) {
      const resolved = internalVersions.get(name)
      if (!resolved) throw new Error(`Unknown workspace dependency ${name}`)
      return [name, resolved]
    }
    return [name, version]
  }))
}
