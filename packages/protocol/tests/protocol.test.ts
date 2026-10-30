import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  AHP_METHODS, AHP_METHOD_DEFINITIONS, assertInteractionResponse, assertRequest, assertResult, itemIdentity,
  negotiateVersion, publicEvent, publicInteraction, publicValue, supportsCapability, supportsExtension,
  validateDefinition, validateEvent, validateInteractionResponse, validateJsonSchema, validateRequest, validateResult,
  type AhpEvent, type AhpMethod, type AhpRequestMap, type AhpResultMap, type InteractionRequested, type Item,
} from '../src'

const binding = { sessionId: 's', adapterId: 'fake', runtimeConfigId: 'fake-1' }

test('structured image outputs validate blob identity and distinguish generated images from views', () => {
  const item = { id: 'image', type: 'toolCall', kind: 'image', title: 'Image', image: { kind: 'generated', blob: { sha256: 'a'.repeat(64), mimeType: 'image/png', bytes: 42 } } }
  expect(validateDefinition('Item', item)).toBe(true)
  expect(validateDefinition('Item', { ...item, image: { kind: 'view', path: '/tmp/input.png' } })).toBe(true)
  expect(validateDefinition('Item', { ...item, image: { ...item.image, blob: { ...item.image.blob, sha256: '../../bad' } } })).toBe(false)
  expect(validateDefinition('Item', { ...item, image: { ...item.image, blob: { ...item.image.blob, mimeType: 'text/html' } } })).toBe(false)
})
const state = { binding, status: 'ready' as const, config: {}, capabilities: {}, capabilityRevision: 0 }
const base = { sessionId: 's', requestId: 'r' }
const boundary = { turnId: 't', relation: 'before' as const }
const requests: AhpRequestMap = {
  initialize: { protocolVersions: [1], clientInfo: { name: 'test', version: '1' }, clientCapabilities: {} },
  'session/open': { requestId: 'r', mode: 'new', binding, cwd: '/workspace' },
  'session/close': base,
  'session/config/set': { ...base, patch: { model: 'fake' } },
  'session/revert': { ...base, boundary, scope: 'conversation' },
  'history/read': { ...base, limit: 25 },
  'turn/start': { ...base, turnId: 't', input: [{ type: 'text', text: 'hello' }] },
  'turn/steer': { ...base, expectedTurnId: 't', input: [{ type: 'text', text: 'adjust' }] },
  'turn/interrupt': { ...base, turnId: 't' },
  'interaction/respond': { ...base, interactionId: 'i', response: { kind: 'approval', optionId: 'deny' } },
  'interaction/cancel': { ...base, interactionId: 'i' },
  'goal/set': { ...base, goal: { text: 'goal' } }, 'goal/clear': base,
  'compact/start': base, 'review/start': { ...base, turnId: 't-review', target: { type: 'uncommitted' } },
}
const results: AhpResultMap = {
  initialize: { protocolVersion: 1, runtime: { name: 'fake', version: '1', adapter: 'fake/1' }, capabilities: {} },
  'session/open': { binding, streamId: 'stream', state, capabilities: {} }, 'session/close': { closed: true },
  'session/config/set': state, 'session/revert': { appliedScope: 'conversation', boundary },
  'history/read': { items: [], snapshotToken: 'snapshot', nextCursor: null },
  'turn/start': { turnId: 't', accepted: true }, 'turn/steer': { turnId: 't' },
  'turn/interrupt': { accepted: true }, 'interaction/respond': { interactionId: 'i', outcome: 'responded' },
  'interaction/cancel': { interactionId: 'i', outcome: 'cancelled' }, 'goal/set': { goal: { text: 'goal' }, status: 'active' },
  'goal/clear': { goal: null, status: 'cleared' }, 'compact/start': { maintenanceId: 'm', status: 'completed' },
  'review/start': { turnId: 't-review', accepted: true },
}
const envelope = { sessionId: 's', streamId: 'stream', seq: 1, timestamp: '2026-10-26T00:00:00.000Z', turnId: 't' }

