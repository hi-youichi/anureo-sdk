/** Optional live-binary coverage for the Codex subagent transport; it must never run without explicit
 * opt-in (`ANUREO_CODEX_SUBAGENT_E2E=1`) and a real logged-in Codex binary. Spawn-driven nested items
 * depend on model decisions, so deterministic coverage lives in the unit suites (mapping/adapter);
 * these tests pin the production transport against the real app-server. */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '../src'

const enabled = process.env.ANUREO_CODEX_SUBAGENT_E2E === '1'

describe.skipIf(!enabled)('live Codex binary subagent surface', () => {
  /** Relation-filtered thread discovery must round-trip against the real app-server, and a
   * nonexistent parent must yield an empty page rather than an error. */
  test('thread discovery pages real threads with relation filters', async () => {
    const adapter = createCodexAdapter({ command: 'codex', args: ['app-server'], cwd: mkdtempSync(join(tmpdir(), 'anureo-e2e-')) })
    try {
      await adapter.initialize({ protocolVersions: [1], clientInfo: { name: 'anureo-e2e', version: '0.1.0' } })
      const page = await adapter.listThreads({ limit: 10 })
      expect(Array.isArray(page.data)).toBe(true)
      for (const thread of page.data) {
        expect(thread.id).toBeTruthy()
        expect(typeof thread.status).toBe('string')
      }
      const children = await adapter.listThreads({ limit: 10, parentThreadId: 'anureo-e2e-nonexistent-parent' })
      expect(children.data).toEqual([])
    } finally {
      await adapter.dispose()
    }
  }, 30_000)

  /** A request/response round over the production transport must settle well within its timeout even
   * when the host is otherwise idle (regression guard for the bun/Windows pipe-delivery stall that
   * harness-only request pairs exhibit; the real binary is exempt, verified at ~6ms). */
  test('idle-window history read settles promptly through the production transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anureo-e2e-'))
    const adapter = createCodexAdapter({ command: 'codex', args: ['app-server'], cwd: dir })
    const runtime = await createClient({ adapter, identity: { adapterId: 'codex', runtimeConfigId: 'codex-e2e' }, interactions: { approval: undefined, userInput: undefined, elicitation: undefined, dynamicTool: undefined } })
    try {
      const session = await runtime.openSession({ requestId: 'e2e-open', mode: 'new', binding: { sessionId: 'e2e', adapterId: 'codex', runtimeConfigId: 'codex-e2e' }, cwd: dir })
      const started = Date.now()
      await session.request('history/read', { requestId: 'e2e-history', sessionId: 'e2e', limit: 1 })
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(5000)
      await session.close()
    } finally {
      await adapter.dispose()
    }
  }, 30_000)
})
