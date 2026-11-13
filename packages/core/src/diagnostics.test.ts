// Checks diagnostics contracts; must not implement production policy.
import { expect, test } from 'bun:test'
import { configure, dispose, type LogRecord } from '@logtape/logtape'
import { catalogPhase, type CatalogProbeEvent } from './diagnostics'

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
