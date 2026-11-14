import type { FileChange } from '@anureo/protocol'

/**
 * Convert valid ACP diff blocks to complete file-text materials without reading or writing files.
 * AcpBackendSession.extension uses this to fill absent fileChanges in history before validating
 * the page. Retain valid diff blocks in input order and ignore other content.
 */
export function acpFileChanges(content: unknown): FileChange[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(value => {
    const change = diffFileChange(value)
    return change ? [change] : []
  })
}

/** Keep accepted diff text in canonical materials and preserve block order in the fallback output. */
export function projectAcpToolContent(content: unknown): { fileChanges: FileChange[]; output: unknown } {
  const fileChanges: FileChange[] = []
  const output = Array.isArray(content) ? content.map(value => {
    const change = diffFileChange(value)
    if (!change) return value
    fileChanges.push(change)
    return { type: 'diff', path: change.path }
  }) : content
  return { fileChanges, output }
}

/** Missing or null oldText means a new file. Empty strings are valid file contents. */
function diffFileChange(value: unknown): FileChange | undefined {
  if (!value || typeof value !== 'object') return
  const part = value as Record<string, unknown>
  if (part.type !== 'diff' || typeof part.path !== 'string') return
  if (part.oldText != null && typeof part.oldText !== 'string') return
  if (typeof part.newText !== 'string') return

  const oldText = part.oldText ?? null
  return {
    path: part.path,
    operation: oldText === null ? 'add' : 'modify',
    materials: [{ format: 'text', scope: 'file', oldText, newText: part.newText }],
    completeness: 'complete',
  }
}
