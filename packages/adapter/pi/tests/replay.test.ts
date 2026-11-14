import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PiHostEvent } from '../src/host'
import type { Script } from './fake-host'
import { fixture } from './test-helpers'

/** Real events recorded from Pi 1.5.2 (see scripts/spike.ts): a bash tool call followed by a final answer. */
const recorded = JSON.parse(readFileSync(join(import.meta.dir, '../protocol/1.5.2/run.json'), 'utf8')) as { provenance: { piVersion: string }; events: PiHostEvent[] }

test('a recorded real Pi run maps to a completed turn with a tool call and a final answer', async () => {
  expect(recorded.provenance.piVersion).toBe('1.5.2')
  expect(recorded.events.at(-1)?.type).toBe('settled')
  const f = await fixture()
  try {
    f.host.script = replayScript(recorded.events)
    const result = await (await f.session.submit({ input: 'replay' })).result()
    expect(result.status).toBe('completed')
    const tools = result.items.filter(item => item.type === 'toolCall')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ kind: 'command', status: 'completed', toolName: 'bash' })
    expect(String((tools[0] as { output?: unknown }).output)).toContain('hello')
    const finals = result.items.filter(item => item.type === 'agentMessage' && item.phase === 'final')
    expect(finals).toHaveLength(1)
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.usage?.input).toBeGreaterThan(0)
  } finally { await f.dispose() }
})

/**
 * Preserve recorded event order while replacing agent_start, settled and the initial user pair
 * with FakePiHost's run events. Append completed non-user messages before notifying listeners
 * so the replay also supplies the branch history.
 */
function replayScript(events: readonly PiHostEvent[]): Script {
  let skippedUserEvents = 0
  const body = events.filter(event => {
    if (event.type === 'agent_start' || event.type === 'settled') return false
    if ((event.type === 'message_start' || event.type === 'message_end') && event.message.role === 'user' && skippedUserEvents < 2) {
      skippedUserEvents++
      return false
    }
    return true
  })
  return async host => {
    for (const event of body) {
      if (event.type === 'message_end' && event.message.role !== 'user') host.append(event.message)
      host.emit(event)
    }
  }
}
