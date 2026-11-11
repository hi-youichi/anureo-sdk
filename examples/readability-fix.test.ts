import { afterEach, expect, test } from 'bun:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createClient, HarnessSdkError, type Client } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import { fixReadability, parseReport, type Finding } from './readability-fix'

const clients: Client[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(paths = ['a.ts', 'b.ts']) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'anureo-readability-fix-')))
  directories.push(cwd)
  for (const path of paths) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), 'original\n')
  }
  return cwd
}

function finding(path: string, index = 1): Finding {
  return {
    id: `${path}#${index}`, path, sha256: createHash('sha256').update('original\n').digest('hex'),
    priority: 'medium', detail: `改善 ${path} 中第 ${index} 处名称。`, context: '保持运行行为。',
  }
}

type FixInput = { finding: Finding; ownedFiles: string[]; currentSha256: string }
type Reply = { status: 'changed' | 'already_satisfied' | 'deferred'; summary: string; checks: string[] }
async function backend(execute: (input: FixInput) => Promise<Reply>) {
  const calls: FixInput[] = []
  const adapter = createScriptedAdapter({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('input' in call.params)) return undefined
    const input = JSON.parse(call.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n')) as FixInput
    calls.push(input)
    const reply = await execute(input)
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'item/completed', payload: {
      item: { id: randomUUID(), type: 'agentMessage', phase: 'final', text: JSON.stringify(reply) },
    } }, { turnId })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { client, adapter, calls }
}

test('extracts each file finding once, retains synthesis context and reports coverage gaps', () => {
  const source = [
    '# 项目代码可读性审阅', '## Project agent 汇总', '- **medium: 合并建议**', '来源：`a.ts#1`',
    '## Package: example (.)', '先保持契约。', '### a.ts', `SHA-256: \`${'a'.repeat(64)}\``,
    '状态：reviewed。', '- **a.ts#1 (medium)**：one，L1–L2', '  改进方案：改名。',
    '  > oldName', '- **a.ts#2 (low)**：two，L3–L3', '  改进方案：排版。',
    '### missing.ts', 'SHA-256: `unavailable`', '审阅失败：无法读取',
    '### unfinished.ts', '状态：incomplete。未读完。',
  ].join('\n')
  const parsed = parseReport(source)
  expect(parsed.findings.map(item => item.id)).toEqual(['a.ts#1', 'a.ts#2'])
  expect(parsed.findings[0]!.detail).toContain('> oldName')
  expect(parsed.findings[0]!.detail).not.toContain('a.ts#2')
  expect(parsed.findings[0]!.context).toContain('先保持契约。')
  expect(parsed.coverageGaps).toEqual(['missing.ts', 'unfinished.ts'])
  expect(() => parseReport(source.replace('a.ts#2 (low)', 'a.ts#1 (low)'))).toThrow('duplicate finding')
})

test('uses one session per finding, serializes file edits and bounds cross-file concurrency', async () => {
  const cwd = await fixture()
  let active = 0
  let maximum = 0
  const activePaths = new Set<string>()
  const harness = await backend(async input => {
    expect(activePaths.has(input.finding.path)).toBe(false)
    activePaths.add(input.finding.path)
    maximum = Math.max(maximum, ++active)
    try {
      if (input.finding.id === 'a.ts#2') expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('a.ts#1')
      await new Promise(resolve => setTimeout(resolve, 5))
      await writeFile(join(cwd, input.finding.path), `${input.finding.id}\n`)
      return { status: 'changed', summary: '已修改。', checks: ['fixture validation'] }
    } finally { active--; activePaths.delete(input.finding.path) }
  })
  const result = await fixReadability({ ...harness, cwd, findings: [finding('a.ts'), finding('a.ts', 2), finding('b.ts')],
    outputDir: join(cwd, 'out'), concurrency: 2,
  })
  expect(maximum).toBe(2)
  expect(harness.calls.map(call => call.finding.id).sort()).toEqual(['a.ts#1', 'a.ts#2', 'b.ts#1'])
  expect(harness.adapter.opened).toHaveLength(3)
  expect(new Set(harness.adapter.opened.map(session => session.binding.sessionId)).size).toBe(3)
  expect(result.results.map(item => [item.id, item.status, item.changedFiles])).toEqual([
    ['a.ts#1', 'changed', ['a.ts']], ['a.ts#2', 'changed', ['a.ts']], ['b.ts#1', 'changed', ['b.ts']],
  ])
  expect(JSON.parse(await readFile(join(cwd, 'out/results.json'), 'utf8')).results).toHaveLength(3)
})

test('serializes schema and generator ownership while keeping one agent per suggestion', async () => {
  const schema = 'packages/protocol/schema/v1/ahp.schema.json'
  const generator = 'packages/protocol/scripts/generate.ts'
  const generated = 'packages/protocol/src/generated/types.ts'
  const cwd = await fixture([schema, generator, generated])
  const harness = await backend(async input => {
    if (input.finding.path === generated) expect(await readFile(join(cwd, generated), 'utf8')).toBe('regenerated\n')
    else await writeFile(join(cwd, generated), 'regenerated\n')
    return { status: input.finding.path === generated ? 'already_satisfied' : 'changed', summary: '维护入口已核实。', checks: [] }
  })
  const result = await fixReadability({ ...harness, cwd, findings: [finding(schema), finding(generated)],
    outputDir: join(cwd, 'out'), concurrency: 2,
  })
  expect(harness.calls.map(call => call.ownedFiles)).toEqual([[schema, generated], [generator, generated]])
  expect(result.results.map(item => item.status)).toEqual(['changed', 'already_satisfied'])
})

test('a false changed claim stops later findings in that file without dropping other files', async () => {
  const cwd = await fixture()
  const harness = await backend(async input => {
    return { status: input.finding.path === 'a.ts' ? 'changed' : 'deferred', summary: '需要核实契约。', checks: [] }
  })
  const result = await fixReadability({ ...harness, cwd, findings: [finding('a.ts'), finding('a.ts', 2), finding('b.ts')],
    outputDir: join(cwd, 'out'), concurrency: 1,
  })
  expect(result.results.map(item => item.status)).toEqual(['failed', 'not_started', 'deferred'])
  expect(harness.calls).toHaveLength(2)
})

test('an unknown native outcome prevents queued sessions and is never retried', async () => {
  const cwd = await fixture()
  const harness = await backend(async () => { throw new HarnessSdkError('SOURCE_LOST', 'Unknown writer state', false, true) })
  const result = await fixReadability({ ...harness, cwd, findings: [finding('a.ts'), finding('b.ts'), finding('a.ts', 2)],
    outputDir: join(cwd, 'out'), concurrency: 1,
  })
  expect(harness.calls).toHaveLength(1)
  expect(result.stopReason).toContain('Uncertain execution')
  expect(result.results.map(item => item.status)).toEqual(['failed', 'not_started', 'not_started'])
})

test('validates paths and concurrency before starting any agent', async () => {
  const cwd = await fixture()
  const harness = await backend(async () => ({ status: 'already_satisfied', summary: '已满足。', checks: [] }))
  const options = { ...harness, cwd, findings: [finding('../escape.ts')], outputDir: join(cwd, 'out'), concurrency: 1 }
  await expect(fixReadability(options)).rejects.toThrow('regular project file')
  await expect(fixReadability({ ...options, concurrency: 0 })).rejects.toThrow('concurrency')
  await symlink(join(cwd, 'a.ts'), join(cwd, 'link.ts'))
  await expect(fixReadability({ ...options, findings: [finding('link.ts')] })).rejects.toThrow('regular project file')
  expect(harness.calls).toHaveLength(0)
})
