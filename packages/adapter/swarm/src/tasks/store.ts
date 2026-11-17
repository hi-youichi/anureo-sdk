import { HarnessSdkError, type TurnResult } from '@anureo/sdk'
import { ChangeSignal } from '../coordination/change-signal'

export type TaskPhase = 'accepted' | 'preparing' | 'starting' | 'running' | 'stopping' | 'settling' | 'terminal'
export interface StoredTask {
  id: string
  turnId: string
  state: 'running' | TurnResult['status']
  phase: TaskPhase
  done: Promise<void>
}

/** Owns current-turn admission and bounded history. All mutations before native dispatch are synchronous. */
export class TaskStore<T extends StoredTask> {
  readonly changes = new ChangeSignal()
  private readonly records = new Map<string, T>()
  private readonly currentIds = new Set<string>()
  private readonly pins = new Map<string, number>()
  private readonly turns: string[] = []
  private turnId?: string
  private count = 0
  private waiters = 0

  constructor(private readonly limits: { maxConcurrentTasks: number; maxTasksPerTurn: number },
    private readonly evict: (task: T) => void, private readonly historyTurns = 8, private readonly historyTasks = 128,
    private readonly archive: (task: T) => void = () => {}) {}

  begin(turnId: string) {
    if ([...this.values()].some(task => task.state === 'running')) throw new HarnessSdkError('SESSION_BUSY')
    for (const task of this.values()) this.archive(task)
    if (this.turnId) this.turns.push(this.turnId)
    this.turnId = turnId
    this.count = 0
    this.currentIds.clear()
    this.trim()
  }

  checkCapacity() {
    if (this.count >= this.limits.maxTasksPerTurn || [...this.values()].filter(task => task.state === 'running').length >= this.limits.maxConcurrentTasks) {
      throw new HarnessSdkError('SWARM_TASK_LIMIT')
    }
  }

  add(task: T) {
    this.checkCapacity()
    if (task.turnId !== this.turnId || this.records.has(task.id)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
    this.records.set(task.id, task)
    this.currentIds.add(task.id)
    this.count++
  }

  get(id: string) { return this.records.get(id) }
  *values() { for (const id of this.currentIds) yield this.records.get(id)! }
  list(history = false) { return history ? [...this.records.values()] : [...this.values()] }

  async wait(ids: readonly string[], mode: 'any' | 'all', timeoutMs: number, signal?: AbortSignal) {
    if (this.waiters >= 16) throw new HarnessSdkError('SWARM_WAITER_LIMIT')
    const tasks = ids.map(id => { const task = this.records.get(id); if (!task) throw new HarnessSdkError('SWARM_UNKNOWN_TASK'); return task })
    this.waiters++
    for (const task of tasks) this.pins.set(task.id, (this.pins.get(task.id) ?? 0) + 1)
    const deadline = performance.now() + timeoutMs
    try {
      while (true) {
        if (signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED')
        const version = this.changes.current()
        const finished = tasks.map(task => task.phase === 'terminal')
        const terminal = mode === 'any' ? finished.some(Boolean) : finished.every(Boolean)
        const remaining = Math.max(0, deadline - performance.now())
        if (terminal || !remaining) return { tasks, timedOut: !terminal }
        await this.changes.waitAfter(version, remaining, signal)
      }
    } finally {
      this.waiters--
      for (const task of tasks) {
        const remaining = this.pins.get(task.id)! - 1
        if (remaining) this.pins.set(task.id, remaining)
        else this.pins.delete(task.id)
      }
    }
  }

  close() { this.changes.close() }

  private trim() {
    const retainedTurns = new Set(this.turns.slice(-this.historyTurns))
    let historical = this.records.size
    for (const [id, task] of this.records) {
      if (this.pins.has(id) || task.phase !== 'terminal') continue
      if (!retainedTurns.has(task.turnId) || historical > this.historyTasks) {
        this.records.delete(id)
        historical--
        this.evict(task)
      }
    }
    this.turns.splice(0, Math.max(0, this.turns.length - this.historyTurns))
  }
}
