/** Offline probe of Pi's session-file semantics that the default host's fork/resume rely on. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const dir = await mkdtemp(join(tmpdir(), 'anureo-pi-fork-'))
try {
  const sessionDir = join(dir, 'sessions')
  const manager = SessionManager.create(dir, sessionDir)
  const first = appendTurn({ manager, input: 'one', reply: 'r1' })
  appendTurn({ manager, input: 'two', reply: 'r2' })
  const originalFile = manager.getSessionFile()
  const originalId = manager.getSessionId()
  assert(originalFile)

  // A persisted manager flushes its session file when the conversation starts.
  const source = SessionManager.open(originalFile, sessionDir)
  const branched = source.createBranchedSession(first.replyId)
  assert(branched)
  assert.notEqual(source.getSessionId(), originalId)
  assert.deepEqual(source.getBranch().map(entry => entry.id), [first.inputId, first.replyId])
  assert(SessionManager.findById(dir, source.getSessionId(), sessionDir))
  assert(SessionManager.findById(dir, originalId, sessionDir))
  console.log('Pi fork retained the expected prefix under a discoverable new session ID')
} finally {
  await rm(dir, { recursive: true, force: true })
}

/** Append a local turn without calling a provider. Return entry IDs for the expected fork prefix. */
function appendTurn({ manager, input, reply }: { manager: SessionManager; input: string; reply: string }) {
  const inputId = manager.appendMessage({ role: 'user', content: input, timestamp: Date.now() })
  const replyId = manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: reply }],
    // Session storage only needs the transcript. Synthetic model fields keep the probe offline.
    api: 'x', provider: 'x', model: 'x',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  })
  return { inputId, replyId }
}
