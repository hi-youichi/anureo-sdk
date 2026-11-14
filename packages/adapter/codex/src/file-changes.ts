/** Projects native file changes and supplied patch evidence without filesystem access. */
import type { FileChange } from '@anureo/protocol'
import { record } from './native-values'

/**
 * Project changes in native order for the tool snapshot's fileChanges field. Non-array input
 * produces an empty list, and entries without string paths are skipped. Preserve path spelling
 * and diff text verbatim. Completeness records whether native diff text was supplied.
 */
export function codexFileChanges(changes: unknown): FileChange[] {
  if (!Array.isArray(changes)) return []
  return changes.flatMap(projectFileChange)
}

/**
 * Emit one change for a string source path. Any string move destination replaces the path,
 * including an empty string. Only a nonempty destination records oldPath and establishes a rename.
 */
function projectFileChange(value: unknown): FileChange[] {
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
  }]
}

/** Mark supplied diff text as complete native evidence, including an empty patch. Missing text is partial. */
function fileChangeEvidence(patch: string | undefined): Pick<FileChange, 'materials' | 'completeness'> {
  return patch !== undefined
    ? { materials: [{ format: 'unified', patch }], completeness: 'complete' }
    : { materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' }
}

/** Use a nonempty move destination as rename evidence regardless of the reported operation. */
function fileChangeOperation({ operation, movePath }: { operation: unknown; movePath?: string }): FileChange['operation'] {
  if (movePath) return 'rename'
  switch (operation) {
    case 'add': return 'add'
    case 'delete': return 'delete'
    case 'update': return 'modify'
    default: return 'unknown'
  }
}
