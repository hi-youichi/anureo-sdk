import { HarnessSdkError, type SessionEventSink } from '@anureo/sdk'
import type { ApprovalOption, InteractionRequested, InteractionResponse, UserQuestion } from '@anureo/protocol'
import { array, identity, integer, object, protocolError, stableId, text, type NativeObject } from './native'
import type { HermesAdapterOptions } from './options'
import type { HermesRpc, ServerRequest } from './rpc'

/**
 * Internal interaction registry owned by HermesSession. Map replayed prompts and gateway requests
 * to stable SDK interaction ids without blocking the serial reader on user answers. The two native
 * mechanisms share this registry but retain their different acknowledgement semantics. The SDK
 * Session owns handler cancellation and answer privacy. HermesSession owns channel cleanup and recovery.
 */
export class HermesInteractions {
  /** Capture callbacks supplied by HermesSession; resolve identity/channel lazily so pending answers use the recovered connection. */
  constructor({ sessionId, rpc, sink, turnId, epoch, options }: {
    sessionId: () => string
    rpc: () => HermesRpc
    sink: SessionEventSink
    /** Resolve a generation only in the session's current authority epoch. */
    turnId: (generation: number) => string | undefined
    epoch: () => number
    options: HermesAdapterOptions
  }) {
    this.sessionId = sessionId
    this.rpc = rpc
    this.sink = sink
    this.turnId = turnId
    this.epoch = epoch
    this.options = options
  }

