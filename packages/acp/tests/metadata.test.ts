import { expect, test } from 'bun:test'
import { ManagedHarnessSession } from '@anureo/sdk'
import { AcpUpdateMapper, mcp } from '../src/mapping'
import type { SessionState } from '@anureo/protocol'

test('http and stdio MCP servers map to explicit native ACP entries', () => {
  expect(mcp([
    { type: 'http', name: 'remote', url: 'https://mcp.test/api', headers: { Authorization: 'Bearer token' } },
    { type: 'stdio', name: 'local', command: 'run-tool', args: ['--stdio'], env: { TOOL_ENV: 'value' } },
    { type: 'stdio', name: 'defaults', command: 'bare' },
  ])).toEqual([
    { type: 'http', name: 'remote', url: 'https://mcp.test/api', headers: [{ name: 'Authorization', value: 'Bearer token' }] },
    { name: 'local', command: 'run-tool', args: ['--stdio'], env: [{ name: 'TOOL_ENV', value: 'value' }] },
    { name: 'defaults', command: 'bare', args: [], env: [] },
  ])
  expect(mcp()).toEqual([])
})

test('mapper reset forgets tracked state without breaking later updates', async () => {
  const binding = { sessionId: 's', adapterId: 'acp', runtimeConfigId: 'r' }
  const sink = new ManagedHarnessSession(binding, {})
  const state: SessionState = { binding, capabilities: {}, capabilityRevision: 1, status: 'ready', config: {} }
  const mapper = new AcpUpdateMapper(sink, () => 'turn-1', () => state, data => { state.metadata = { title: data.sessionTitle as string | null } }, false)
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'Before' })
  mapper.reset()
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'After' })
  expect(state.metadata?.title).toBe('After')
  await sink.dispose()
})

test('ACP idle metadata patches preserve absent titles and explicitly clear, without lifecycle events', async () => {
  const binding = { sessionId: 's', adapterId: 'acp', runtimeConfigId: 'r' }
  const sink = new ManagedHarnessSession(binding, {})
  const state: SessionState = { binding, capabilities: {}, capabilityRevision: 1, status: 'ready', config: {} }
  const mapper = new AcpUpdateMapper(sink, () => undefined, () => state, data => { state.metadata = { title: data.sessionTitle as string | null } }, false)
  await mapper.update({ sessionUpdate: 'session_info_update', updatedAt: 'now' })
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'Generated' })
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'Generated' })
  await mapper.update({ sessionUpdate: 'session_info_update', updatedAt: 'later' })
  expect(state.metadata?.title).toBe('Generated')
  await mapper.update({ sessionUpdate: 'session_info_update', title: null })
  const reader = sink.events()[Symbol.asyncIterator]()
  try {
    expect((await reader.next()).value).toMatchObject({ type: 'session/metadata', payload: { title: 'Generated' } })
    expect((await reader.next()).value).toMatchObject({ type: 'session/metadata', payload: { title: null } })
    expect(sink.snapshot).toMatchObject({ metadata: { title: null }, status: 'opening' })
  } finally { await reader.return?.(); await sink.dispose() }
})
