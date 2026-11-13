// Checks diagnostics contracts; must not implement production policy.
import { expect, test } from 'bun:test'
import { configure, dispose, type LogRecord } from '@logtape/logtape'
import { catalogPhase, emitCatalogPhase, safeCatalogErrorCode, type CatalogProbeEvent } from './diagnostics'

test('diagnostics contain only safe codes and non-negative durations; callback errors are isolated', async () => {
  const events: CatalogProbeEvent[] = []
  await expect(catalogPhase({ onPhase: event => { events.push(event); throw new Error('observer') } }, 'handshake', async () => {
    throw Object.assign(new Error('https://provider.test/?token=private'), { code: 'PRIVATE_TOKEN' })
  })).rejects.toMatchObject({ code: 'PRIVATE_TOKEN' })
  expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0)
  expect(events[1]).toMatchObject({ phase: 'handshake', outcome: 'error', errorCode: 'CATALOG_QUERY_FAILED', durationMs: expect.any(Number) })
  expect(JSON.stringify(events)).not.toContain('private')
  expect(await catalogPhase({ onPhase: () => { throw new Error('observer') } }, 'models', async () => 42)).toBe(42)
})

test('started observers run before cancellation is checked and can prevent work', async () => {
  const controller = new AbortController()
  const events: CatalogProbeEvent[] = []
  let worked = false
  await expect(catalogPhase({ signal: controller.signal, onPhase: event => {
    events.push(event)
    if (event.outcome === 'started') controller.abort()
  } }, 'spawn', async () => { worked = true })).rejects.toMatchObject({ code: 'RPC_ABORTED' })
  expect(worked).toBe(false)
  expect(events).toEqual([
    { phase: 'spawn', outcome: 'started' },
    { phase: 'spawn', outcome: 'cancelled', errorCode: 'RPC_ABORTED', durationMs: expect.any(Number) },
  ])
})

test('cancellation waits for work settlement and discards a successful result', async () => {
  const controller = new AbortController()
  const order: string[] = []
  await expect(catalogPhase({ signal: controller.signal, onPhase: event => { order.push(event.outcome) } }, 'models', async () => {
    order.push('work')
    controller.abort()
    await Promise.resolve()
    order.push('settled')
    return 42
  })).rejects.toMatchObject({ code: 'RPC_ABORTED' })
  expect(order).toEqual(['started', 'work', 'settled', 'cancelled'])
})

test('cancellation reports preserve work failures and numeric RPC classifications', async () => {
  const controller = new AbortController()
  const events: CatalogProbeEvent[] = []
  const cause = Object.assign(new Error('private cause'), { code: 'NATIVE_RPC_ERROR', rpcCode: -32603 })
  await expect(catalogPhase({ signal: controller.signal, onPhase: event => { events.push(event) } }, 'handshake', async () => {
    controller.abort()
    throw cause
  })).rejects.toBe(cause)
  expect(events[1]).toEqual({
    phase: 'handshake', outcome: 'cancelled', errorCode: 'NATIVE_RPC_ERROR', nativeRpcCode: -32603, durationMs: expect.any(Number),
  })
  expect(JSON.stringify(events)).not.toContain('private')
})

test('safe codes prefer an existing code property and only fall back to Error messages', () => {
  expect(safeCatalogErrorCode(new Error('AUTH_REQUIRED'))).toBe('AUTH_REQUIRED')
  expect(safeCatalogErrorCode(Object.assign(new Error('AUTH_REQUIRED'), { code: undefined }))).toBe('CATALOG_QUERY_FAILED')
  expect(safeCatalogErrorCode({ code: 'AUTH_FORBIDDEN' })).toBe('AUTH_FORBIDDEN')
  expect(safeCatalogErrorCode('AUTH_REQUIRED')).toBe('CATALOG_QUERY_FAILED')
  expect(safeCatalogErrorCode(new Error('private cause'))).toBe('CATALOG_QUERY_FAILED')
})

test('diagnostic property failures replace the work rejection before terminal reporting', async () => {
  const events: CatalogProbeEvent[] = []
  const propertyFailure = new Error('getter failure')
  const cause = { get code() { throw propertyFailure } }
  await expect(catalogPhase({ onPhase: event => { events.push(event) } }, 'models', async () => { throw cause })).rejects.toBe(propertyFailure)
  expect(events).toEqual([{ phase: 'models', outcome: 'started' }])
})

test('catalog phases are logged to LogTape without leaking private causes', async () => {
  const records: LogRecord[] = []
  await configure({ sinks: { memory: record => { records.push(record) } }, loggers: [
    { category: ['anureo'], lowestLevel: 'debug', sinks: ['memory'] },
    { category: ['logtape', 'meta'], lowestLevel: 'warning' },
  ] })
  try {
    await expect(catalogPhase({}, 'handshake', async () => {
      throw Object.assign(new Error('https://provider.test/?token=private'), { code: 'PRIVATE_TOKEN' })
    })).rejects.toMatchObject({ code: 'PRIVATE_TOKEN' })
    await catalogPhase({}, 'dispose', async () => undefined)
  } finally {
    await dispose()
  }
  const relevant = records.filter(record => record.category[0] === 'anureo')
  expect(relevant.map(record => record.level)).toEqual(['debug', 'error', 'debug', 'debug'])
  expect(relevant[0]).toMatchObject({ category: ['anureo', 'catalog'], properties: { phase: 'handshake', outcome: 'started' } })
  expect(relevant[1]).toMatchObject({ properties: { phase: 'handshake', outcome: 'error', errorCode: 'CATALOG_QUERY_FAILED' } })
  expect(relevant[3]).toMatchObject({ properties: { phase: 'dispose', outcome: 'success' } })
  expect(JSON.stringify(records)).not.toContain('private')
})

test('logger failures leave observers and work outcomes intact; logs precede callbacks', async () => {
  const records: LogRecord[] = []
  const events: CatalogProbeEvent[] = []
  const recordCountsAtCallback: number[] = []
  await configure({ reset: true, sinks: { failing: record => { records.push(record); throw new Error('sink failure') } }, loggers: [
    { category: ['anureo'], lowestLevel: 'debug', sinks: ['failing'] },
    { category: ['logtape', 'meta'], lowestLevel: 'warning' },
  ] })
  try {
    const options = { onPhase: (event: CatalogProbeEvent) => {
      events.push(event)
      recordCountsAtCallback.push(records.length)
    } }
    const event: CatalogProbeEvent = { phase: 'dispose', outcome: 'cancelled', durationMs: 12.6 }
    emitCatalogPhase(options, event)
    expect(events[0]).toBe(event)
    expect(records[0]).toMatchObject({ level: 'warning', properties: { durationMs: 13 } })
    expect(event.durationMs).toBe(12.6)
    expect(await catalogPhase(options, 'models', async () => 42)).toBe(42)
    const cause = new Error('AUTH_REQUIRED')
    await expect(catalogPhase(options, 'handshake', async () => { throw cause })).rejects.toBe(cause)
    expect(recordCountsAtCallback).toEqual([1, 2, 3, 4, 5])
    expect(events.map(event => event.outcome)).toEqual(['cancelled', 'started', 'success', 'started', 'error'])
  } finally {
    await dispose()
  }
})
