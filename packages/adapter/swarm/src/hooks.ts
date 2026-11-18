import type { TurnResult } from '@anureo/sdk'
import type { BeeProfile, BeeProfileSource } from './profiles'
import type { BeeExecutionSelection } from './models'

export type Immutable<T, D extends unknown[] = []> = D["length"] extends 8 ? Readonly<T> : T extends object ? { readonly [K in keyof T]: Immutable<T[K], [...D, unknown]> } : T
export interface SwarmAssignment { task: string; context: string; constraints: string; expectedOutput: string }
export interface AssignmentRevisionPin {
  revisionId: string
  generation: number
  headId: string
}
export interface DelegationSnapshot {
  sessionId: string; turnId: string; taskId: string; beeId: string; name: string; role: string
  attemptId?: string
  carriedMessageIds?: readonly string[]
  profile?: Immutable<BeeProfile>
  profileSource?: Immutable<BeeProfileSource>
  sourceFile?: string
  pin?: Immutable<AssignmentRevisionPin>
  experiences?: readonly string[]
  execution?: Immutable<BeeExecutionSelection>
  assignment: Immutable<SwarmAssignment>
}
export interface TaskSnapshot extends DelegationSnapshot { result: Immutable<TurnResult> }
export interface AssessmentSnapshot {
  id: string; sessionId: string; turnId: string; taskId: string; beeId: string
  verdict: 'accepted' | 'needs_revision' | 'rejected'; reason: string; evidence: readonly string[]
}
export interface TurnSnapshot {
  sessionId: string; turnId: string; status: TurnResult['status']
  tasks: readonly TaskSnapshot[]; assessments: readonly AssessmentSnapshot[]
}
export interface HookContext { signal: AbortSignal; deadlineAt: number }
export interface HookDiagnostic { hook: string; code: string; message: string }
export type BeforeDelegateResult = void | { deny: string } | { enrich: Partial<Pick<SwarmAssignment, 'context' | 'constraints' | 'expectedOutput'>> }
export interface SwarmHooks {
  beforeDelegate?(event: Immutable<DelegationSnapshot>, context: HookContext): BeforeDelegateResult | Promise<BeforeDelegateResult>
  afterTask?(event: Immutable<TaskSnapshot>, context: HookContext): void | Promise<void>
  afterAssessment?(event: Immutable<AssessmentSnapshot>, context: HookContext): void | Promise<void>
  afterTurn?(event: Immutable<TurnSnapshot>, context: HookContext): void | Promise<void>
}
export interface SwarmHookOptions {
  hooks?: SwarmHooks
  /** Applies separately to every hook, legacy review callback and onError. Default 1000ms. */
  hookTimeoutMs?: number
  onError?(diagnostic: Immutable<HookDiagnostic>, context: HookContext): void | Promise<void>
}

/** Clone before freezing: extension code never receives mutable execution state. */
export function snapshot<T>(value: T): Immutable<T> {
  const copy = structuredClone(value)
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return
    for (const child of Object.values(entry)) freeze(child)
    Object.freeze(entry)
  }
  freeze(copy)
  return copy as Immutable<T>
}

/** A deadline detaches uncooperative callbacks; their late values are never applied. */
export async function bounded<T>(callback: (context: HookContext) => T | Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const deadlineAt = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort!: () => void
  const stopped = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(); reject(new Error('SWARM_HOOK_ABORTED')) }
    parent?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { controller.abort(); reject(new Error('SWARM_HOOK_TIMEOUT')) }, timeoutMs)
  })
  try {
    if (parent?.aborted) abort()
    return await Promise.race([stopped, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('SWARM_HOOK_ABORTED')
      return callback({ signal: controller.signal, deadlineAt })
    })])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    controller.abort()
  }
}

export class HookRunner {
  readonly diagnostics: HookDiagnostic[] = []
  readonly timeoutMs: number
  constructor(private readonly options: SwarmHookOptions = {}, private readonly evidenceHooks?: SwarmHooks) {
    this.timeoutMs = options.hookTimeoutMs ?? 1000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error('SWARM_INVALID_HOOK_TIMEOUT')
  }
  async invoke<K extends keyof SwarmHooks>(name: K, event: Parameters<NonNullable<SwarmHooks[K]>>[0], signal?: AbortSignal): Promise<BeforeDelegateResult> {
    const callback = this.options.hooks?.[name]
    const evidence = name === 'beforeDelegate' ? undefined : this.evidenceHooks?.[name]
    const invoke = async (handler: typeof callback, label: string): Promise<BeforeDelegateResult> => {
      if (!handler) return
      try {
        return await bounded(context => (handler as (e: unknown, c: HookContext) => Promise<BeforeDelegateResult>)(snapshot(event), context), this.timeoutMs, signal)
      } catch (cause) {
        await this.error(label, cause)
        if (name === 'beforeDelegate') throw cause
      }
    }
    if (name === 'beforeDelegate') return invoke(callback, name)
    // Independently bounded: a failing/hanging application observer cannot suppress evidence.
    await Promise.all([invoke(callback, name), evidence !== callback ? invoke(evidence, `evolution.${name}`) : undefined])
  }

  async error(hook: string, cause: unknown) {
    const diagnostic = snapshot({ hook, code: cause instanceof Error && cause.message.startsWith('SWARM_HOOK_') ? cause.message : 'SWARM_HOOK_FAILED', message: cause instanceof Error ? cause.message.slice(0, 2000) : 'Callback failed' })
    this.record(diagnostic)
    if (this.options.onError) {
      try { await bounded(context => this.options.onError!(diagnostic, context), this.timeoutMs) }
      catch { this.record({ hook: 'onError', code: 'SWARM_HOOK_ERROR_HANDLER_FAILED', message: 'Error handler failed, timed out or was cancelled' }) }
    }
  }
  private record(value: HookDiagnostic) { this.diagnostics.push(value); if (this.diagnostics.length > 100) this.diagnostics.shift() }
}
