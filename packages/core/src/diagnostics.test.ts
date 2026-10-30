import { expect, test } from 'bun:test'
import { catalogPhase, type CatalogProbeEvent } from './diagnostics'

test('diagnostics contain only safe codes and monotonic durations; callback errors are isolated', async () => {
  const events: CatalogProbeEvent[] = []
  await expect(catalogPhase({ onPhase: event => { events.push(event); throw new Error('observer') } }, 'handshake', async () => {
    throw Object.assign(new Error('https://provider.test/?token=private'), { code: 'PRIVATE_TOKEN' })
  })).rejects.toMatchObject({ code: 'PRIVATE_TOKEN' })
  expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0)
  expect(events[1]).toMatchObject({ phase: 'handshake', outcome: 'error', errorCode: 'CATALOG_QUERY_FAILED', durationMs: expect.any(Number) })
  expect(JSON.stringify(events)).not.toContain('private')
  expect(await catalogPhase({ onPhase: () => { throw new Error('observer') } }, 'models', async () => 42)).toBe(42)
})
