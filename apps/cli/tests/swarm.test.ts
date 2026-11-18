import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli, type CliDependencies } from '../src/cli'
import { loadBeeProfiles } from '../src/profiles'

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

test('rejects invalid Swarm backend selectors before starting a harness', async () => {
  for (const name of ['swarm:', 'swarm:unknown', 'swarm:codex:claude']) {
    expect(await invoke(['--harness', name, 'hello'])).toMatchObject({
      code: 2, stdout: '', stderr: expect.stringContaining(`unknown harness "${name}"`),
    })
  }
})

test('applies the selected backend flag rules to Swarm', async () => {
  expect(await invoke(['--harness', 'swarm:acp', 'hello'])).toMatchObject({
    code: 2, stdout: '', stderr: expect.stringContaining('--command is required with --harness swarm:acp'),
  })
  expect(await invoke(['--harness', 'swarm:pi', '--sandbox', 'read-only', 'hello'])).toMatchObject({
    code: 2, stdout: '', stderr: expect.stringContaining('--sandbox is not defined for harness "swarm:pi"'),
  })
})

test('requires a swarm harness for profile review', async () => {
  expect(await invoke(['--harness', 'codex', '--review-feedback', 'Check the assertions', 'hello'])).toMatchObject({
    code: 2, stdout: '', stderr: expect.stringContaining('profile review requires a swarm harness'),
  })
})

test('runs Swarm with the selected ACP backend and its command arguments', async () => {
  const fixture = fileURLToPath(new URL('../../../packages/adapter/swarm/tests/fake-acp.mjs', import.meta.url))
  const { code, stdout, stderr } = await invoke([
    '--harness', 'swarm:acp', '--command', 'node', '--args', JSON.stringify([fixture]),
    '--output', 'result', 'from CLI',
  ])
  expect(stderr).toBe('')
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toMatchObject({
    binding: { adapterId: 'swarm', runtimeConfigId: 'cli:acp' },
    status: 'completed',
    text: 'Hello from CLI',
  })
}, 15_000)

test('retains both profile origins from the Git root and supports default and scoped CLI mentions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anureo-bees-'))
  try {
    const homeDirectory = join(root, 'home')
    const project = join(root, 'project')
    const cwd = join(project, 'src')
    const userBees = join(homeDirectory, '.anureo', 'bees')
    const projectBees = join(project, '.anureo', 'bees')
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(userBees, { recursive: true }),
      mkdir(projectBees, { recursive: true }),
    ])
    const userProfile = { name: 'User tester', description: 'Test coverage', instructions: 'User instructions' }
    const projectProfile = { name: 'Project tester', description: 'Test coverage', instructions: 'Project instructions' }
    await Promise.all([
      writeFile(join(project, '.git'), 'gitdir: ../main/.git/worktrees/project'),
      writeFile(join(userBees, 'reviewer.json'), JSON.stringify({ ...userProfile, name: 'Reviewer' })),
      writeFile(join(userBees, 'tester.json'), JSON.stringify(userProfile)),
      writeFile(join(projectBees, 'tester.json'), JSON.stringify(projectProfile)),
    ])

    expect(await loadBeeProfiles(cwd, homeDirectory)).toEqual([
      { profile: { ...userProfile, id: 'reviewer', name: 'Reviewer' }, source: { scope: 'user', namespace: userBees }, sourceFile: join(userBees, 'reviewer.json') },
      { profile: { ...projectProfile, id: 'tester' }, source: { scope: 'project', namespace: projectBees }, sourceFile: join(projectBees, 'tester.json') },
      { profile: { ...userProfile, id: 'tester' }, source: { scope: 'user', namespace: userBees }, sourceFile: join(userBees, 'tester.json') },
    ])

    const fixture = fileURLToPath(new URL('../../../packages/adapter/swarm/tests/fake-acp.mjs', import.meta.url))
    for (const [mention, scope, name] of [
      ['@tester', 'project', 'Project tester'],
      ['@user/tester', 'user', 'User tester'],
      ['@project/tester', 'project', 'Project tester'],
      ['@reviewer', 'user', 'Reviewer'],
    ]) {
      const { code, stdout, stderr } = await invoke([
        '--harness', 'swarm:acp', '--command', 'node', '--args', JSON.stringify([fixture]),
        '--cd', 'src', '--output', 'result', '--verbose', `${mention} Check tests`,
      ], { cwd: project, homeDirectory })
      expect({ mention, code, stderr }).toMatchObject({ code: 0 })
      expect(stderr).toContain(`bee @project/tester from ${join(projectBees, 'tester.json')}`)
      expect(stderr).toContain(`bee @user/tester from ${join(userBees, 'tester.json')}`)
      const result = JSON.parse(stdout)
      expect(result.status).toBe('completed')
      expect(result.items.find((item: { type: string }) => item.type === 'subagent')).toMatchObject({
        name, task: 'Check tests', state: 'completed',
        extensions: { swarm: { kind: 'fixed', profileScope: scope } },
      })
    }
    const missing = await invoke([
      '--harness', 'swarm:acp', '--command', 'node', '--args', JSON.stringify([fixture]),
      '--output', 'result', '@project/reviewer Check tests',
    ], { cwd: project, homeDirectory })
    expect(missing.code).toBe(2)
    expect(JSON.parse(missing.stdout).error.code).toBe('SWARM_UNKNOWN_BEE')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
