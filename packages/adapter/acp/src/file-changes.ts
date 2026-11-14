import type { FileChange } from '@anureo/protocol'

/**
 * Convert valid ACP diff blocks to complete file-text materials without reading or writing files.
 * The mapper includes them in live tool snapshots. AcpBackendSession.extension uses them
 * to fill absent fileChanges in history before validating the page. Retain valid diff blocks
 * in input order and ignore other content, including text that resembles a patch.
 * Missing or null oldText means a new file. Empty strings are valid file contents.
 */
export function acpFileChanges(content: unknown): FileChange[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const part = value as Record<string, unknown>
    if (part.type !== 'diff' || typeof part.path !== 'string') return []
    if (part.oldText !== undefined && part.oldText !== null && typeof part.oldText !== 'string') return []
    if (typeof part.newText !== 'string') return []

    const oldText = part.oldText ?? null
    return [{
      path: part.path,
      operation: oldText === null ? 'add' : 'modify',
      materials: [{ format: 'text', scope: 'file', oldText, newText: part.newText }],
      completeness: 'complete',
    } satisfies FileChange]
  })
}
