// Discovers swarm workflow registrations from a session workspace, mirroring the
// upstream CLI's project-scope `.anureo/workflows/` convention.
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSwarmWorkflowRegistration, type SwarmWorkflowOptions, type SwarmWorkflowRegistration } from '@anureo/adapter-swarm'

const EXTENSIONS = ['.ts', '.js', '.mjs'] as const
const require = createRequire(import.meta.url)

/** Load workflow files from `<cwd>/.anureo/workflows/`; missing directory yields an empty list. */
export async function discoverSwarmWorkflows(cwd: string): Promise<SwarmWorkflowRegistration[]> {
  const directory = join(cwd, '.anureo', 'workflows')
  let files: string[]
  try {
    files = (await readdir(directory)).filter(name => EXTENSIONS.some(extension => name.endsWith(extension))).sort()
  } catch { return [] }
  const found = new Map<string, SwarmWorkflowRegistration>()
  for (const name of files) {
    const sourceFile = join(directory, name)
    let module: Record<string, unknown>
    try {
      // The Host runs on Bun, whose require.cache also owns imported ES modules.
      // Query-string versions alone do not invalidate Bun's file module cache.
      delete require.cache[sourceFile]
      module = await import(pathToFileURL(sourceFile).href) as Record<string, unknown>
    } catch (cause) {
      throw new Error(`cannot load swarm workflow ${sourceFile}: ${(cause as Error).message}`)
    }
    const candidate = module.workflow ?? module.default
    if (candidate === undefined) continue
    // The adapter rejects unknown registration fields, so the parsed registration is passed through as-is.
    const registration = parseSwarmWorkflowRegistration(candidate)
    found.set(registration.id, registration)
  }
  return [...found.values()]
}

/** Journal directory for run manifests and step journals; kept under the workspace .anureo tree. */
export function swarmWorkflowJournalDirectory(cwd: string): string {
  return join(cwd, '.anureo', 'workflow-runs')
}

/** Workflow adapter options for a workspace, or undefined when the workspace registers none. */
export async function swarmWorkflowOptions(cwd: string): Promise<SwarmWorkflowOptions | undefined> {
  const registrations = await discoverSwarmWorkflows(cwd)
  if (registrations.length === 0) return undefined
  return { registrations, journalDirectory: swarmWorkflowJournalDirectory(cwd) }
}
