import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import type { HarnessProcess } from '@anureo/sdk/process'
import { readCodexSubagentHistory } from '../src/subagent-history'

function fixture(options: { parent?: string; unsupported?: boolean; nextCursor?: string } = {}) {
  const stdout = new PassThrough(), stderr = new PassThrough()
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  let disposed = 0, launched = 0
  const process: HarnessProcess = {
    pid: 1, owned: true, stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }),
    async write(chunk) {
      const message = JSON.parse(String(chunk)); calls.push(message)
      if (message.id === undefined) return
      const result = message.method === 'thread/read' ? { thread: { id: 'child', parentThreadId: options.parent ?? 'parent', agentNickname: 'Researcher', canAcceptDirectInput: false } }
        : message.method === 'thread/items/list' ? { data: [
          { turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'Result' } },
          { turnId: 'turn', item: { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Task' }] } },
        ], nextCursor: options.nextCursor } : {}
      stdout.write(JSON.stringify(message.method === 'thread/items/list' && options.unsupported
        ? { id: message.id, error: { code: -32601, message: 'unsupported' } }
        : { id: message.id, result }) + '\n')
    },
    async closeInput() {},
    async dispose() { disposed++; stdout.end(); stderr.end() },
  }
  return { options: { command: 'unused', processFactory: async () => { launched++; return process } }, calls, get disposed() { return disposed }, get launched() { return launched } }
}

test('subagent history verifies the spawn edge, reverses newest-first items and releases a read-only probe', async () => {
  const f = fixture({ nextCursor: 'older' })
  const result = await readCodexSubagentHistory(f.options, { parentThreadId: 'parent', threadId: 'child', limit: 2 })
  expect(result.history.items.map(entry => entry.item.id)).toEqual(['question', 'answer'])
  expect(result.metadata).toMatchObject({ name: 'Researcher', canAcceptDirectInput: false })
  expect(result.history.nextCursor).toBeTruthy()
  expect(f.calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'thread/read', 'thread/items/list'])
  expect(f.calls.at(-1)?.params).toMatchObject({ threadId: 'child', sortDirection: 'desc', limit: 2 })
  expect(f.disposed).toBe(1)
})

test('a different parent never reads content and always releases the connection', async () => {
  const f = fixture({ parent: 'other' })
  await expect(readCodexSubagentHistory(f.options, { parentThreadId: 'parent', threadId: 'child' })).rejects.toMatchObject({ code: 'SUBAGENT_RELATION_MISMATCH' })
  expect(f.calls.some(call => call.method === 'thread/items/list')).toBe(false)
  expect(f.disposed).toBe(1)
})

test('a cursor for a different child is rejected before launching any process', async () => {
  const f = fixture()
  const cursor = Buffer.from(JSON.stringify({ parent: 'parent', child: 'other', cursor: 'older' })).toString('base64url')
  await expect(readCodexSubagentHistory(f.options, { parentThreadId: 'parent', threadId: 'child', cursor })).rejects.toMatchObject({ code: 'CURSOR_INVALID' })
  expect(f.launched).toBe(0)
})

test('unsupported history never resumes a thread or retries another method', async () => {
  const f = fixture({ unsupported: true })
  await expect(readCodexSubagentHistory(f.options, { parentThreadId: 'parent', threadId: 'child' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.calls.every(call => ['initialize', 'initialized', 'thread/read', 'thread/items/list'].includes(call.method))).toBe(true)
  expect(f.disposed).toBe(1)
})
