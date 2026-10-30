import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { CodexJsonlClient } from '../src/jsonl'
import type { HarnessProcess } from '@anureo/sdk/process'
function fixture(options: { maxFrameBytes?: number; timeoutMs?: number; maxPending?: number } = {}) {
  const stdout = new PassThrough(), stderr = new PassThrough()
  const writes: string[] = [], diagnostics: string[] = [], failures: unknown[] = []
  const process: HarnessProcess = { pid: 1, owned: true, stdout, stderr, exited: new Promise(() => {}), async write(chunk) { writes.push(String(chunk)) }, async closeInput() {}, async dispose() { stdout.end(); stderr.end() } }
  const client = new CodexJsonlClient(process, { notification: async () => {}, request: async (_request, reply) => { await reply({ accepted: true }) }, failure: async cause => { failures.push(cause) }, diagnostic: code => diagnostics.push(code) }, options)
  return { client, stdout, stderr, writes, diagnostics, failures }
}
describe('native JSONL transport', () => {
  test('correlates integer responses and drains split UTF8 and final response before EOF', async () => {
    const f = fixture(); const request = f.client.request('test')
    await new Promise(resolve => setTimeout(resolve, 0)); const id = JSON.parse(f.writes[0]!).id
    const bytes = Buffer.from(JSON.stringify({ id, result: { text: '日本語' } }) + '\n')
    f.stdout.write(bytes.subarray(0, bytes.length - 6)); f.stdout.end(bytes.subarray(bytes.length - 6))
    expect(await request).toEqual({ text: '日本語' }); await f.client.finished; await f.client.dispose()
  })
  test('preserves string server request id and never exposes raw stderr', async () => {
    const f = fixture(); f.stderr.write('Bearer PRIVATE_AUTH https://auth.test/?token=secret')
    f.stdout.write(JSON.stringify({ id: 'native-string', method: 'permission', params: {} }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(JSON.parse(f.writes[0]!)).toEqual({ id: 'native-string', result: { accepted: true } })
    expect(f.diagnostics).toEqual(['CODEX_STDERR']); expect(JSON.stringify(f.diagnostics)).not.toContain('PRIVATE_AUTH'); await f.client.dispose()
  })
  test('timeouts report unknown and do not replay the request', async () => {
    const f = fixture({ timeoutMs: 5 }); await expect(f.client.request('mutation', { secret: 'private' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: true })
    expect(f.writes).toHaveLength(1); await f.client.dispose()
  })
  test('oversized or malformed frames fail the source, not raw data', async () => {
    const f = fixture({ maxFrameBytes: 64 }); f.stdout.write('x'.repeat(65)); await f.client.finished
    expect(f.failures[0]).toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(JSON.stringify(f.failures)).not.toContain('xxxxx'); await f.client.dispose()
    const g = fixture(); g.stdout.write('PRIVATE_NOT_JSON\n'); await g.client.finished
    expect(g.failures[0]).toMatchObject({ code: 'PROTOCOL_ERROR' }); expect(JSON.stringify(g.failures)).not.toContain('PRIVATE_NOT_JSON'); await g.client.dispose()
  })
  test('pending requests are bounded and disposed waiters resolve explicitly', async () => {
    const f = fixture({ maxPending: 1 }); const first = f.client.request('first'); const observed = first.catch(cause => cause)
    await expect(f.client.request('second')).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' }); await f.client.dispose()
    expect(await observed).toMatchObject({ code: 'RUNTIME_DISPOSED', outcomeUnknown: true })
  })
  test('a failed write fails the caller with an unknown outcome while the stream stays open', async () => {
    const f = fixture()
    ;(f.client.process as { write: (chunk: string) => Promise<void> }).write = () => Promise.reject(new Error('pipe closed'))
    await expect(f.client.request('doomed')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED', outcomeUnknown: true })
    await expect(f.client.notify('also-doomed')).rejects.toThrow('pipe closed')
    await f.client.dispose()
  })
  test('server request rejections answer with a native RPC error reply', async () => {
    const stdout = new PassThrough(), stderr = new PassThrough()
    const writes: string[] = []
    const process: HarnessProcess = { pid: 1, owned: true, stdout, stderr, exited: new Promise(() => {}), async write(chunk) { writes.push(String(chunk)) }, async closeInput() {}, async dispose() { stdout.end(); stderr.end() } }
    const client = new CodexJsonlClient(process, {
      notification: async () => {},
      request: async (_request, _reply, reject) => { await reject(-32603, 'denied') },
      failure: async () => {},
      diagnostic: () => {},
    })
    stdout.write(JSON.stringify({ id: 'native-1', method: 'permission', params: {} }) + '\n')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(JSON.parse(writes[0]!)).toEqual({ id: 'native-1', error: { code: -32603, message: 'denied' } })
    await client.dispose()
  })
  test('a throwing native handler replies with an interaction-unavailable error', async () => {
    const stdout = new PassThrough(), stderr = new PassThrough()
    const writes: string[] = []
    const process: HarnessProcess = { pid: 1, owned: true, stdout, stderr, exited: new Promise(() => {}), async write(chunk) { writes.push(String(chunk)) }, async closeInput() {}, async dispose() { stdout.end(); stderr.end() } }
    const client = new CodexJsonlClient(process, {
      notification: async () => {},
      request: async () => { throw new Error('handler crashed') },
      failure: async () => {},
      diagnostic: () => {},
    })
    stdout.write(JSON.stringify({ id: 'native-2', method: 'permission', params: {} }) + '\n')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(JSON.parse(writes[0]!)).toEqual({ id: 'native-2', error: { code: -32603, message: 'Interaction unavailable' } })
    await client.dispose()
  })
})
