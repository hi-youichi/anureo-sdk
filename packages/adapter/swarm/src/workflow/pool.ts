// Pooled workflow bees: same route/model/instructions reuse one bee (and its member session).
import { createHash } from 'node:crypto'
import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { MemberBackend } from '../models'

export interface WorkflowBeeSpec {
  role: string
  name: string
  model?: string
  instructions?: string
}

export interface WorkflowBeeLease {
  readonly beeId: string
  readonly poolKey: string
  /** Return the bee to the pool, or close it when the pool is already closing. */
  release(): void
}

export interface WorkflowPoolHost {
  createBee(spec: WorkflowBeeSpec): Promise<string>
  closeBee(beeId: string): Promise<void>
  /** Versioned signal touched on every bee create/close. */
  beeSlots: { current(): number; waitAfter(observed: number, timeoutMs: number, signal?: AbortSignal): Promise<'changed' | 'timeout'> }
}

/** Stable pool identity: backend route, requested model, and step instructions. */
export function poolKeyFor(backend: MemberBackend, model: string | undefined, instructions: string | undefined): string {
  const identity = 'client' in backend && backend.client ? backend.client.identity : undefined
  return createHash('sha256').update(JSON.stringify([
    backend.route,
    identity ? [identity.adapterId, identity.runtimeConfigId] : null,
    model ?? null,
    instructions ?? null,
  ])).digest('hex')
}

const turnEnded = () => new HarnessSdkError('SWARM_WORKFLOW_TURN_ENDED', 'The outer turn ended; queued workflow steps were cancelled')

/**
 * One pool per outer turn. Idle bees are reused for steps with an identical
 * pool key; SWARM_BEE_LIMIT waits on the bee slot signal instead of failing.
 */
export class WorkflowPool {
  private readonly idle = new Map<string, string[]>()
  private closed = false

  constructor(private readonly host: WorkflowPoolHost) {}

  async acquire(spec: WorkflowBeeSpec, poolKey: string, backend: MemberBackend, signal: AbortSignal): Promise<WorkflowBeeLease> {
    void backend
    while (!this.closed && !signal.aborted) {
      const free = this.idle.get(poolKey)
      const beeId = free?.pop()
      if (beeId) return this.lease(beeId, poolKey)
      try {
        return this.lease(await this.host.createBee(spec), poolKey)
      } catch (cause) {
        if (sdkError(cause).code !== 'SWARM_BEE_LIMIT') throw cause
      }
      const observed = this.host.beeSlots.current()
      await this.host.beeSlots.waitAfter(observed, 1000, signal).catch(() => 'timeout' as const)
    }
    throw turnEnded()
  }

  private lease(beeId: string, poolKey: string): WorkflowBeeLease {
    let released = false
    return {
      beeId,
      poolKey,
      release: () => {
        if (released) return
        released = true
        if (this.closed) { void this.host.closeBee(beeId).catch(() => {}) }
        else {
          const free = this.idle.get(poolKey) ?? []
          free.push(beeId)
          this.idle.set(poolKey, free)
        }
      },
    }
  }

  /** Close idle bees; busy bees close through their lease release. */
  async settle(): Promise<void> {
    this.closed = true
    const idle = [...this.idle.values()].flat()
    this.idle.clear()
    await Promise.allSettled(idle.map(beeId => this.host.closeBee(beeId)))
  }
}
