import { expect, test } from 'bun:test'
import { createSwarmAdapter, parseModelGuidance, type SwarmModelCatalog } from '../src'
import { parseModelCatalog, selectTemporaryModel, selectEffort, parseSelectionReason, executionSelection, type MemberBackend } from '../src/models'
import type { Client } from '@anureo/sdk'
import { validateJsonSchema, type JsonSchema } from '@anureo/protocol'
import { MANAGEMENT_TOOLS } from '../src/management-tools'

const backend = {} as Client
const route = (catalog?: MemberBackend['catalog']): MemberBackend => ({ client: backend, route: { kind: 'default' }, catalog })

test('bee_create schema enforces distinct temporary and scoped fixed contracts', () => {
  const schema = MANAGEMENT_TOOLS.find(tool => tool.name === 'bee_create')!.inputSchema as JsonSchema
  for (const args of [{ role: 'worker', name: 'Worker' }, { role: 'worker', name: 'Worker', model: 'exact/id' }, { profileId: 'reviewer' }, { profileId: 'reviewer', profileScope: 'project' }]) expect(validateJsonSchema(schema, args)).toBe(true)
  expect(validateJsonSchema(schema, { role: 'worker', name: 'Worker', selectionReason: 'Default because cost metadata is unavailable' })).toBe(true)
  expect(validateJsonSchema(schema, { role: 'worker', name: 'Worker', effort: 'low' })).toBe(true)
  expect(validateJsonSchema(schema, { profileId: 'reviewer', effort: 'low' })).toBe(false)
  for (const args of [{}, { profileScope: 'user' }, { role: 'worker' }, { profileId: 'reviewer', selectionReason: 'Override' }, { profileId: 'reviewer', model: 'override' }, { profileId: 'reviewer', role: 'worker', name: 'Worker' }, { role: 'worker', name: 'Worker', profileScope: 'user' }, { role: 'worker', name: 'Worker', backend: 'other' }]) expect(validateJsonSchema(schema, args)).toBe(false)
})

test('catalog validation rejects malformed entries, duplicate IDs and unbound routes before opening', () => {
  for (const modelCatalog of [
    null,
    { default: { status: 'other' } },
    { default: { status: 'available', models: [{ id: ' ' }] } },
    { default: { status: 'available', models: [{ id: ' model' }] } },
    { default: { status: 'available', models: [{ id: 'a' }, { id: 'a' }] } },
    { default: { status: 'available', models: [{ id: 'a', hidden: 'yes' }] } },
    { default: { status: 'available', models: [{ id: 'a' }], policy: 'automatic' } },
    { default: { status: 'unavailable', models: [] } },
    { members: { unknown: { status: 'available', models: [] } } },
  ]) expect(() => createSwarmAdapter({ backend, modelCatalog: modelCatalog as SwarmModelCatalog })).toThrow()
});

test('effort choices respect explicit backend mappings and known per-model support without inventing defaults', () => {
  const mapped = route({ status: 'available', effortConfigKey: 'effort', models: [{ id: 'fast', efforts: [{ id: 'low' }] }, { id: 'no-reasoning', efforts: [] }] })
  expect(selectEffort(undefined, 'fast', mapped)).toBeUndefined()
  expect(selectEffort('low', 'fast', mapped)).toBe('low')
  expect(() => selectEffort('high', 'fast', mapped)).toThrow('not supported')
  expect(() => selectEffort('low', 'no-reasoning', mapped)).toThrow('not supported')
  expect(() => selectEffort('low', 'fast', route())).toThrow('no configured effort mapping')
  expect(selectEffort('high', undefined, mapped)).toBe('high') // backend default model is unknown
  expect(selectEffort('low', 'unknown', mapped)).toBe('low') // native backend validates unknown models
  for (const value of [null, '', ' ', ' low', 'low ', 5, 'x'.repeat(129)]) expect(() => selectEffort(value, 'fast', mapped)).toThrow('exact backend effort ID')
  expect(() => parseModelCatalog({ default: { status: 'unavailable', effortConfigKey: 'model' } } as never)).toThrow('effort config key')
})

test('an allowlist constrains explicit temporary choices and preserves backend defaults', () => {
  for (const catalog of [
    { status: 'available', policy: 'allowlist', models: [] },
    { status: 'unavailable', policy: 'allowlist' },
  ] as const) {
    expect(selectTemporaryModel(undefined, route(catalog))).toBeUndefined()
    expect(() => selectTemporaryModel('unknown', route(catalog))).toThrow('not allowed')
  }
  const available = route({ status: 'available', policy: 'allowlist', models: [{ id: 'Exact/Model' }, { id: 'hidden', hidden: true }] })
  expect(selectTemporaryModel('Exact/Model', available)).toBe('Exact/Model')
  expect(selectTemporaryModel('hidden', available)).toBe('hidden')
  expect(() => selectTemporaryModel('exact/model', available)).toThrow('not allowed')
});

