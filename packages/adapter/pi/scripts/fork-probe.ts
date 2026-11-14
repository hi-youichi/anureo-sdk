/** Offline probe of Pi's session-file semantics that the default host's fork/resume rely on. */
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
  console.log('persisted file exists on disk:', originalFile)

  // A persisted manager flushes its session file when the conversation starts.
  const source = SessionManager.open(originalFile!, sessionDir)
  const branched = source.createBranchedSession(first.replyId)
  console.log('createBranchedSession ->', branched)
  console.log('new id differs from source:', source.getSessionId() !== originalId)
  console.log('branch ids:', source.getBranch().map(entry => entry.id).join(','), '(expected prefix', first.inputId, first.replyId, ')')
  console.log('findById resolves new session:', SessionManager.findById(dir, source.getSessionId(), sessionDir) !== undefined)
  console.log('findById resolves original session:', SessionManager.findById(dir, originalId, sessionDir) !== undefined)
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
