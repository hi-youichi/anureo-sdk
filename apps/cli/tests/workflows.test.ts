import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCli, type CliDependencies } from '../src/cli'
import { loadSwarmWorkflows } from '../src/workflows'

const fixture = fileURLToPath(new URL('../../../packages/adapter/swarm/tests/fake-acp.mjs', import.meta.url))
const beerEntry = pathToFileURL(fileURLToPath(new URL('../../../packages/adapter/swarm/src/workflow/index.ts', import.meta.url))).href

async function invoke(args: string[], dependencies: Pick<CliDependencies, 'cwd' | 'homeDirectory'> = {}) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(args, {
    ...dependencies,
    stdout: text => { stdout += text },
    stderr: text => { stderr += text },
  })
  return { code, stdout, stderr }
}

test('discovers project workflows over user workflows with the same id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anureo-workflows-'))
  try {
    const home = join(root, 'home')
    const project = join(root, 'project')
    const userWorkflows = join(home, '.anureo', 'workflows')
    const projectWorkflows = join(project, '.anureo', 'workflows')
    await Promise.all([mkdir(userWorkflows, { recursive: true }), mkdir(projectWorkflows, { recursive: true })])
    const registration = (id: string, marker: string) => `export const workflow = { id: ${JSON.stringify(id)}, description: ${JSON.stringify(marker)}, revision: '1', run: async () => ${JSON.stringify(marker)} }`
    await Promise.all([
      writeFile(join(userWorkflows, 'dupe.ts'), registration('dupe', 'user')),
      writeFile(join(projectWorkflows, 'dupe.ts'), registration('dupe', 'project')),
      writeFile(join(projectWorkflows, 'solo.ts'), registration('solo', 'only')),
    ])
    const loaded = await loadSwarmWorkflows(project, home)
    expect(loaded.map(workflow => [workflow.id, workflow.scope, workflow.description])).toEqual([
      ['dupe', 'project', 'project'],
      ['solo', 'project', 'only'],
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runs a discovered workflow file through --workflow with JSON args', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anureo-workflows-'))
  try {
    const project = join(root, 'project')
    const workflowsDirectory = join(project, '.anureo', 'workflows')
    await mkdir(workflowsDirectory, { recursive: true })
    await writeFile(join(workflowsDirectory, 'greet.ts'), [
      `import { beer } from ${JSON.stringify(beerEntry)}`,
      `import type { Client } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../../packages/sdk/src/index.ts', import.meta.url))).href)}`,
      "export const workflow = {",
      "  id: 'greet', description: 'Greet through one bee step', revision: '1',",
      "  run: async (args: { name: string }, ctx: { client: Client; cwd: string; runId: string; signal: AbortSignal }) =>",
      "    ({ text: await beer(`greet ${args.name}`, { client: ctx.client, cwd: ctx.cwd }) }),",
      "}",
      '',
    ].join('\n'))
    const { code, stdout, stderr } = await invoke([
      '--harness', 'swarm:acp', '--command', 'node', '--args', JSON.stringify([fixture]),
      '--workflow', 'greet', '--output', 'result', '{"name":"CLI"}',
    ], { cwd: project })
    expect(stderr).toBe('')
    expect(code).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.status).toBe('completed')
    expect(result.items.filter((item: { type: string }) => item.type === 'subagent')).toHaveLength(1)
    expect(JSON.parse(result.text).status).toBe('completed')
    expect(JSON.parse(JSON.parse(result.text).result).text).toContain('Hello')
    // The journal directory is created under the project .anureo tree.
    const runsDirectory = join(project, '.anureo', 'workflow-runs')
    const runId = JSON.parse(result.text).runId as string
    expect((await import('node:fs/promises')).readdir(join(runsDirectory, runId))).resolves.toContain('journal.json')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('rejects --workflow without a swarm harness and validates args as JSON objects', async () => {
  expect(await invoke(['--harness', 'claude', '--workflow', 'greet', '{}'])).toMatchObject({
    code: 2, stderr: expect.stringContaining('--workflow requires a swarm harness'),
  })
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'anureo-workflows-'))
  try {
    const result = await invoke([
      '--harness', 'swarm:acp', '--command', 'node', '--args', JSON.stringify([fixture]),
      '--workflow', 'greet', 'not-json',
    ], { cwd: fixtureRoot })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('must be a JSON args object')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
