import { expect, spyOn, test } from 'bun:test'
import { Turn, type RequestOptions, type Session, type TurnResult } from '@anureo/sdk'
import { SwarmExecution } from '../src/execution'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const terminal = deferred<TurnResult>()
  const waiting = deferred<void>()
  let interrupts = 0
  let terminalObserved = false
  const turn = new Turn({
    id: 'backend-turn',
    // These executions do not request an event relay.
    events: undefined!,
    result: terminal.promise,
    get terminal() { return terminalObserved },
    async steer() {},
    async interrupt() {
      interrupts++
      terminalObserved = true
      terminal.resolve({ status: 'interrupted', text: '', items: [] })
    },
  })
  const result = turn.result.bind(turn)
  turn.result = (wait?: RequestOptions) => {
    const pending = result(wait)
    waiting.resolve()
    return pending
  }
  const session = { async submit() { return turn } } as unknown as Session
  return { session, turn, terminal, waiting, get interrupts() { return interrupts } }
}

test('default execution survives the former five-minute deadline and completes normally', async () => {
  const backend = fixture()
  const execution = new SwarmExecution()
  const timers = spyOn(globalThis, 'setTimeout')
  const pending = execution.submit(backend.session, { input: 'long investigation' })
  // Observe rejections immediately, including regressions caused by a restored deadline.
  const outcome = pending.then(value => value, error => error)
  try {
    await backend.waiting.promise
    const expired = timers.mock.calls.filter(([, ms]) => typeof ms === 'number' && ms <= 300_001)
    timers.mockRestore()
    // Advance every scheduled observation deadline past the old limit without sleeping.
    for (const [callback] of expired) if (typeof callback === 'function') callback()
    backend.terminal.resolve({ status: 'completed', text: 'finished', items: [] })
    expect(await outcome).toMatchObject({ status: 'completed', text: 'finished' })
    expect(backend.interrupts).toBe(0)
  } finally {
    timers.mockRestore()
    backend.terminal.resolve({ status: 'interrupted', text: '', items: [] })
    await outcome
  }
});

test('an unlimited execution still interrupts and settles when cancelled', async () => {
  const backend = fixture()
  const execution = new SwarmExecution()
  const pending = execution.submit(backend.session, { input: 'investigate' })
  await backend.waiting.promise
  execution.cancel()
  expect(await pending).toMatchObject({ status: 'interrupted' })
  expect(backend.interrupts).toBe(1)
  await expect(backend.turn.result()).rejects.toMatchObject({ code: 'TURN_DISPOSED' })
});

test('an explicitly bounded execution still times out and interrupts its backend', async () => {
  const backend = fixture()
  const execution = new SwarmExecution()
  await expect(execution.submit(backend.session, { input: 'bounded review' }, undefined, 1))
    .rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: false })
  expect(backend.interrupts).toBe(1)
});