describe('schema and generation', () => {
  test('every method has a validating request and result', () => {
    expect(Object.keys(requests).sort()).toEqual([...AHP_METHODS].sort())
    expect(Object.keys(results).sort()).toEqual([...AHP_METHODS].sort())
    for (const method of AHP_METHODS) {
      expect(validateRequest(method, requests[method])).toBe(true)
      expect(validateResult(method, results[method])).toBe(true)
      expect(AHP_METHOD_DEFINITIONS[method]).toHaveLength(2)
    }
  })
  test('generated types are deterministic and checked from the schema', () => {
    const generated = new URL('../src/generated/types.ts', import.meta.url)
    const before = readFileSync(generated, 'utf8')
    const check = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/generate.ts', import.meta.url)), '--check'])
    expect(check.status).toBe(0)
    expect(readFileSync(generated, 'utf8')).toBe(before)
  })
  test('rejects missing target, empty identifiers, invalid scope and implicit resume', () => {
    expect(validateRequest('turn/steer', { ...base, input: [{ type: 'text', text: 'x' }] })).toBe(false)
    expect(validateRequest('turn/start', { ...requests['turn/start'], turnId: '' })).toBe(false)
    expect(validateRequest('session/revert', { ...requests['session/revert'], scope: 'everything' })).toBe(false)
    expect(validateRequest('session/open', { ...requests['session/open'], mode: 'resume' })).toBe(false)
    expect(validateRequest('session/open', { ...requests['session/open'], mode: 'fork' })).toBe(false)
    expect(() => assertRequest('turn/start', { secret: 'do-not-copy' })).toThrow('Invalid AHP TurnStartParams')
  })
  test('unknown optional fields survive validation without becoming required', () => {
    const params = { ...requests['turn/start'], futureOptional: { x: true } }
    expect(validateRequest('turn/start', params)).toBe(true)
    expect(params.futureOptional).toEqual({ x: true })
  })
})

describe('version and capability compatibility', () => {
  test('negotiates only shared versions and fails before work', () => {
    expect(negotiateVersion([2, 1])).toBe(1)
    expect(() => negotiateVersion([2])).toThrow('No mutually supported')
    try { negotiateVersion([2]) } catch (error) { expect((error as { code: string }).code).toBe('PROTOCOL_VERSION_UNSUPPORTED') }
  })
  test('missing and empty capabilities are unsupported; extensions are explicit', () => {
    expect(supportsCapability({}, 'session.resume')).toBe(false)
    expect(supportsCapability({ session: { fork: [] } }, 'session.fork')).toBe(false)
    expect(supportsCapability({ session: { fork: ['before'] } }, 'session.fork', 'before')).toBe(true)
    expect(supportsCapability({ session: { fork: ['before'] } }, 'session.fork', 'through')).toBe(false)
    const caps = { extensions: [{ name: 'x-example/replay', version: '1' }] }
    expect(supportsExtension(caps, 'x-example/replay', '1')).toBe(true)
    expect(supportsExtension(caps, 'x-example/replay', '2')).toBe(false)
    expect(supportsExtension({}, 'x-example/replay')).toBe(false)
    expect(validateDefinition('Capabilities', { extensions: [{ name: 'unsafe', version: '1' }] })).toBe(false)
  })
})

