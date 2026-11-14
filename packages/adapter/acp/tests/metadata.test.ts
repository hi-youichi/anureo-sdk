import { expect, test } from 'bun:test'
import { createClient } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import { AcpUpdateMapper, mcp } from '../src/mapping'
import type { SessionState } from '@anureo/protocol'
import type { SessionEventSink } from '@anureo/sdk'

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

test('mapper reset leaves the session title available for later metadata updates', async () => {
  const binding = { sessionId: 's', adapterId: 'acp', runtimeConfigId: 'r' }
  const client=await createClient({adapter:createScriptedAdapter(),identity:binding})
  const sink=await client.openSession({requestId:'open',mode:'new',binding,cwd:process.cwd()})
  const state: SessionState = { binding, capabilities: {}, capabilityRevision: 1, status: 'ready', activeTurnIds: [], config: {} }
  const getActiveTurnId = () => 'turn-1'
  const getSessionState = () => state
  const applySessionMetadata = (data: Record<string, unknown>) => {
    state.metadata = { title: data.sessionTitle as string | null }
  }
  const mapper = new AcpUpdateMapper(
    sink,
    getActiveTurnId,
    getSessionState,
    applySessionMetadata,
    false,
  )
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'Before' })
  mapper.reset()
  expect(state.metadata?.title).toBe('Before')
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'After' })
  expect(state.metadata?.title).toBe('After')
  await client.dispose()
})

test('ACP idle metadata patches preserve absent titles and explicitly clear, without lifecycle events', async () => {
  const binding = { sessionId: 's', adapterId: 'acp', runtimeConfigId: 'r' }
  const client=await createClient({adapter:createScriptedAdapter(),identity:binding})
  const sink=await client.openSession({requestId:'open',mode:'new',binding,cwd:process.cwd()})
  const state: SessionState = { binding, capabilities: {}, capabilityRevision: 1, status: 'ready', activeTurnIds: [], config: {} }
  const getActiveTurnId = () => undefined
  const getSessionState = () => state
  const applySessionMetadata = (data: Record<string, unknown>) => {
    state.metadata = { title: data.sessionTitle as string | null }
  }
  const mapper = new AcpUpdateMapper(
    sink,
    getActiveTurnId,
    getSessionState,
    applySessionMetadata,
    false,
  )
  const reader = sink.events()[Symbol.asyncIterator]()
  // An initial patch without a title emits no metadata event.
  await mapper.update({ sessionUpdate: 'session_info_update', updatedAt: 'now' })

  // Setting the title emits once; repeating it emits no duplicate event.
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'Generated' })
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'Generated' })

  // Missing and invalid titles preserve the existing value.
  await mapper.update({ sessionUpdate: 'session_info_update', updatedAt: 'later' })
  await mapper.update({ sessionUpdate: 'session_info_update', title: 42 })
  expect(state.metadata?.title).toBe('Generated')

  // An explicit null clears the title and emits a metadata event.
  await mapper.update({ sessionUpdate: 'session_info_update', title: null })
  try {
    expect((await reader.next()).value).toMatchObject({ type: 'session/metadata', payload: { title: 'Generated' } })
    expect((await reader.next()).value).toMatchObject({ type: 'session/metadata', payload: { title: null } })
    expect(sink.snapshot).toMatchObject({ metadata: { title: null }, status: 'ready' })
  } finally { await reader.return?.(); await client.dispose() }
})

test('metadata publication failure rejects after applying the title patch', async () => {
  const failure = new Error('publication failed')
  const state = { metadata: { title: 'Before' } } as SessionState
  let publications = 0
  const sink = {
    emit: async () => {
      publications++
      expect(state.metadata?.title).toBe('After')
      throw failure
    },
  } as unknown as SessionEventSink
  const mapper = new AcpUpdateMapper(
    sink,
    () => undefined,
    () => state,
    data => { state.metadata = { title: data.sessionTitle as string | null } },
    false,
  )
  await expect(mapper.update({ sessionUpdate: 'session_info_update', title: 'After' })).rejects.toBe(failure)
  expect(state.metadata?.title).toBe('After')
  // Publication failure does not roll back the native state or make equal titles emit again.
  await mapper.update({ sessionUpdate: 'session_info_update', title: 'After' })
  expect(publications).toBe(1)
})
