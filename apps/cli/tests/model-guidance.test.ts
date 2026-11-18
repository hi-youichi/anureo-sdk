import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ModelGuidance, type SwarmModelCatalog } from '@anureo/adapter-swarm'
import { applyModelGuidance } from '../src/model-guidance'

const guidance = (summary: string): ModelGuidance => ({ summary, relativeCost: 'unknown', source: 'Test policy', reviewedAt: '2026-11-17' })
const catalog = (): SwarmModelCatalog => ({ default: { status: 'available', policy: 'allowlist', models: [
  { id: 'exact/id', description: 'Native', efforts: [{ id: 'low' }], guidance: guidance('Existing application advice') },
  { id: 'second', hidden: true },
] } })

async function directories(work: (project: string, home: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'anureo-model-guidance-'))
  const project = join(root, 'project'), home = join(root, 'home')
  try {
    await Promise.all([mkdir(join(project, '.anureo'), { recursive: true }), mkdir(join(home, '.anureo'), { recursive: true })])
    await work(project, home)
  } finally { await rm(root, { recursive: true, force: true }) }
}

const write = (root: string, backends: object) => writeFile(join(root, '.anureo', 'model-guidance.json'), '\uFEFF' + JSON.stringify({ version: 1, backends }))

test('project guidance replaces whole user entries with exact backend/ID matching and native facts intact', async () => {
  await directories(async (project, home) => {
    await write(home, { codex: { 'exact/id': { ...guidance('User advice'), preferredTasks: ['Must not leak into project advice'] }, second: guidance('User second') }, claude: { 'exact/id': guidance('Wrong backend') } })
    await write(project, { codex: { 'exact/id': guidance('Project advice'), 'Exact/id': guidance('Wrong case'), missing: guidance('Not available') } })
    const original = catalog()
    const merged = await applyModelGuidance(original, 'codex', project, home)
    expect(merged.default).toEqual({ status: 'available', policy: 'allowlist', models: [
      { id: 'exact/id', description: 'Native', efforts: [{ id: 'low' }], guidance: guidance('Project advice') },
      { id: 'second', hidden: true, guidance: guidance('User second') },
    ] })
    expect(JSON.stringify(original)).toContain('Existing application advice')
    expect(JSON.stringify(merged)).not.toContain('Must not leak')
  })
})

test('project null removes inherited advice, and absent files or failed discovery never manufacture models', async () => {
  await directories(async (project, home) => {
    expect((await applyModelGuidance(catalog(), 'codex', project, home)).default).toEqual(catalog().default)
    await write(home, { codex: { 'exact/id': guidance('User advice') } })
    await write(project, { codex: { 'exact/id': null } })
    const merged = await applyModelGuidance(catalog(), 'codex', project, home)
    expect(merged.default?.status === 'available' && merged.default.models[0].guidance).toBeUndefined()
    expect(await applyModelGuidance({ default: { status: 'unavailable', reason: 'Offline' } }, 'codex', project, home)).toEqual({ default: { status: 'unavailable', reason: 'Offline' } })
    expect(await applyModelGuidance({ default: { status: 'available', models: [] } }, 'codex', project, home)).toEqual({ default: { status: 'available', models: [] } })
  })
})

test('explicit malformed configuration fails instead of silently falling back, even without discovery', async () => {
  await directories(async (project, home) => {
    const file = join(project, '.anureo', 'model-guidance.json')
    for (const content of ['{', JSON.stringify({ version: 2, backends: {} }), JSON.stringify({ version: 1, bakends: {} }), JSON.stringify({ version: 1, backends: { codex: { ' id': guidance('Bad ID') } } }), JSON.stringify({ version: 1, backends: { claude: { id: { ...guidance('Other backend still validated'), source: '' } } } }), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      await writeFile(file, content)
      await expect(applyModelGuidance({}, 'codex', project, home)).rejects.toThrow('Cannot load model guidance')
    }
  })
})

test('advice cannot overwrite native fields or recommend unsupported native efforts', async () => {
  await directories(async (project, home) => {
    await write(project, { codex: { 'exact/id': { ...guidance('Bad override'), efforts: [{ id: 'high' }] } } })
    await expect(applyModelGuidance(catalog(), 'codex', project, home)).rejects.toThrow('Unknown model guidance field')
    await write(project, { codex: { 'exact/id': { ...guidance('Bad effort'), recommendedEffort: 'high' } } })
    await expect(applyModelGuidance(catalog(), 'codex', project, home)).rejects.toThrow('Unsupported recommended effort')
  })
})
