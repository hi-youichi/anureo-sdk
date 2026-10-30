import type { FileChange } from '@anureo/protocol'
import { record } from './jsonl'

/** Native FileUpdateChange paths describe the source; move_path is the destination. */
export function codexFileChanges(changes: unknown): FileChange[] {
  if (!Array.isArray(changes)) return []
  return changes.flatMap(value => {
    const change = record(value)
    if (typeof change.path !== 'string') return []
    const kind = record(change.kind)
    const operation = kind.type ?? change.kind
    const movePath = typeof kind.move_path === 'string' ? kind.move_path : undefined
    const patch = typeof change.diff === 'string' ? change.diff : undefined
    return [{ path: movePath ?? change.path, ...(movePath ? { oldPath: change.path } : {}), operation: movePath ? 'rename' : operation === 'add' ? 'add' : operation === 'delete' ? 'delete' : operation === 'update' ? 'modify' : 'unknown', materials: patch !== undefined ? [{ format: 'unified', patch }] : [{ format: 'unavailable', reason: 'notProvided' }], completeness: patch !== undefined ? 'complete' : 'partial' } satisfies FileChange]
  })
}
