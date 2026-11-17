import { expect, test } from 'bun:test'
import { createSwarmAdapter, type SwarmModelCatalog } from '../src'
import { parseModelCatalog, selectTemporaryModel, type MemberBackend } from '../src/models'
import type { Client } from '@anureo/sdk'
import { validateJsonSchema, type JsonSchema } from '@anureo/protocol'
import { MANAGEMENT_TOOLS } from '../src/management-tools'

const backend = {} as Client
const route = (catalog?: MemberBackend['catalog']): MemberBackend => ({ client: backend, route: { kind: 'default' }, catalog })

test('bee_create schema enforces distinct temporary and scoped fixed contracts', () => {
  const schema = MANAGEMENT_TOOLS.find(tool => tool.name === 'bee_create')!.inputSchema as JsonSchema
  for (const args of [{ role: 'worker', name: 'Worker' }, { role: 'worker', name: 'Worker', model: 'exact/id' }, { profileId: 'reviewer' }, { profileId: 'reviewer', profileScope: 'project' }]) expect(validateJsonSchema(schema, args)).toBe(true)
  for (const args of [{}, { profileScope: 'user' }, { role: 'worker' }, { profileId: 'reviewer', model: 'override' }, { profileId: 'reviewer', role: 'worker', name: 'Worker' }, { role: 'worker', name: 'Worker', profileScope: 'user' }, { role: 'worker', name: 'Worker', backend: 'other' }]) expect(validateJsonSchema(schema, args)).toBe(false)
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
