/** Projects native file-change provenance without filesystem access; patch inference and application belong elsewhere. */
import type { FileChange } from '@anureo/protocol'
import { record } from './native-values'

/**
 * Return native-order changes for mapItems' file-change tool snapshots, skipping entries without
 * string paths. Preserve path spelling and supplied diff text, including empty strings; complete
 * means diff text was supplied, not that it was parsed or verified. A string move destination
 * replaces path even when empty, but only a nonempty destination sets oldPath and forces rename.
 * Non-array input produces no changes. No I/O, patch inference or input mutation.
 */
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
        ...fileChangeEvidence(patch),
      } satisfies FileChange]
    },
  )
}

/** Keep codexFileChanges material availability and completeness consistent; even an empty supplied diff is complete native evidence. No patch parsing or synthesis. */
function fileChangeEvidence(patch: string | undefined): Pick<FileChange, 'materials' | 'completeness'> {
  return patch !== undefined
    ? { materials: [{ format: 'unified', patch }], completeness: 'complete' }
    : { materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' }
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