  /**
   * Register an approval/clarification from HermesSession.apply or snapshot, ignoring replayed ids.
   * Invalid prompts and a full registry reject registration. The sink can invoke the responder with
   * an answer or null, which sends a denial or empty clarification. Delivery checks the current
   * authority before sending once and requires a native ACK for the same prompt id. The sink
   * observes delivery failures through the responder.
   */
  async prompt(value: NativeObject): Promise<void> {
    const nativeId = identity(value.prompt_id), generation = integer(value.execution_generation), epoch = this.epoch()
    const id = `hermes-prompt-${stableId(this.sessionId(), epoch, generation, nativeId)}`
    if (this.pending.has(id)) return
    const kind = value.kind
    if (kind !== 'approval' && kind !== 'clarify') throw protocolError()
    const request: InteractionRequested = kind === 'approval' ? approvalRequest(id, value)
      : { interactionId: id, kind: 'userInput', questions: [this.question(nativeId, text(value.question), value.choices)] }
    const scopedTurn = this.turnId(generation)
    if (scopedTurn) request.turnId = scopedTurn
    if (typeof value.timeout_s === 'number' && value.timeout_s > 0) request.expiresAt = new Date(Date.now() + value.timeout_s * 1000).toISOString()
    const pending: Pending = { id, nativeId, generation, wire: 'prompt', done: false, responding: false }
    this.register(pending, request, async response => {
      if (this.epoch() !== epoch) throw new HarnessSdkError('INTERACTION_EXPIRED')
      const params = { session_id: this.sessionId(), execution_generation: generation, prompt_id: nativeId }
      const answer = kind === 'approval'
        ? { ...params, choice: response?.kind === 'approval' ? response.optionId : 'deny' }
        : { ...params, answer: response?.kind === 'userInput' ? this.answer(response.answers[nativeId]) : '' }
      const result = object(await this.rpc().request(kind === 'approval' ? 'approval.respond' : 'clarify.respond', answer, true))
      if (result.prompt_id !== nativeId || !['resolved', 'already_resolved'].includes(String(result.status))) throw protocolError()
      if (result.status === 'already_resolved') throw new HarnessSdkError('INTERACTION_ALREADY_RESOLVED', 'Hermes prompt already settled', false, true)
    })
  }
  /**
   * Register session-scoped srq requests from HermesSession's live or held traffic, or from snapshot.
   * Reply with a native error for unsupported requests and reject malformed supported payloads.
   * The sink owns the wait for answers. The responder resolves after local send, so snapshot checks
   * whether a finished delivery still appears open remotely.
   */
  async serverRequest(request: ServerRequest): Promise<void> {
    if (request.params.session_id !== this.sessionId()) { await this.rpc().reject(request.id); return }
    if (typeof request.id !== 'string' || !request.id.startsWith('srq-')) { await this.rpc().reject(request.id); return }
    const id = `hermes-request-${stableId(this.sessionId(), request.id)}`
    if (this.pending.has(id)) return
    let questions: UserQuestion[]
    if (request.method === 'clarify') {
      questions = this.batchQuestions(request.params)
    } else if (request.method === 'sudo' || request.method === 'secret') {
      questions = [{ id: 'value', prompt: request.method === 'sudo' ? 'Hermes requests a sudo password' : text(request.params.prompt), secret: true }]
    } else { await this.rpc().reject(request.id); return }
    const pending: Pending = { id, nativeId: request.id, wire: 'request', done: false, responding: false }
    this.register(pending, { interactionId: id, kind: 'userInput', questions }, async response => {
      const answers = response?.kind === 'userInput' ? response.answers : undefined
      const result = request.method === 'clarify'
        ? { answers: Object.fromEntries(questions.map(question => [question.id, answers ? this.answer(answers[question.id]) : null])), outcome: answers ? 'submitted' : 'cancelled' }
        : { value: answers ? this.answer(answers.value) : '' }
      await this.rpc().reply(request.id, result)
    })
  }
  /** Let deliveries already in flight settle before HermesSession.applyTurnEvent projects a terminal frame. The sink handles their outcomes. */
  async waitResponders(): Promise<void> {
    // A terminal frame may beat the native response ACK. The reader still routes ACKs directly.
    await Promise.all([...this.pending.values()].filter(value => value.responding && !value.done).map(value => value.completion))
  }
  /**
   * Handle peer settlement from HermesSession.apply or withdrawal from snapshot. Match prompt
   * generations to fence reused ids and leave in-flight delivery to its own settlement path.
   * Publish an unknown outcome for a bare native resolved signal because it carries no answer.
   * Sink publication failures reject to the caller.
   */
  async settled(target: InteractionTarget, reason: string): Promise<void> {
    for (const pending of this.pending.values()) {
      if (pending.done || pending.nativeId !== target.nativeId || pending.wire !== target.wire || target.wire === 'prompt' && pending.generation !== target.generation) continue
      pending.cancelled = reason
      if (pending.responding) continue // The local native ACK arbitrates the response already in flight.
      pending.done = true
      await this.sink.resolveInteraction({ interactionId: pending.id, outcome: reason === 'timeout' ? 'expired' : reason === 'resolved' ? 'unknown' : 'cancelled', reason: reason === 'resolved' ? 'native_settled' : reason })
    }
  }
  /**
   * HermesSession.snapshot reconciles open native questions before releasing held traffic. Withdraw
   * missing questions and register new ones; reject RESULT_UNKNOWN if a locally finished delivery is
   * still open remotely, preventing silent suppression or replay of a possibly delivered secret.
   */
  async snapshot(prompts: unknown[], requests: unknown[]): Promise<void> {
    const promptIds = new Set(prompts.map(value => identity(object(value).prompt_id)))
    const requestIds = new Set(requests.map(value => identity(object(value).id)))
    for (const value of this.pending.values()) if (value.done && !value.cancelled && (value.wire === 'prompt' ? promptIds : requestIds).has(value.nativeId)) {
      // A response may have left this process without reaching the owner. Never replay a secret
      // or silently suppress the still-open native question as though it had been answered.
      throw new HarnessSdkError('RESULT_UNKNOWN', 'Hermes interaction delivery could not be confirmed', false, true)
    }
    for (const value of this.pending.values()) if (!value.done && !(value.wire === 'prompt' ? promptIds : requestIds).has(value.nativeId)) {
      await this.settled(value, 'withdrawn')
    }
    for (const value of prompts) await this.prompt(object(value))
    for (const value of requests) {
      const entry = object(value)
      await this.serverRequest({ id: identity(entry.id), method: identity(entry.method), params: object(entry.params) })
    }
  }

