import { expect, test } from 'bun:test'
import { ChangeSignal } from '../src/coordination/change-signal'
import { CompletionMailbox } from '../src/coordination/mailbox'
import { ResultStore } from '../src/results'
import { TaskStore, type StoredTask } from '../src/tasks/store'
import { OperationStore } from '../src/coordination/operations'

test('versioned waiting preserves independent observers and cleans up on abort and close', async () => {
  const changes = new ChangeSignal()
  const before = changes.current()
  changes.touch()
  expect(await changes.waitAfter(before, 1000)).toBe('changed')
  const controller = new AbortController()
  const cancelled = changes.waitAfter(changes.current(), 1000, controller.signal)
  const error = cancelled.then(() => undefined, cause => cause)
  const other = changes.waitAfter(changes.current(), 1000)
  controller.abort()
  changes.touch()
  expect(await error).toMatchObject({ code: 'REQUEST_ABORTED' })
  expect(await other).toBe('changed')
  const closing = changes.waitAfter(changes.current(), 1000)
  const closed = closing.then(() => undefined, cause => cause)
  changes.close()
  expect(await closed).toMatchObject({ code: 'SESSION_CLOSED' })
})

test('any/all waits retain task identity across turns and do not release settling reservations', async () => {
  const evicted: string[] = []
  const store = new TaskStore<StoredTask>({ maxConcurrentTasks: 2, maxTasksPerTurn: 2 }, task => evicted.push(task.id), 1, 2)
  const task = (id: string): StoredTask => ({ id, turnId: 't1', state: 'running', phase: 'preparing', done: Promise.resolve() })
  store.begin('t1')
  const a = task('a'), b = task('b')
  store.add(a); store.add(b)
  const waiting = store.wait(['a', 'b'], 'any', 1000)
  b.phase = 'settling'
  expect(() => store.checkCapacity()).toThrow('SWARM_TASK_LIMIT')
  expect((await store.wait(['b'], 'all', 0)).timedOut).toBe(true)
  b.state = 'completed'; b.phase = 'terminal'; store.changes.touch()
  expect((await waiting).tasks).toEqual([a, b])
  expect((await store.wait(['a', 'b'], 'all', 0)).timedOut).toBe(true)
  a.state = 'completed'; a.phase = 'terminal'; store.changes.touch()
  store.begin('t2')
  expect([...store.values()]).toEqual([])
  expect(store.get('a')).toBe(a)
  store.begin('t3')
  expect(evicted).toEqual(['a', 'b'])
  store.close()
})

test('complete result pages preserve Unicode, authenticate cursors and expose omission and expiry', () => {
  const results = new ResultStore()
  const text = 'A😀中文\u0001'.repeat(6000)
  const descriptor = results.put('task', 'attempt', { status: 'completed', text, items: [] })
  expect(descriptor.previewTruncated).toBe(true)
  expect(Buffer.byteLength(descriptor.preview)).toBeLessThanOrEqual(16384)
  let cursor: string | undefined, collected = ''
  do {
    const page = results.read(descriptor.resultRef, cursor, 4096)
    collected += page.text
    cursor = page.nextCursor
  } while (cursor)
  expect(collected).toBe(text)
  const first = results.read(descriptor.resultRef, undefined, 17)
  expect(() => results.read(descriptor.resultRef, first.nextCursor + 'x', 17)).toThrow('SWARM_INVALID_CURSOR')
  const different = results.put('other', 'attempt', { status: 'completed', text: 'x'.repeat(200), items: [] })
  expect(() => results.read(different.resultRef, first.nextCursor, 17)).toThrow('SWARM_INVALID_CURSOR')
  expect(() => new ResultStore().read(descriptor.resultRef, undefined, 17)).toThrow('SWARM_RESULT_EXPIRED')
  results.expire(descriptor.resultRef)
  expect(() => results.read(descriptor.resultRef, undefined, 17)).toThrow('SWARM_RESULT_EXPIRED')
  const bounded = new ResultStore({ maxBytes: 4 })
  const omitted = bounded.put('large', 'attempt', { status: 'completed', text: 'too large', items: [] })
  expect(omitted).toMatchObject({ availability: 'omitted', status: 'completed' })
  expect(() => bounded.read(omitted.resultRef, undefined, 4)).toThrow('SWARM_RESULT_OMITTED')
  expect(bounded.put('invalid', 'attempt', { status: 'completed', text: '\ud800', items: [] }).reason).toBe('SWARM_RESULT_ENCODING')
})

