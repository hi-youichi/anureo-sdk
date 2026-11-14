/** Verifies JSONL framing, ordering and cleanup with controlled in-memory process streams. */
import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { CodexJsonlClient, CodexRpcError } from '../src/jsonl'
import type { JsonlHandlers, JsonlOptions } from '../src/jsonl'
import type { HarnessProcess } from '@anureo/sdk/process'

/** Build an in-memory client with optional handler overrides and captured effects. Tests drive stdout and must dispose the client; waitForWrite observes the first captured write, which can precede handler completion. */
function fixture({
  options = {},
  request = async (_request, reply) => { await reply({ accepted: true }) },
  notification = async () => {},
}: {
  options?: JsonlOptions;
  request?: JsonlHandlers['request'];
  notification?: JsonlHandlers['notification'];
} = {}) {
  const stdout = new PassThrough(), stderr = new PassThrough()
  const writes: string[] = [], diagnostics: string[] = [], failures: unknown[] = []
  const firstWrite = Promise.withResolvers<void>()
  const process: HarnessProcess = {
    pid: 1,
    owned: true,
    stdout,
    stderr,
    exited: new Promise(() => {}),
    /** Capture a queued frame and release the first-write waiter; resolves without external process I/O. */
    async write(chunk) {
      writes.push(String(chunk))
      firstWrite.resolve()
    },
    async closeInput() {},
    /** End both fixture streams so client cleanup releases readers; does not simulate native execution completion. */
    async dispose() { stdout.end(); stderr.end() },
  }
  const client = new CodexJsonlClient(process, {
    notification,
    request,
    /** Retain safe failure objects for identity assertions; process cleanup remains the test's responsibility. */
    failure: async cause => { failures.push(cause) },
    diagnostic: code => diagnostics.push(code),
  }, options)
  return { client, stdout, stderr, writes, diagnostics, failures, waitForWrite: () => firstWrite.promise }
}
describe('native JSONL transport', () => {
  /** A process can exit with buffered response bytes, including a split multibyte character; EOF must not overtake them. */
  test('correlates integer responses and drains split UTF8 and final response before EOF', async () => {
    const f = fixture(); const request = f.client.request('test')
    await f.waitForWrite(); const id = JSON.parse(f.writes[0]!).id
    const bytes = Buffer.from(JSON.stringify({ id, result: { text: '日本語' } }) + '\n')
    f.stdout.write(bytes.subarray(0, bytes.length - 6)); f.stdout.end(bytes.subarray(bytes.length - 6))
    expect(await request).toEqual({ text: '日本語' }); await f.client.finished; await f.client.dispose()
  })
  /** Native IDs must survive round trips while stderr secrets stay outside the diagnostic surface. */
  test('preserves string server request id and never exposes raw stderr', async () => {
    const f = fixture(); f.stderr.write('Bearer PRIVATE_AUTH https://auth.test/?token=secret')
    f.stdout.write(JSON.stringify({ id: 'native-string', method: 'permission', params: {} }) + '\n')
    await f.waitForWrite()
    expect(JSON.parse(f.writes[0]!)).toEqual({ id: 'native-string', result: { accepted: true } })
    expect(f.diagnostics).toEqual(['CODEX_STDERR']); expect(JSON.stringify(f.diagnostics)).not.toContain('PRIVATE_AUTH'); await f.client.dispose()
  })
  /** A deadline cannot prove a mutation failed, so transport recovery must never replay it. */
  test('timeouts report unknown and do not replay the request', async () => {
    const f = fixture({ options: { timeoutMs: 5 } }); await expect(f.client.request('mutation', { secret: 'private' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: true })
    expect(f.writes).toHaveLength(1); await f.client.dispose()
  })
  /** Framing failures must identify the transport problem without echoing arbitrary native content. */
  test('oversized or malformed frames fail the source, not raw data', async () => {
    const f = fixture({ options: { maxFrameBytes: 64 } }); f.stdout.write('x'.repeat(65)); await f.client.finished
    expect(f.failures[0]).toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(JSON.stringify(f.failures)).not.toContain('xxxxx'); await f.client.dispose()
    const g = fixture(); g.stdout.write('PRIVATE_NOT_JSON\n'); await g.client.finished
    expect(g.failures[0]).toMatchObject({ code: 'PROTOCOL_ERROR' }); expect(JSON.stringify(g.failures)).not.toContain('PRIVATE_NOT_JSON'); await g.client.dispose()
  })
  /** Admission must fail immediately at capacity, and explicit cleanup must preserve uncertain outcomes. */
  test('pending requests are bounded and disposed waiters resolve explicitly', async () => {
    const f = fixture({ options: { maxPending: 1 } }); const first = f.client.request('first'); const observed = first.catch(cause => cause)
    await expect(f.client.request('second')).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' }); await f.client.dispose()
    expect(await observed).toMatchObject({ code: 'RUNTIME_DISPOSED', outcomeUnknown: true })
  })
  /** A definite native rejection frees admission and its duplicate cannot settle a later request; error payloads must stay private even when result is also present. */
  test('settles native rejection once and releases capacity for the next response', async () => {
    const f = fixture({ options: { maxPending: 1 } })
    try {
      const first = f.client.request('optional').catch(cause => cause)
      await f.waitForWrite()
      const firstId = JSON.parse(f.writes[0]!).id
      f.stdout.write(JSON.stringify({ id: firstId, error: { code: -32601, message: 'PRIVATE_NATIVE_ERROR' }, result: 'ignored' }) + '\n')
      const cause = await first
      expect(cause).toBeInstanceOf(CodexRpcError)
      expect(cause).toMatchObject({ code: 'METHOD_NOT_FOUND', rpcCode: -32601, outcomeUnknown: false })
      expect(JSON.stringify(cause)).not.toContain('PRIVATE_NATIVE_ERROR')

      const second = f.client.request('next')
      // Await a later write to inspect the second RPC without relying on microtask timing.
      await f.client.notify('barrier')
      const secondId = JSON.parse(f.writes[1]!).id
      expect(secondId).not.toBe(firstId)
      f.stdout.write([
        { id: firstId, result: 'duplicate' },
        { id: secondId, result: null },
      ].map(frame => JSON.stringify(frame) + '\n').join(''))
      expect(await second).toBeNull()
      expect(f.failures).toEqual([])
    } finally { await f.client.dispose() }
  })
  /** A broken write has an uncertain native outcome but does not itself claim stdout has closed. */
  test('a failed write fails the caller with an unknown outcome while the stream stays open', async () => {
    const f = fixture()
    ;(f.client.process as { write: (chunk: string) => Promise<void> }).write = () => Promise.reject(new Error('pipe closed'))
    await expect(f.client.request('doomed')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED', outcomeUnknown: true })
    await expect(f.client.notify('also-doomed')).rejects.toThrow('pipe closed')
    await f.client.dispose()
  })
  /** An intentional handler rejection is a native error response, distinct from transport failure. */
  test('server request rejections answer with a native RPC error reply', async () => {
    const f = fixture({ request: async (_request, _reply, reject) => { await reject(-32603, 'denied') } })
    f.stdout.write(JSON.stringify({ id: 'native-1', method: 'permission', params: {} }) + '\n')
    await f.waitForWrite()
    expect(JSON.parse(f.writes[0]!)).toEqual({ id: 'native-1', error: { code: -32603, message: 'denied' } })
    await f.client.dispose()
    expect(f.stdout.writableEnded).toBe(true)
    expect(f.stderr.writableEnded).toBe(true)
  })
  /** Handler exceptions need a safe fallback so native callers are not left waiting for an answer. */
  test('a rejected native handler replies with an interaction-unavailable error', async () => {
    const f = fixture({ request: async () => { throw new Error('handler crashed') } })
    f.stdout.write(JSON.stringify({ id: 'native-2', method: 'permission', params: {} }) + '\n')
    await f.waitForWrite()
    expect(JSON.parse(f.writes[0]!)).toEqual({ id: 'native-2', error: { code: -32603, message: 'Interaction unavailable' } })
    await f.client.dispose()
    expect(f.stdout.writableEnded).toBe(true)
    expect(f.stderr.writableEnded).toBe(true)
  })

  /** A synchronous throw reaches the reader's failure path before the handler returns a promise. */
  test('a synchronous native handler throw fails the reader without replying', async () => {
    const f = fixture({ request: () => { throw new Error('private handler failure') } })
    try {
      f.stdout.write(JSON.stringify({ id: 'native-sync', method: 'permission' }) + '\n')
      await f.client.finished
      expect(f.writes).toEqual([])
      expect(f.failures).toHaveLength(1)
      expect(f.failures[0]).toMatchObject({ code: 'PROTOCOL_ERROR', message: 'Invalid Codex stream', outcomeUnknown: true })
    } finally { await f.client.dispose() }
  })

  /** Notifications form a wire-order barrier, while a user interaction must leave stdout free to deliver other notifications and RPC results. */
  test('awaits notifications in order while server requests run concurrently', async () => {
    const notificationStarted = Promise.withResolvers<void>(), releaseNotification = Promise.withResolvers<void>()
    const releaseInteraction = Promise.withResolvers<void>(), interactionAnswered = Promise.withResolvers<void>()
    const events: string[] = []
    const f = fixture({
      /** Hold the first notification so assertions can inspect the stream before the barrier opens. */
      notification: async method => {
        events.push(method)
        if (method === 'first') {
          notificationStarted.resolve()
          await releaseNotification.promise
          events.push('first finished')
        }
      },
      /** Keep the interaction unresolved until a later RPC result proves stdout still drains. */
      request: async (_request, reply) => {
        events.push('interaction')
        await releaseInteraction.promise
        await reply({ accepted: true })
        interactionAnswered.resolve()
      },
    })
    try {
      const result = f.client.request('query')
      await f.waitForWrite()
      const id = JSON.parse(f.writes[0]!).id
      f.stdout.write([
        { method: 'first' },
        { id: 'interaction', method: 'permission' },
        { method: 'second' },
        { id, result: 'ready' },
      ].map(frame => JSON.stringify(frame) + '\n').join(''))
      await notificationStarted.promise
      expect(events).toEqual(['first'])
      releaseNotification.resolve()
      expect(await result).toBe('ready')
      expect(events).toEqual(['first', 'first finished', 'interaction', 'second'])
      expect(f.writes).toHaveLength(1)
      releaseInteraction.resolve()
      await interactionAnswered.promise
      expect(JSON.parse(f.writes[1]!)).toEqual({ id: 'interaction', result: { accepted: true } })
    } finally {
      releaseNotification.resolve()
      releaseInteraction.resolve()
      await f.client.dispose()
    }
  })

  for (const outcome of ['written', 'failed'] as const) {
    /** Ownership is claimed before I/O; neither duplicate callbacks nor handler fallback may retry a possibly delivered response. */
    test(`retains single-response ownership after a ${outcome} reply`, async () => {
      const handled = Promise.withResolvers<void>()
      const attempts: unknown[] = []
      let replyFailure: unknown, duplicateFailure: unknown
      const f = fixture({
        /** Exercise all response paths against the same claimed interaction, then force the outer fallback. */
        request: async (_request, reply, reject) => {
          try { await reply('accepted') } catch (cause) { replyFailure = cause }
          try { await reply('duplicate') } catch (cause) { duplicateFailure = cause }
          await reject(-32603, 'late rejection')
          handled.resolve()
          throw new Error('handler failed after claiming response')
        },
      })
      const write = f.client.process.write.bind(f.client.process)
      /** Record attempted I/O even when it fails, because completed writes alone would hide fallback retries. */
      f.client.process.write = async chunk => {
        attempts.push(JSON.parse(String(chunk)))
        if (outcome === 'failed') throw new Error('pipe closed')
        await write(chunk)
      }
      try {
        f.stdout.write(JSON.stringify({ id: 'owned', method: 'permission' }) + '\n')
        await handled.promise
        // A turn of the event loop lets the handler's fallback/finally chain settle.
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(duplicateFailure).toMatchObject({ code: 'INTERACTION_ALREADY_RESOLVED' })
        if (outcome === 'failed') expect(replyFailure).toBeInstanceOf(Error)
        else expect(replyFailure).toBeUndefined()
        expect(attempts).toEqual([{ id: 'owned', result: 'accepted' }])
        expect(f.failures).toEqual([])
      } finally { await f.client.dispose() }
    })
  }

  /** Reply completion cannot free capacity while the handler still owns work; otherwise slow handlers evade the concurrency bound. */
  test('holds server capacity until the entire handler completes', async () => {
    const replied = Promise.withResolvers<void>(), releaseHandler = Promise.withResolvers<void>()
    const handled: (number | string)[] = []
    const f = fixture({
      options: { maxServerRequests: 1 },
      /** Answer immediately but keep the handler alive to distinguish reply ownership from slot ownership. */
      request: async (request, reply) => {
        handled.push(request.id)
        await reply('accepted')
        replied.resolve()
        await releaseHandler.promise
      },
    })
    try {
      f.stdout.write(JSON.stringify({ id: 'first', method: 'permission' }) + '\n')
      await replied.promise
      f.stdout.write(JSON.stringify({ id: 'second', method: 'permission' }) + '\n')
      await f.client.finished
      expect(handled).toEqual(['first'])
      expect(f.failures[0]).toMatchObject({ code: 'BACKPRESSURE_EXCEEDED', outcomeUnknown: true })
      expect(f.writes).toHaveLength(1)
    } finally {
      releaseHandler.resolve()
      await f.client.dispose()
    }
  })

  /** Disposal forbids new writes but must not cancel admitted writes; a failed predecessor must also leave the queue usable. */
  test('preserves queued writes across write failure and shared disposal', async () => {
    const started = Promise.withResolvers<void>(), releaseWrite = Promise.withResolvers<void>()
    const f = fixture()
    const attempts: string[] = []
    let disposals = 0
    const write = f.client.process.write.bind(f.client.process)
    const dispose = f.client.process.dispose.bind(f.client.process)
    /** Block and fail the first write so the second is still queued when disposal begins. */
    f.client.process.write = async chunk => {
      const method = JSON.parse(String(chunk)).method
      attempts.push(method)
      if (method === 'first') {
        started.resolve()
        await releaseWrite.promise
        throw new Error('pipe closed')
      }
      await write(chunk)
    }
    /** Count actual resource cleanup, rather than merely repeated client dispose calls. */
    f.client.process.dispose = async () => { disposals++; await dispose() }
    const first = f.client.notify('first').catch(cause => cause)
    const second = f.client.notify('second')
    try {
      await started.promise
      expect(attempts).toEqual(['first'])
      const disposing = f.client.dispose()
      expect(f.client.dispose()).toBe(disposing)
      await disposing
      expect(disposals).toBe(1)
      await expect(f.client.notify('late')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
      releaseWrite.resolve()
      expect(await first).toBeInstanceOf(Error)
      await second
      expect(attempts).toEqual(['first', 'second'])
      expect(f.writes.map(frame => JSON.parse(frame).method)).toEqual(['second'])
      expect(f.failures).toEqual([])
    } finally {
      releaseWrite.resolve()
      await Promise.allSettled([first, second])
      await f.client.dispose()
    }
  })

  for (const closure of ['failure', 'disposal'] as const) {
    /** Bulk cleanup must preserve cause identity: one shared stream failure versus one disposal error for each waiter. */
    test(`rejects all pending requests with the existing ${closure} causes`, async () => {
      const f = fixture()
      const first = f.client.request('first').catch(cause => cause)
      const second = f.client.request('second').catch(cause => cause)
      try {
        if (closure === 'failure') {
          f.stdout.write('invalid JSON\n')
          await f.client.finished
        } else await f.client.dispose()
        const [firstCause, secondCause] = await Promise.all([first, second])
        if (closure === 'failure') {
          expect(firstCause).toBe(f.failures[0])
          expect(secondCause).toBe(firstCause)
          expect(firstCause).toMatchObject({ code: 'PROTOCOL_ERROR', outcomeUnknown: true })
        } else {
          expect(firstCause).not.toBe(secondCause)
          for (const cause of [firstCause, secondCause]) {
            expect(cause).toMatchObject({ code: 'RUNTIME_DISPOSED', outcomeUnknown: true })
          }
          expect(f.failures).toEqual([])
        }
        await expect(f.client.request('late')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
      } finally { await f.client.dispose() }
    })
  }

  for (const framing of ['complete', 'unfinished'] as const) {
    /** Counting characters would admit oversized multibyte payloads in either branch of the read loop. */
    test(`bounds UTF-8 bytes in ${framing} incoming frames`, async () => {
      const f = fixture({ options: { maxFrameBytes: 64 } })
      try {
        const frame = JSON.stringify({ method: 'note', params: { text: '日'.repeat(12) } })
        expect(frame.length).toBeLessThanOrEqual(64)
        expect(Buffer.byteLength(frame)).toBeGreaterThan(64)
        f.stdout.write(frame + (framing === 'complete' ? '\n' : ''))
        await f.client.finished
        expect(f.failures[0]).toMatchObject({ code: 'FRAME_TOO_LARGE', outcomeUnknown: true })
      } finally { await f.client.dispose() }
    })
  }
})
