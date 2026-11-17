import { expect, test } from 'bun:test'
import { createClient, HarnessSdkError, type HarnessAdapter, type SessionMethod } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, type AhpRequestMap, type AhpResultMap, type Capabilities, type SessionOpenParams } from '@anureo/protocol'
import { createSwarmAdapter } from '../src'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const cwd = process.cwd()

async function management(params: SessionOpenParams) {
  const config = params.mcpServers?.find(server => server.name === 'anureo-swarm')
  if (!config || config.type !== 'http') throw new Error('Missing management server')
  const client = new McpClient({ name: 'test-main', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }))
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as { type: string; text?: string }[]
      const text = content.find(block => block.type === 'text')?.text ?? ''
      if (result.isError) throw new Error(text)
      return JSON.parse(text)
    },
  }
}

async function fixture(respond: (input: string, params: SessionOpenParams) => string | Promise<string>) {
  const capabilities: Capabilities = {
    input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
    turn: { inputModalities: ['text'], outputSchema: true },
  }
  let nextTurn = 0
  const adapter: HarnessAdapter = {
    async initialize() {
      return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'backend', version: '1', adapter: 'backend' }, capabilities }
    },
    async openSession(params, sink) {
      return {
        binding: { ...params.binding, nativeRef: { provider: 'backend', value: `native-${params.binding.sessionId}` } }, capabilities,
        async execute<M extends SessionMethod>(method: M, request: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
          if (method === 'session/close') return { closed: true, observationClosed: true, executionStopped: 'confirmed' } as AhpResultMap[M]
          if (method !== 'input/submit') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
          const { input, submissionId } = request as AhpRequestMap['input/submit']
          const prompt = input.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
          const answer = await respond(prompt, params)
          const turnId = `backend-turn-${++nextTurn}`
          const scope = { turnId }
          await sink.emit({ type: 'turn/started', payload: { ...scope, nativeTurnId: `native-${turnId}` } }, { turnId })
          await sink.bindSubmission(submissionId, turnId)
          const item = { id: 'reused-message-id', type: 'agentMessage' as const, phase: 'final' as const }
          await sink.emit({ type: 'item/started', payload: { item: { ...item, text: '' } } }, scope)
          await sink.emit({ type: 'item/completed', payload: { item: { ...item, text: answer } } }, scope)
          await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } }, { turnId })
          return { submissionId, disposition: 'dispatched' } as AhpResultMap[M]
        },
        async dispose() {},
      }
    },
    async dispose() {},
  }
  return createClient({ adapter, identity: { adapterId: 'backend', runtimeConfigId: 'test' } })
}

test('strict-shape tools advertise their shapes and reject mixed arguments with a self-correcting message', async () => {
  const backend = await fixture(async (_input, params) => {
    if (!params.mcpServers?.length) return 'hold'
    const mcp = await management(params)
    try {
      // The advertised schema itself spells out both bee_wait shapes.
      const tools = await mcp.client.listTools()
      const wait = tools.tools.find(tool => tool.name === 'bee_wait')!
      expect(wait.description).toContain('{"taskId":"<id>"}')
      expect(wait.description).toContain('{"taskIds"')
      const oneOf = (wait.inputSchema as { oneOf?: { description?: string }[] }).oneOf!
      expect(oneOf).toHaveLength(2)
      expect(oneOf.every(branch => typeof branch.description === 'string' && branch.description.length > 0))

      // Mixed and mode-less batch shapes fail with the documented remediation.
      await expect(mcp.call('bee_wait', {})).rejects.toThrow('never combine taskId with taskIds or mode')
      await expect(mcp.call('bee_wait', { taskId: 'missing', mode: 'all' })).rejects.toThrow('never combine taskId with taskIds or mode')
      await expect(mcp.call('bee_wait', { taskIds: ['missing'] })).rejects.toThrow('never combine taskId with taskIds or mode')
      await expect(mcp.call('bee_wait', { taskId: 'missing', taskIds: ['missing'] })).rejects.toThrow('never combine taskId with taskIds or mode')
      await expect(mcp.call('bee_wait', ['x'] as unknown as Record<string, unknown>)).rejects.toThrow('must be a JSON object')

      // bee_create mixed profile shapes keep SWARM_INVALID_PROFILE, other mismatches get their own hint.
      await expect(mcp.call('bee_create', { profileId: 'tester', role: 'other', name: 'Other' })).rejects.toThrow('SWARM_INVALID_PROFILE')
      await expect(mcp.call('bee_create', { profileId: 'tester', selectionReason: 'why' })).rejects.toThrow('profileId excludes role, name, model, effort and selectionReason')

      // A schema-valid single-task wait passes argument validation and reaches task accounting.
      await expect(mcp.call('bee_wait', { taskId: 'missing' })).rejects.toThrow('SWARM_UNKNOWN_TASK')
      return 'Done'
    } finally { await mcp.client.close() }
  })
  try {
    const session = await backend.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Investigate' })).result()).status).toBe('completed')
    await session.close()
  } finally { await backend.dispose() }
})
