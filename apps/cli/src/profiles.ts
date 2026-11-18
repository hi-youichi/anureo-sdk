import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseBeeProfile, type BeeProfileRegistration, type BeeProfileSource } from '@anureo/adapter-swarm'

const missing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === 'ENOENT'

export async function findProjectRoot(cwd: string): Promise<string> {
  const start = resolve(cwd)
  for (let directory = start; ; directory = dirname(directory)) {
    const marker = await stat(join(directory, '.git')).catch(cause => {
      if (!missing(cause)) throw cause
    })
    if (marker && (marker.isDirectory() || marker.isFile())) return directory
    if (dirname(directory) === directory) return start
  }
}

/** Host-owned paths and persistence rules, including when neither directory exists yet. */
export function profileStorageInstructions(project: string, homeDirectory = homedir()): string {
  return [
    'CLI profile storage directories (absolute paths, keyed by profile scope): ' + JSON.stringify({
      user: resolve(homeDirectory, '.anureo', 'bees'),
      project: resolve(project, '.anureo', 'bees'),
    }),
    'For an authorized request to save a profile, choose user for cross-project reusable instructions and project for repository-specific instructions, then write <id>.json in that scope\'s directory. The project directory above is rooted at the nearest Git ancestor, or the CLI working directory when there is none; do not substitute a nested working directory.',
    'Use a UTF-8 JSON object with nonempty name, description and instructions, and optional model and effort. Effort must be an exact supported ID on the selected backend and requires its effortConfigKey mapping; omitted effort retains that backend\'s configured default. The filename supplies id: a lowercase slug starting with a letter, at most 40 letters, digits or hyphens. Create missing directories as needed. Inspect an existing target before updating it and preserve unrelated profiles.',
    'Profiles are loaded once at CLI startup. Newly created or changed files become available in the next CLI invocation; do not claim bee_create has already loaded them in this session. Provide the saved path and the next invocation\'s @user/<id> or @project/<id> selector.',
  ].join('\n\n')
}

async function profileFiles(root: string): Promise<Array<[string, string]>> {
  const directory = join(root, '.anureo', 'bees')
  const entries = await readdir(directory, { withFileTypes: true }).catch(cause => {
    if (!missing(cause)) throw cause
    return []
  })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => [entry.name.slice(0, -5), join(directory, entry.name)])
}

/** Discover both origins without discarding same-ID user profiles. */
export async function loadBeeProfiles(cwd: string, homeDirectory = homedir()): Promise<Array<BeeProfileRegistration & { source: BeeProfileSource; sourceFile: string }>> {
  const [userFiles, projectFiles] = await Promise.all([
    profileFiles(homeDirectory),
    findProjectRoot(cwd).then(profileFiles),
  ])
  const files = [
    ...userFiles.map(([id, file]) => ({ id, file, scope: 'user' as const })),
    ...projectFiles.map(([id, file]) => ({ id, file, scope: 'project' as const })),
  ].sort((left, right) => left.id.localeCompare(right.id) || left.scope.localeCompare(right.scope))
  return Promise.all(files.map(async ({ id, file, scope }) => {
    try {
      const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
      let value: unknown
      try { value = JSON.parse(text) } catch { throw new Error('Expected valid JSON') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
      if ('id' in value && value.id !== id) throw new Error(`Profile id must match the filename "${id}"`)
      return { profile: parseBeeProfile({ ...value, id }), source: { scope, namespace: resolve(dirname(file)) }, sourceFile: file }
    } catch (cause) {
      throw new Error(`Cannot load bee profile ${file}: ${(cause as Error).message}`, { cause })
    }
  }))
}

/** Cross-module collaboration policy for this repository's fixed module bees. */
export function moduleRoutingInstructions(): string {
  return [
    'Module bees are fixed project profiles, one per module: protocol-bee (packages/protocol), core-bee (packages/core), workflow-bee (packages/workflow), conformance-bee (packages/conformance), adapter-codex-bee (packages/adapter/codex), adapter-acp-bee (packages/adapter/acp), adapter-family-bee (packages/adapter/claude, packages/adapter/ahp, packages/adapter/hermes, packages/adapter/pi), swarm-bee (packages/adapter/swarm).',
    'Prefer the owning module bee for investigation, diagnosis, and patch proposals inside its territory; work directly only for trivial lookups or pure coordination. Delegate first, then apply the returned patch proposals yourself.',
    'Change propagation is layered: schema changes go protocol-bee first for an impact list, then core-bee for semantics, then the affected adapter bees for mapping, with conformance-bee owning the acceptance suite. Port changes from core-bee require conformance fake updates and per-adapter status in its report.',
    'Members are read-only: bees analyze, run their own verify commands, and return exact patch proposals with evidence. You apply the edits and re-run the root checks (bun run typecheck, bun test) as acceptance; bee reports are evidence, never acceptance.',
  ].join('\n\n')
}
