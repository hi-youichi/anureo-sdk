import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { toHostEvent, toHostMessage, type PiHostEntry } from '../src/host'
import { createRedactor, historyItems, nativeInput, permissionTools, piFileChanges, piTurnError, toolKind, toolOutputText, turnStarts, usageOf } from '../src/mapping'
import { createPiCatalogSession, resolvePiProfile } from '../src/index'
import { fakeFactory, MODELS } from './fake-host'

test('only host.ts imports the Pi SDK at runtime', () => {
  const dir = join(import.meta.dir, '../src')
  for (const file of readdirSync(dir).filter(name => name.endsWith('.ts') && name !== 'host.ts')) {
    expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/from ['"]@earendil-works/)
  }
  expect(readFileSync(join(dir, 'host.ts'), 'utf8')).not.toMatch(/^import (?!type)[^\n]*@earendil-works/m)
})

test('tool kinds and file changes follow Pi tool names and argument shapes', () => {
  expect(['bash', 'powershell', 'edit', 'write', 'mcp__x__y', 'read'].map(toolKind)).toEqual(['command', 'command', 'fileChange', 'fileChange', 'mcp', 'other'])
  expect(piFileChanges('read', {})).toBeUndefined()
  expect(piFileChanges('edit', { path: 'a', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] })).toEqual([
    { path: 'a', operation: 'modify', completeness: 'complete', materials: [
      { format: 'text', scope: 'fragment', oldText: 'x', newText: 'y' }, { format: 'text', scope: 'fragment', oldText: 'p', newText: 'q' }] }])
  expect(piFileChanges('edit', { path: 'a', edits: [{ oldText: 'x' }] })![0]).toMatchObject({ completeness: 'partial', materials: [{ format: 'unavailable' }] })
  expect(piFileChanges('write', { path: 'n', content: 'hi' })![0]).toMatchObject({ operation: 'unknown', completeness: 'partial' })
  expect(piFileChanges('edit', {})).toEqual([])
})

test('tool results keep text and drop structured details', () => {
  expect(toolOutputText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }], details: { secret: 1 } })).toBe('ab')
  expect(toolOutputText('plain')).toBeDefined()
  expect(toolOutputText(undefined)).toBe('')
})

test('usage sums assistant messages and turn errors use native categories only', () => {
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 }
  expect(usageOf([{ role: 'assistant', content: '', usage }, { role: 'assistant', content: '', usage }, { role: 'user', content: '' }])).toMatchObject({ provider: 'pi', input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 })
  const failed = (errorMessage: string) => piTurnError({ role: 'assistant', content: '', stopReason: 'error', errorMessage })
  expect(failed('HTTP 401')?.code).toBe('AUTH_REQUIRED')
  expect(failed('403 forbidden')?.code).toBe('AUTH_FORBIDDEN')
  expect(failed('429')?.code).toBe('RATE_LIMITED')
  expect(failed('upstream 502')?.code).toBe('NATIVE_SERVICE_UNAVAILABLE')
  expect(failed('boom')).toMatchObject({ code: 'PI_TURN_FAILED', message: 'Pi model request failed' })
  expect(piTurnError({ role: 'assistant', content: '', stopReason: 'stop' })).toBeUndefined()
  expect(piTurnError(undefined)).toBeUndefined()
})

test('input accepts text and base64 images and rejects everything else', () => {
  expect(nativeInput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }])).toEqual({ text: 'a\n\nb', images: [{ data: 'AA==', mimeType: 'image/png' }] })
  expect(() => nativeInput([{ type: 'image', url: 'https://x/y.png' }])).toThrow()
  expect(() => nativeInput([{ type: 'file', uri: 'file:///x' }])).toThrow()
})

test('permission modes map to tool allowlists and nothing else', () => {
  expect(permissionTools(undefined)).toBeUndefined()
  expect(permissionTools('read-only')).toEqual(['read', 'grep', 'find', 'ls'])
  expect(permissionTools('agent-full-access')).toContain('bash')
  expect(() => permissionTools('agent')).toThrow()
})

