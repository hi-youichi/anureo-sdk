/** Projects native file-change provenance without filesystem access; patch inference and application belong elsewhere. */
import type { FileChange } from '@anureo/protocol'
import { record } from './native-values'

/** For item mapping, return changes in native order, skipping entries without string paths. Source paths and move destinations retain native spelling; missing diff text stays unavailable. No I/O, patch parsing or input mutation. */
export function codexFileChanges(changes: unknown): FileChange[] {
  if (!Array.isArray(changes)) return []
  return changes.flatMap(
    /** Project a supplied change only; even empty diff text is native material, not a reason to synthesize a patch. */
    value => {
      const change = record(value)
      if (typeof change.path !== 'string') return []
      const kind = record(change.kind)
      const operation = kind.type ?? change.kind
      const movePath = typeof kind.move_path === 'string' ? kind.move_path : undefined
      const patch = typeof change.diff === 'string' ? change.diff : undefined
      return [{
        path: movePath ?? change.path,
        ...(movePath ? { oldPath: change.path } : {}),
        operation: fileChangeOperation({ operation, movePath }),
        materials: patch !== undefined
          ? [{ format: 'unified', patch }]
          : [{ format: 'unavailable', reason: 'notProvided' }],
        completeness: patch !== undefined ? 'complete' : 'partial',
      } satisfies FileChange]
    },
  )
}

/** Normalize operation evidence for codexFileChanges without effects; a nonempty move destination takes precedence over even an unknown native operation. */
function fileChangeOperation({ operation, movePath }: { operation: unknown; movePath?: string }): FileChange['operation'] {
  if (movePath) return 'rename'
  switch (operation) {
    case 'add': return 'add'
    case 'delete': return 'delete'
    case 'update': return 'modify'
    default: return 'unknown'
  }
}
