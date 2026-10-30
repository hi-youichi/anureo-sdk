import type { FileChange } from '@anureo/protocol'

/** Only ACP's typed diff blocks are source material. Text output is execution output. */
export function acpFileChanges(content: unknown): FileChange[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const part = value as Record<string, unknown>
    if (part.type !== 'diff' || typeof part.path !== 'string' || !(part.oldText === undefined || part.oldText === null || typeof part.oldText === 'string') || typeof part.newText !== 'string') return []
    const oldText = part.oldText ?? null
    return [{ path: part.path, operation: oldText === null ? 'add' : 'modify', materials: [{ format: 'text', scope: 'file', oldText, newText: part.newText }], completeness: 'complete' } satisfies FileChange]
  })
}