  private readonly pending = new Map<string, Pending>()
  /** Parse a nonempty clarify batch with distinct native question ids so one answer can be sent per id. */
  private batchQuestions(params: NativeObject): UserQuestion[] {
    const questions = array(params.questions).map(value => {
      const question = object(value)
      return this.question(identity(question.qid), text(question.question), question.choices)
    })
    if (!questions.length || new Set(questions.map(value => value.id)).size !== questions.length) throw protocolError()
    return questions
  }
  /** Normalize optional native choices; null, omission and an empty array all leave the question open-ended. */
  private question(id: string, prompt: string, choices: unknown): UserQuestion {
    const values = choices == null ? [] : array(choices)
    return { id, prompt, ...(values.length ? { options: values.map(value => ({ id: text(value), label: text(value) })) } : {}) }
  }
  /** Encode SDK answers for Hermes text fields; unanswered/null values become empty text and string selections are comma-separated. */
  private answer(value: unknown): string {
    if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value.join(', ')
    if (value === undefined || value === null) return ''
    return text(value)
  }
  /**
   * Admit within registry budgets and register the responder with the SDK sink. Session invokes it
   * for unsupported or closed requests, and InteractionRegistry invokes it for answers and
   * cancellations. Mark delivery in flight before writing so native settlement can defer to it.
   * Observe fulfillment and rejection as local completion without blocking the reader on the user.
   */
  private register(pending: Pending, request: InteractionRequested, respond: (response: InteractionResponse | null) => Promise<void>): void {
    if ([...this.pending.values()].filter(value => !value.done).length >= (this.options.maxInteractions ?? 32)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    if (this.pending.size >= (this.options.maxInteractions ?? 32) + 1024) {
      const retired = [...this.pending].find(([, value]) => value.done)
      if (retired) this.pending.delete(retired[0])
    }
    this.pending.set(pending.id, pending)
    // Do not await the user from the receive loop. Core owns cancellation and response privacy.
    pending.completion = this.sink.requestInteraction(request, async response => {
      if (pending.done) throw new HarnessSdkError('INTERACTION_EXPIRED')
      pending.responding = true
      await respond(response)
      if (pending.cancelled && pending.cancelled !== 'resolved') throw new HarnessSdkError('RESULT_UNKNOWN', 'Hermes interaction ended while responding', false, true)
    }).then(() => { pending.done = true }, () => { pending.done = true })
  }

  private readonly sessionId: () => string
  private readonly rpc: () => HermesRpc
  private readonly sink: SessionEventSink
  private readonly turnId: (generation: number) => string | undefined
  private readonly epoch: () => number
  private readonly options: HermesAdapterOptions
}

/** Preserve the native identity needed to match settlement, including the generation for prompts. */
type InteractionTarget =
  | { wire: 'prompt'; nativeId: string; generation: number }
  | { wire: 'request'; nativeId: string; generation?: never }

type Pending = InteractionTarget & {
  id: string
  done: boolean
  /** Delivery has begun; native settlement must let that delivery's ACK arbitrate the outcome. */
  responding: boolean
  cancelled?: string
  /** Observes the sink's user wait and settlement, resolving on success or failure. */
  completion?: Promise<void>
}

/** Offer only supported native approval choices and require an explicit denial path. */
function approvalRequest(id: string, value: NativeObject): InteractionRequested {
  const semantics = { once: 'allowOnce', session: 'allowSession', deny: 'deny' } as const
  const options: ApprovalOption[] = array(value.choices).map(text).filter((choice): choice is keyof typeof semantics => Object.hasOwn(semantics, choice))
    .map(choice => ({ id: choice, label: choice, semantic: semantics[choice] }))
  if (!options.some(option => option.id === 'deny')) throw protocolError()
  return { interactionId: id, kind: 'approval', options, title: 'Hermes approval',
    input: { ...(typeof value.command === 'string' ? { command: value.command } : {}), ...(typeof value.description === 'string' ? { description: value.description } : {}) } }
}
