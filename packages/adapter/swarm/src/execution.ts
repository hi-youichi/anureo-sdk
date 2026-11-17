import { HarnessSdkError, sdkError, type Client, type Session, type SubmitOptions, type Turn, type TurnResult } from '@anureo/sdk'
import type { AhpEvent, HarnessError } from '@anureo/protocol'

const stopTimeoutMs = 5_000

export interface ExecutionHooks {
  /** Called synchronously immediately before handing input to the SDK. */
  onDispatch?(): void
  /** Transfers ownership of an independent Turn observer to this internal callback. */
  onBound?(turn: Turn): void
}

/** Only a definite instruction-capability failure permits retrying without instructions. */
export function instructionsUnsupported(cause: unknown): boolean {
  const error = sdkError(cause)
  return error.code === 'CAPABILITY_UNSUPPORTED' && error.details?.capability === 'session.instructions'
}

export function executionError(cause: unknown): HarnessError {
  const { code, retryable, outcomeUnknown } = sdkError(cause, 'SWARM_EXECUTION_FAILED', true)
  return { code, message: code, retryable, outcomeUnknown }
}

export async function releaseSession(session: Session) {
  try {
    return await session.close({ timeoutMs: stopTimeoutMs })
  } finally {
    await session.dispose()
  }
}

/** Owns the execution cancellation signal. SDK wait cancellation by itself only stops observation. */
export class SwarmExecution {
  private readonly stop = new AbortController()
  get stopped() { return this.stop.signal.aborted }
  get signal() { return this.stop.signal }

  cancel() { this.stop.abort() }

  async fresh(
    client: Client,
    params: Parameters<Client['sessions']['create']>[0],
    task: (session: Session, promptInstructions?: string) => Promise<TurnResult>,
    options: {
      allowPromptInstructions?: boolean
      /** Returning true transfers ownership of this completed session to the caller. */
      handoff?: (session: Session, promptInstructions?: string) => boolean
    } = {},
  ): Promise<TurnResult> {
    const wait = { signal: this.stop.signal }
    let promptInstructions: string | undefined
    const session = await client.sessions.create(params, wait).catch(cause => {
      if (!options.allowPromptInstructions || !params.instructions || !instructionsUnsupported(cause)) throw cause
      const { instructions, ...sessionParams } = params
      promptInstructions = instructions
      return client.sessions.create(sessionParams, wait)
    }).catch(cause => {
      // Opening cannot have submitted this task. The SDK owns release if opening finishes late.
      const { code, retryable } = executionError(cause)
      throw new HarnessSdkError(code, code, retryable)
    })
    let outcomeUnknown = false
    let transferred = false
    try {
      const result = await task(session, promptInstructions)
      outcomeUnknown = result.status !== 'completed' && result.error?.outcomeUnknown === true
      if (result.status === 'completed') transferred = options.handoff?.(session, promptInstructions) === true
      return result
    } catch (cause) {
      outcomeUnknown = executionError(cause).outcomeUnknown
      throw cause
    } finally {
      if (!transferred) {
        await releaseSession(session).catch(cause => {
          if (!outcomeUnknown) throw cause
        })
      }
    }
  }

  async submit(
    session: Session,
    options: SubmitOptions,
    relay?: (event: AhpEvent) => Promise<void>,
    timeoutMs?: number,
    hooks?: ExecutionHooks,
  ): Promise<TurnResult> {
    if (this.stopped) return { status: 'interrupted', text: '', items: [] }
    const observation = new AbortController()
    // Subscribe before submit, so even a complete-before-bind execution has a stream.
    const events = relay && session.events({ signal: observation.signal })
    let turn: Turn | undefined
    let interruption: Promise<void> | undefined
    let terminal: TurnResult | undefined
    let observationDone: Promise<void> | undefined
    const resultWait = new AbortController()
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    const requestInterrupt = (target: Turn) => interruption ??= Promise.resolve()
      .then(() => target.interrupt({ timeoutMs: stopTimeoutMs }))
      .catch(() => { /* The terminal result determines whether execution stopped. */ })
    const onStop = () => {
      if (!turn || terminal) return
      void requestInterrupt(turn)
      stopTimer = setTimeout(() => resultWait.abort(), stopTimeoutMs)
    }
    try {
      // Keep waiting for association on interrupt, so a late handle can still be stopped.
      hooks?.onDispatch?.()
      turn = await session.submit(options, { timeoutMs: Math.min(timeoutMs ?? 30_000, 30_000) })
      this.stop.signal.addEventListener('abort', onStop, { once: true })
      if (this.stopped) onStop()
      if (hooks?.onBound) {
        const observer = turn.observe()
        try { hooks.onBound(observer) } catch (cause) { await observer.dispose(); throw cause }
      }
      const targetId = turn.id
      const view = async () => {
        if (!events || !relay) return
        for await (const event of events) {
          if (event.turnId !== targetId) continue
          if (event.type === 'turn/completed') return
          await relay(event)
        }
      }
      observationDone = view()
      const [result] = await Promise.all([
        // Execution has no default deadline; cancellation still bounds stop confirmation.
        turn.result({ signal: resultWait.signal, timeoutMs: timeoutMs ?? null }).then(value => terminal = value),
        observationDone,
      ])
      return result
    } catch (cause) {
      if (!turn) throw cause
      if (!terminal && !this.stopped) {
        await requestInterrupt(turn)
        terminal = await turn.result({ timeoutMs: stopTimeoutMs }).catch(() => undefined)
      }
      const error = executionError(cause)
      throw new HarnessSdkError(error.code, error.message, error.retryable && terminal !== undefined, terminal === undefined)
    } finally {
      this.stop.signal.removeEventListener('abort', onStop)
      clearTimeout(stopTimer)
      observation.abort()
      resultWait.abort()
      // No member item may arrive after its assignment has been finalized.
      await observationDone?.catch(() => {})
      await turn?.dispose()
    }
  }
}
