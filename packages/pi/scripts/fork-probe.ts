/** Offline probe of Pi's session-file semantics that the default host's fork/resume rely on. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const dir = await mkdtemp(join(tmpdir(), 'anureo-pi-fork-'))
try {
  const sessionDir = join(dir, 'sessions')
  const manager = SessionManager.create(dir, sessionDir)
  const user = (text: string) => ({ role: 'user' as const, content: text, timestamp: Date.now() })
  const assistant = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }], api: 'x', provider: 'x', model: 'x', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: Date.now() })
  const a = manager.appendMessage(user('one') as never)
  const b = manager.appendMessage(assistant('r1') as never)
  manager.appendMessage(user('two') as never)
  manager.appendMessage(assistant('r2') as never)
  const originalFile = manager.getSessionFile()
  const originalId = manager.getSessionId()
  console.log('persisted file exists on disk:', originalFile)

  const source = SessionManager.open(originalFile!, sessionDir)
  const branched = source.createBranchedSession(b)
  console.log('createBranchedSession ->', branched)
  console.log('new id differs from source:', source.getSessionId() !== originalId)
  console.log('branch ids:', source.getBranch().map(entry => entry.id).join(','), '(expected prefix', a, b, ')')
  console.log('findById resolves new session:', SessionManager.findById(dir, source.getSessionId(), sessionDir) !== undefined)
  console.log('findById resolves original session:', SessionManager.findById(dir, originalId, sessionDir) !== undefined)
} finally { await rm(dir, { recursive: true, force: true }) }