test('redaction replaces longest secrets first, deeply, and ignores empty values', () => {
  const redact = createRedactor(['abc', 'abcdef', ''])
  expect(redact.text('x abcdef y abc')).toBe('x [REDACTED] y [REDACTED]')
  expect(redact.json({ a: ['abcdef', { b: 'abc' }], n: 1, u: undefined })).toEqual({ a: ['[REDACTED]', { b: '[REDACTED]' }], n: 1 })
  expect(createRedactor().text('abc')).toBe('abc')
})

const entry = (id: string, parentId: string | null, message: PiHostEntry['message']): PiHostEntry => ({ id, parentId, kind: 'message', message })
test('turn starts: first message and user messages after a finished assistant message, not steering after tool use', () => {
  const entries = [
    entry('1', null, { role: 'user', content: 'a' }),
    entry('2', '1', { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'bash', arguments: {} }], stopReason: 'toolUse' }),
    entry('3', '2', { role: 'user', content: 'steer' }),
    entry('4', '3', { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }),
    entry('5', '4', { role: 'user', content: 'b' }),
  ]
  expect([...turnStarts(entries, new Map())]).toEqual(['1', '5'])
  expect([...turnStarts(entries, new Map([['3', 'turn-x']]))]).toEqual(['1', '3', '5'])
  const items = historyItems(createRedactor(), entries, new Map([['1', 'T1']]))
  expect(items[0]).toMatchObject({ turnId: 'T1', nativeTurnId: '1' })
  expect(items.at(-1)).toMatchObject({ turnId: 'native:5', nativeTurnId: '5' })
})

test('Pi messages and events normalize into the host shape', () => {
  const message = toHostMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: 't' }, { type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'ls' } }, { type: 'weird' }], stopReason: 'toolUse', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, timestamp: 5, api: 'ignored' })
  expect(message).toMatchObject({ role: 'assistant', stopReason: 'toolUse', usage: { totalTokens: 3 }, timestamp: 5 })
  expect(message.content).toEqual([{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: 't' }, { type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'ls' } }, { type: 'text', text: '' }])
  expect(toHostMessage({ role: 'user', content: 'plain' }).content).toBe('plain')
  const e = (value: unknown) => toHostEvent(value as AgentSessionEvent)
  expect(e({ type: 'agent_settled', aborted: true })).toEqual({ type: 'settled', aborted: true })
  expect(e({ type: 'agent_end', messages: [], willRetry: true })).toEqual({ type: 'agent_end', willRetry: true })
  expect(e({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'x' } })).toMatchObject({ type: 'message_update', update: { kind: 'text', phase: 'delta', index: 1, delta: 'x' } })
  expect(e({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'done' } })).toBeUndefined()
  expect(e({ type: 'tool_execution_end', toolCallId: 'c', toolName: 'bash', result: 'r', isError: true })).toEqual({ type: 'tool_end', id: 'c', name: 'bash', result: 'r', isError: true })
  expect(e({ type: 'auto_retry_end', success: false, attempt: 2 })).toEqual({ type: 'retry', phase: 'end', attempt: 2, success: false })
  expect(e({ type: 'queue_update', steering: [], followUp: [] })).toBeUndefined()
})

test('version profiles: verified, newer same-major, older and other majors', () => {
  expect(resolvePiProfile('1.5.2')).toMatchObject({ resume: true, fork: true, compact: true, verified: true })
  expect(resolvePiProfile('1.9.0')).toMatchObject({ resume: true, verified: false })
  for (const version of ['1.5.1', '0.74.2', '2.0.0', undefined, 'nope']) expect(resolvePiProfile(version)).toMatchObject({ resume: false, fork: false, compact: false, verified: false })
})

test('the catalog lists models from a throwaway in-memory host and always disposes it', async () => {
  const fake = fakeFactory()
  const { models } = await createPiCatalogSession({ createHost: fake.factory })
  expect(models).toEqual(MODELS)
  expect(fake.opens[0]).toMatchObject({ persist: false, mode: 'new' })
  expect(fake.hosts[0]!.disposed).toBe(true)
})
