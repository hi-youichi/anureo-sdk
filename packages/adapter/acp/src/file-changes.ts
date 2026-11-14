import type { FileChange } from '@anureo/protocol'

/**
 * Convert valid ACP diff blocks to complete file-text materials without reading or writing files.
 * AcpUpdateMapper uses these for live tool snapshots; AcpBackendSession.extension enriches history
 * when fileChanges is absent. Non-array input and invalid/non-diff blocks contribute no changes:
 * text output remains execution output even when it resembles a patch. Missing/null oldText means
 * a new file, while an empty string is an existing file; newText must be a string, including empty.
 */
export function acpFileChanges(content: unknown): FileChange[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const part = value as Record<string, unknown>
    if (
      part.type !== 'diff' ||
      typeof part.path !== 'string' ||
      !(
        part.oldText === undefined ||
        part.oldText === null ||
        typeof part.oldText === 'string'
      ) ||
      typeof part.newText !== 'string'
    ) return []
    const oldText = part.oldText ?? null
    return [{ path: part.path, operation: oldText === null ? 'add' : 'modify', materials: [{ format: 'text', scope: 'file', oldText, newText: part.newText }], completeness: 'complete' } satisfies FileChange]
  })
}