test('recommendation catalogs preserve exact IDs, missing discovery and unknown choices', () => {
  for (const catalog of [undefined, { status: 'available', models: [] }, { status: 'unavailable' }] as const) {
    expect(selectTemporaryModel('provider/a/b', route(catalog))).toBe('provider/a/b')
  }
  for (const model of [null, '', ' ', ' model', 'model ', 1, {}, 'x'.repeat(513)]) expect(() => selectTemporaryModel(model, route())).toThrow('exact model ID')
});

test('catalog parsing detaches nested application input without changing its order', () => {
  const input = { default: { status: 'available' as const, models: [{ id: 'B' }, { id: 'A' }] } }
  const parsed = parseModelCatalog(input, [])
  input.default.models[0].id = 'changed'
  input.default.models.push({ id: 'late' })
  expect(parsed.default).toEqual({ status: 'available', models: [{ id: 'B' }, { id: 'A' }] })
});

const advice = { summary: 'Bounded extraction', relativeCost: 'low' as const, comparisonGroup: 'test billing', preferredTasks: ['extraction'], limitations: ['No measured debugging results'], recommendedEffort: 'low', source: 'Test policy', reviewedAt: '2026-11-17' }

test('guidance and native metadata are validated and detached, with reproducible content revisions', () => {
  const input = { default: { status: 'available' as const, models: [{ id: 'fast', description: 'Native', efforts: [{ id: 'low', description: 'Quick' }], defaultEffort: 'low', serviceTiers: ['priority'], inputModalities: ['text'], guidance: { ...advice, preferredTasks: ['extraction'] } }] } }
  const copied = parseModelCatalog(input).default!
  const selection = executionSelection(route(copied), 'fast', false, 'Bounded extraction matches the recommendation')
  expect(selection.guidanceRevision).toMatch(/^[a-f0-9]{64}$/)
  expect(executionSelection(route(parseModelCatalog(input).default), 'fast', false).guidanceRevision).toBe(selection.guidanceRevision)
  input.default.models[0].guidance.preferredTasks.push('mutated')
  input.default.models[0].efforts[0].description = 'Mutated'
  expect(JSON.stringify(copied)).not.toContain('mutated')
  expect(JSON.stringify(copied)).not.toContain('Mutated')
  expect(executionSelection(route(parseModelCatalog(input).default), 'fast', false).guidanceRevision).not.toBe(selection.guidanceRevision)
  expect(executionSelection(route(copied), undefined, false).guidanceRevision).toBeUndefined()
  expect(executionSelection(route(copied), 'unknown', false).guidanceRevision).toBeUndefined()
})

test('malformed guidance cannot masquerade as trusted facts or supported efforts', () => {
  for (const invalid of [null, {}, { ...advice, source: '' }, { ...advice, reviewedAt: '2026-02-30' }, { ...advice, reviewedAt: 'recent' }, { ...advice, relativeCost: 'cheap' }, { ...advice, comparisonGroup: undefined }, { ...advice, preferredTasks: [''] }, { ...advice, capabilities: ['guaranteed'] }]) expect(() => parseModelGuidance(invalid)).toThrow()
  for (const fields of [{ efforts: [{ id: 'low' }], guidance: { ...advice, recommendedEffort: 'high' } }, { efforts: [{ id: 'low' }, { id: 'low' }] }, { efforts: 'high' }, { serviceTiers: [null] }, { inputModalities: [1] }]) expect(() => parseModelCatalog({ default: { status: 'available', models: [{ id: 'fast', ...fields } as never] } })).toThrow()
})

test('visible guidance requires reasons including fallback, while legacy and hidden-only catalogs remain compatible', () => {
  const guided = route({ status: 'available', models: [{ id: 'fast', guidance: advice }] })
  for (const value of [undefined, '', ' ', 'x'.repeat(2001)]) expect(() => parseSelectionReason(value, guided)).toThrow('selectionReason')
  expect(parseSelectionReason('No suitable guided model; use configured default', guided)).toContain('configured default')
  expect(parseSelectionReason(undefined, route())).toBeUndefined()
  expect(parseSelectionReason(undefined, route({ status: 'available', models: [{ id: 'fast', hidden: true, guidance: advice }] }))).toBeUndefined()
})
