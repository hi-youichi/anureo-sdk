import { HarnessSdkError, type SessionEventSink } from '@anureo/sdk'
import type { ApprovalOption, InteractionRequested, InteractionResponse, UserQuestion } from '@anureo/protocol'
import { array, identity, integer, object, protocolError, stableId, text, type NativeObject } from './native'
import type { HermesAdapterOptions } from './options'
import type { HermesRpc, ServerRequest } from './rpc'

interface Pending {
  id: string
  nativeId: string
  generation?: number
  wire: 'prompt' | 'request'
  done: boolean
  responding: boolean
  cancelled?: string
  completion?: Promise<void>
}

/** The two native interaction mechanisms deliberately share only their AHP registry. */
export class HermesInteractions {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly sessionId: () => string, private readonly rpc: () => HermesRpc,
    private readonly sink: SessionEventSink, private readonly turnId: (generation: number) => string | undefined,
    private readonly epoch: () => number, private readonly options: HermesAdapterOptions) {}

  async prompt(value: NativeObject): Promise<void> {
    const nativeId = identity(value.prompt_id), generation = integer(value.execution_generation), epoch = this.epoch()
    const id = `hermes-prompt-${stableId(this.sessionId(), epoch, generation, nativeId)}`
    if (this.pending.has(id)) return
    const kind = value.kind
    let request: InteractionRequested
    if (kind === 'approval') {
      const semantics = { once: 'allowOnce', session: 'allowSession', deny: 'deny' } as const
      const options: ApprovalOption[] = array(value.choices).map(text).filter((choice): choice is keyof typeof semantics => Object.hasOwn(semantics, choice))
        .map(choice => ({ id: choice, label: choice, semantic: semantics[choice] }))
      if (!options.some(option => option.id === 'deny')) throw protocolError()
      request = { interactionId: id, kind: 'approval', options, title: 'Hermes approval',
        input: { ...(typeof value.command === 'string' ? { command: value.command } : {}), ...(typeof value.description === 'string' ? { description: value.description } : {}) } }
    } else if (kind === 'clarify') {
      request = { interactionId: id, kind: 'userInput', questions: [this.question(nativeId, text(value.question), value.choices)] }
    } else throw protocolError()
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
  async serverRequest(request: ServerRequest): Promise<void> {
    if (request.params.session_id !== this.sessionId()) { await this.rpc().reject(request.id); return }
    if (typeof request.id !== 'string' || !request.id.startsWith('srq-')) { await this.rpc().reject(request.id); return }
    const id = `hermes-request-${stableId(this.sessionId(), request.id)}`
    if (this.pending.has(id)) return
    let questions: UserQuestion[]
    if (request.method === 'clarify') {
      questions = array(request.params.questions).map(value => {
        const question = object(value)
        return this.question(identity(question.qid), text(question.question), question.choices)
      })
      if (!questions.length || new Set(questions.map(value => value.id)).size !== questions.length) throw protocolError()
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
  private question(id: string, prompt: string, choices: unknown): UserQuestion {
    return { id, prompt, ...(choices != null && array(choices).length ? { options: array(choices).map(value => ({ id: text(value), label: text(value) })) } : {}) }
  }
  private answer(value: unknown): string {
    if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value.join(', ')
    if (value === undefined || value === null) return ''
    return text(value)
  }
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
  async waitResponders(): Promise<void> {
    // A terminal frame may beat the native response ACK. The reader still routes ACKs directly.
    await Promise.all([...this.pending.values()].filter(value => value.responding && !value.done).map(value => value.completion))
  }
  async settled(nativeId: string, wire: Pending['wire'], reason = 'resolved', generation?: number): Promise<void> {
    for (const pending of this.pending.values()) {
      if (pending.done || pending.nativeId !== nativeId || pending.wire !== wire || generation !== undefined && pending.generation !== generation) continue
      pending.cancelled = reason
      if (pending.responding) continue // The local native ACK arbitrates the response already in flight.
      pending.done = true
      await this.sink.resolveInteraction({ interactionId: pending.id, outcome: reason === 'timeout' ? 'expired' : reason === 'resolved' ? 'unknown' : 'cancelled', reason: reason === 'resolved' ? 'native_settled' : reason })
    }
  }
  async snapshot(prompts: unknown[], requests: unknown[]): Promise<void> {
    const promptIds = new Set(prompts.map(value => identity(object(value).prompt_id)))
    const requestIds = new Set(requests.map(value => identity(object(value).id)))
    for (const value of this.pending.values()) if (value.done && !value.cancelled && (value.wire === 'prompt' ? promptIds : requestIds).has(value.nativeId)) {
      // A response may have left this process without reaching the owner. Never replay a secret
      // or silently suppress the still-open native question as though it had been answered.
      throw new HarnessSdkError('RESULT_UNKNOWN', 'Hermes interaction delivery could not be confirmed', false, true)
    }
    for (const value of this.pending.values()) if (!value.done && !(value.wire === 'prompt' ? promptIds : requestIds).has(value.nativeId)) {
      await this.settled(value.nativeId, value.wire, 'withdrawn', value.generation)
    }
    for (const value of prompts) await this.prompt(object(value))
    for (const value of requests) {
      const entry = object(value)
      await this.serverRequest({ id: identity(entry.id), method: identity(entry.method), params: object(entry.params) })
    }
  }
}