describe('items and ordered source envelopes', () => {
  const items: Item[] = [
    { id: 'same', type: 'userMessage', content: [{ type: 'text', text: 'input' }, { type: 'file', uri: 'file:///a' }, { type: 'image', url: 'https://example.test/i' }] },
    { id: 'same', type: 'agentMessage', text: 'authoritative', phase: 'final' },
    { id: 'same', type: 'reasoning', summary: 'allowed summary' },
    { id: 'same', type: 'plan', steps: [{ id: 'p', text: 'work', status: 'pending' }] },
    { id: 'same', type: 'toolCall', kind: 'other', title: 'display only', nativeType: 'future', raw: { safe: true } },
    { id: 'same', type: 'subagent', subagentId: 'child', state: 'running' },
    { id: 'same', type: 'review', state: 'entered' }, { id: 'same', type: 'compaction', summary: 'small' },
    { id: 'same', type: 'hook', name: 'pre-tool' }, { id: 'same', type: 'notice', severity: 'warning', text: 'notice' },
  ]
  test('all item variants have validating complete snapshots', () => {
    for (const item of items) expect(validateEvent({ ...envelope, type: 'item/completed', payload: { item } })).toBe(true)
    expect(items).toHaveLength(10)
  })
  test('sequence must be positive and stream identity is explicit', () => {
    expect(validateEvent({ ...envelope, type: 'turn/started', payload: { turnId: 't' } })).toBe(true)
    expect(validateEvent({ ...envelope, seq: 0, type: 'turn/started', payload: { turnId: 't' } })).toBe(false)
    expect(validateEvent({ ...envelope, streamId: '', type: 'turn/started', payload: { turnId: 't' } })).toBe(false)
    expect(itemIdentity('s', 't1', 'same')).not.toBe(itemIdentity('s', 't2', 'same'))
    expect(itemIdentity('s/a', 'b', 'c')).not.toBe(itemIdentity('s', 'a/b', 'c'))
  })
  test('usage never requires fields not supplied by a provider', () => {
    expect(validateDefinition('Usage', { provider: 'fake', scope: 'turn', source: 'native', output: 3 })).toBe(true)
    expect(validateDefinition('Usage', { provider: 'fake', scope: 'turn', source: 'estimated', total: 3 })).toBe(false)
    expect(validateDefinition('Usage', { provider: 'fake', scope: 'turn', source: 'native', input: -1 })).toBe(false)
  })
})

describe('interactions and private payload projection', () => {
  const approval: InteractionRequested = { interactionId: 'i', kind: 'approval', options: [{ id: 'yes', label: 'Allow once' }, { id: 'no', label: 'Deny' }] }
  test('only offered approval option IDs can be selected', () => {
    expect(validateInteractionResponse(approval, { kind: 'approval', optionId: 'yes' })).toBe(true)
    expect(validateInteractionResponse(approval, { kind: 'approval', optionId: 'allowSession' })).toBe(false)
    expect(() => assertInteractionResponse(approval, { kind: 'approval', optionId: 'bad' })).toThrow('Invalid interaction response')
  })
  test('user questions, elicitation schemas and tool responses validate', () => {
    const question: InteractionRequested = { interactionId: 'q', kind: 'userInput', questions: [{ id: 'choice', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }], schema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] } }
    expect(validateInteractionResponse(question, { kind: 'userInput', answers: {} })).toBe(false)
    expect(validateInteractionResponse(question, { kind: 'userInput', answers: { choice: 'b' } })).toBe(false)
    expect(validateInteractionResponse(question, { kind: 'userInput', answers: { choice: 'a' } })).toBe(true)
    const form: InteractionRequested = { interactionId: 'f', kind: 'elicitation', mode: 'form', schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } }
    expect(validateInteractionResponse(form, { kind: 'elicitation', action: 'accept', content: { count: 'oops' } })).toBe(false)
    expect(validateInteractionResponse(form, { kind: 'elicitation', action: 'decline' })).toBe(true)
    expect(validateInteractionResponse({ interactionId: 'd', kind: 'dynamicTool', toolName: 'example', arguments: {} }, { kind: 'dynamicTool', content: [{ type: 'text', text: 'result' }] })).toBe(true)
  })
  test('resolved unknown is explicit and schema-valid', () => {
    expect(validateEvent({ ...envelope, type: 'interaction/resolved', payload: { interactionId: 'i', outcome: 'unknown' } })).toBe(true)
    expect(validateEvent({ ...envelope, type: 'interaction/resolved', payload: { interactionId: 'i', outcome: 'approvedProbably' } })).toBe(false)
  })
  test('public projection removes private URL and secrets without mutating in-memory original', () => {
    const event: AhpEvent = { ...envelope, type: 'interaction/requested', payload: { interactionId: 'url', kind: 'elicitation', mode: 'url', privatePayload: { url: 'https://auth.test/login?secret=token#fragment', token: 'credential' }, message: 'Open https://auth.test/login?credential=secret#fragment' } }
    const safe = publicEvent(event)
    const wire = JSON.stringify(safe)
    expect(wire).not.toContain('credential')
    expect(wire).not.toContain('?')
    expect(wire).not.toContain('privatePayload"')
    expect(wire).toContain('privatePayloadAvailable')
    expect(event.payload.privatePayload?.token).toBe('credential')
    expect(validateEvent(safe)).toBe(true)
    expect(publicInteraction({ ...approval, privatePayload: { password: 'secret' } }).privatePayload).toBeUndefined()
  })
})