test('JSON-escaped result pages stay bounded while preserving every byte', () => {
  const results = new ResultStore()
  const text = '\u0000'.repeat(40000)
  const record = results.put('controls', 'a', { status: 'completed', text, items: [] })
  const first = results.read(record.resultRef, undefined, 32768)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(65536)
  expect(first.nextCursor).toBeDefined()
  let page = first, restored = ''
  while (true) {
    restored += page.text
    if (page.done) break
    page = results.read(record.resultRef, page.nextCursor, 32768)
  }
  expect(restored).toBe(text)
})

test('completion capacity is reserved before dispatch and cursors never silently skip evicted notices', async () => {
  const mailbox = new CompletionMailbox({ maxNotices: 1 })
  const results = new ResultStore()
  const outcome = { status: 'completed' as const, text: 'evidence', items: [] }
  mailbox.begin('t1')
  mailbox.reserve('a')
  expect(() => mailbox.reserve('b')).toThrow('SWARM_MAILBOX_FULL')
  const waiting = mailbox.receive(0, 16, 1000)
  mailbox.publish({ id: 'a', attemptId: 'aa', beeId: 'bee', turnId: 't1' }, results.put('a', 'aa', outcome), outcome)
  const first = await waiting
  expect(first.notices).toHaveLength(1)
  expect(mailbox.page(0, 16)).toEqual(first)
  mailbox.begin('t2')
  mailbox.reserve('b')
  expect(() => mailbox.page(0, 16)).toThrow('SWARM_MAILBOX_CURSOR_EXPIRED')
  mailbox.publish({ id: 'b', attemptId: 'bb', beeId: 'bee', turnId: 't2' }, results.put('b', 'bb', outcome), outcome)
  expect(mailbox.page(first.nextCursor, 16).notices[0].seq).toBe(2)
  const controller = new AbortController()
  const pending = mailbox.receive(2, 16, 1000, controller.signal)
  const aborted = pending.then(() => undefined, cause => cause)
  controller.abort()
  expect(await aborted).toMatchObject({ code: 'REQUEST_ABORTED' })
  mailbox.close()
})

test('business retries share one command and stale or conflicting scopes never dispatch', async () => {
  const operations = new OperationStore()
  operations.begin()
  const scope = operations.scope()
  let starts = 0
  const first = operations.run('delegate', `${scope}:one`, { a: 1, b: 2 }, () => { starts++; return { taskId: 'task' } })
  const second = operations.run('delegate', `${scope}:one`, { b: 2, a: 1 }, () => { starts++; return { taskId: 'duplicate' } })
  expect(first).toBe(second)
  expect(await first).toEqual({ taskId: 'task' })
  expect(starts).toBe(1)
  expect(() => operations.run('delegate', `${scope}:one`, { a: 2 }, () => {})).toThrow('SWARM_OPERATION_CONFLICT')
  operations.begin()
  expect(() => operations.run('delegate', `${scope}:new`, {}, () => {})).toThrow('SWARM_OPERATION_EXPIRED')
  const receipt = { state: 'queued' }
  const current = operations.scope()
  await operations.run('send', `${current}:pending`, {}, () => receipt)
  for (let i = 0; i < 10; i++) operations.begin()
  expect(await operations.run<typeof receipt>('send', `${current}:pending`, {}, () => { throw new Error('Must not retry') })).toBe(receipt)
  expect(() => operations.run('delegate', `${scope}:one`, { a: 1, b: 2 }, () => {})).toThrow('SWARM_OPERATION_EXPIRED')
  receipt.state = 'submitted'
  for (let i = 0; i < 8; i++) operations.begin()
  expect(() => operations.run('send', `${current}:pending`, {}, () => {})).toThrow('SWARM_OPERATION_EXPIRED')
})
