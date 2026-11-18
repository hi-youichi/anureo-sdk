// Discovers workflow registrations from user and project .anureo/workflows/.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSwarmWorkflowRegistration, type SwarmWorkflowRegistration } from '@anureo/adapter-swarm'

export interface DiscoveredWorkflow extends SwarmWorkflowRegistration {
  scope: 'user' | 'project'
  sourceFile: string
}

const EXTENSIONS = ['.ts', '.js', '.mjs'] as const

/** Load workflow files; project files override user files with the same id. */
export async function loadSwarmWorkflows(cwd: string, homeDirectory?: string): Promise<DiscoveredWorkflow[]> {
  const found = new Map<string, DiscoveredWorkflow>()
  const scopes: Array<{ scope: 'user' | 'project'; directory: string }> = homeDirectory === undefined
    ? [{ scope: 'project', directory: join(cwd, '.anureo', 'workflows') }]
    : [{ scope: 'user', directory: join(homeDirectory, '.anureo', 'workflows') }, { scope: 'project', directory: join(cwd, '.anureo', 'workflows') }]
  for (const { scope, directory } of scopes) {
    let files: string[]
    try {
      files = (await readdir(directory)).filter(name => EXTENSIONS.some(extension => name.endsWith(extension))).sort()
    } catch { continue }
    for (const name of files) {
      const sourceFile = join(directory, name)
      let module: Record<string, unknown>
      try {
        module = (await import(pathToFileURL(sourceFile).href)) as Record<string, unknown>
      } catch (cause) {
        throw new Error(`cannot load workflow ${sourceFile}: ${(cause as Error).message}`)
      }
      const candidate = module.workflow ?? module.default
      if (candidate === undefined) continue
      const registration = parseSwarmWorkflowRegistration(candidate)
      found.set(registration.id, { ...registration, scope, sourceFile })
    }
  }
  return [...found.values()]
}

/** Default journal directory for CLI runs; kept under the project .anureo tree. */
export function workflowJournalDirectory(cwd: string): string {
  return join(cwd, '.anureo', 'workflow-runs')
}