describe('JSON-RPC wire and documentation', () => {
  test('wire notification method must match full event payload type', () => {
    const message = { jsonrpc: '2.0', method: 'turn/started', params: { ...envelope, type: 'turn/started', payload: { turnId: 't' } } }
    expect(validateDefinition('AhpRpcMessage', message)).toBe(true)
    expect(validateDefinition('AhpRpcMessage', { ...message, method: 'turn/completed' })).toBe(false)
    expect(validateDefinition('AhpRpcMessage', { ...message, id: 1 })).toBe(false)
    expect(validateDefinition('AhpRpcMessage', { ...message, jsonrpc: undefined })).toBe(false)
  })
  test('every JSONL documentation example is schema-valid', () => {
    const doc = readFileSync(new URL('../../../spec/ahp-v1.md', import.meta.url), 'utf8')
    const blocks = [...doc.matchAll(/```jsonl\n([\s\S]*?)\n```/g)]
    expect(blocks.length).toBeGreaterThan(0)
    let count = 0
    for (const block of blocks) for (const line of block[1]!.split('\n')) {
      if (!line.trim()) continue
      expect(validateDefinition('AhpRpcMessage', JSON.parse(line))).toBe(true)
      count++
    }
    expect(count).toBeGreaterThanOrEqual(10)
  })
})


test('public interaction preserves secret classification booleans without exposing secret values', () => {
  const request: InteractionRequested = {interactionId:'secret-question',kind:'userInput',questions:[{id:'q',prompt:'Credential',secret:true}],privatePayload:{secret:'actual-credential'}};
  const safe=publicInteraction(request);expect(safe.kind==='userInput' && safe.questions[0]?.secret).toBe(true);expect(validateDefinition('InteractionRequested',safe)).toBe(true);expect(JSON.stringify(safe)).not.toContain('actual-credential');
})

test('result assertions, public values and broken schemas fail closed', () => {
  expect(() => assertResult('turn/start', { bad: true })).toThrow('Invalid AHP TurnStartResult')
  expect(validateJsonSchema({ $ref: '#/definitions/nonexistent' }, {})).toBe(false)
  expect(publicValue({ token: 'credential', nested: [{ apiKey: 'k', url: 'https://x.test/a?token=SECRET' }] })).toEqual({ token: '[redacted]', nested: [{ apiKey: '[redacted]', url: 'https://x.test/a' }] })
})

test('file-change source material is optional and validates every discriminated variant', () => {
  const item = { id: 'edit', type: 'toolCall', kind: 'fileChange', title: 'File changes' }
  expect(validateDefinition('Item', item)).toBe(true)
  const valid = { ...item, fileChanges: [{ path: 'index.ts', operation: 'modify', completeness: 'complete', materials: [{ format: 'unified', patch: '@@ -57 +57 @@\n-old\n+new\n' }, { format: 'text', scope: 'fragment', oldText: '', newText: 'new', oldStartLine: 1 }, { format: 'unavailable', reason: 'binary' }] }] }
  expect(validateDefinition('Item', valid)).toBe(true)
  expect(validateDefinition('Item', { ...valid, fileChanges: [{ ...valid.fileChanges[0], materials: [{ format: 'text', scope: 'fragment', oldText: null, newText: '', oldStartLine: 0 }] }] })).toBe(false)
  expect(validateDefinition('Item', { ...valid, fileChanges: [{ ...valid.fileChanges[0], materials: [{ format: 'unified', oldText: 'wrong' }] }] })).toBe(false)
})


test('session metadata distinguishes absent, changed and cleared titles without requiring a turn', () => {
  const envelope = { sessionId: 's', streamId: 'stream', seq: 1, timestamp: new Date().toISOString() }
  for (const payload of [{}, { title: 'Title' }, { title: null }]) {
    expect(validateEvent({ ...envelope, type: 'session/metadata', payload })).toBe(true)
  }
  expect(validateEvent({ ...envelope, type: 'session/metadata', payload: { title: 123 } })).toBe(false)
})
