import type { FileChange, Item } from '@anureo/protocol'
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

type StructuredPatchHunk = Record<string, unknown> & {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

function isPatchLine(line: unknown): line is string {
  return typeof line === 'string' && /^[ +\\-]/.test(line)
}

function isStructuredPatchHunk(hunk: Record<string, unknown>): hunk is StructuredPatchHunk {
  const hasValidRange = ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isInteger(hunk[key]) && (hunk[key] as number) >= 0)
  return hasValidRange && Array.isArray(hunk.lines) && hunk.lines.every(isPatchLine)
}

/** Tool inputs prove fragments, never whole-file creation or fragment line positions. */
export function claudeFileChanges(name: string, input: unknown, result?: unknown): FileChange[] | undefined {
  if (!['Edit', 'MultiEdit', 'Write'].includes(name)) return undefined
  const data = record(input), output = record(result)
  const path = typeof output.filePath === 'string' ? output.filePath : typeof data.file_path === 'string' ? data.file_path : undefined
  if (path === undefined) return []
  if (typeof output.patch === 'string') return [{ path, operation: 'modify', materials: [{ format: 'unified', patch: output.patch }], completeness: 'complete' }]
  if ((output.oldText === null || typeof output.oldText === 'string') && typeof output.newText === 'string') return [{ path, operation: output.oldText === null ? 'add' : 'modify', materials: [{ format: 'text', scope: 'file', oldText: output.oldText, newText: output.newText }], completeness: 'complete' }]
  // Pinned Claude SDK FileEditOutput / FileWriteOutput carry typed hunk arrays.
  if (Array.isArray(output.structuredPatch) && output.structuredPatch.length) {
    const hunks = output.structuredPatch.map(record)
    if (hunks.every(isStructuredPatchHunk)) {
      const patch = hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`).join('')
      return [{ path, operation: output.type === 'create' ? 'add' : 'modify', materials: [{ format: 'unified', patch }], completeness: 'complete' }]
    }
  }
  if (name === 'Write' && typeof output.content === 'string' && (typeof output.originalFile === 'string' || (output.type === 'create' && output.originalFile === null))) {
    return [{ path, operation: output.type === 'create' ? 'add' : 'modify', materials: [{ format: 'text', scope: 'file', oldText: output.originalFile as string | null, newText: output.content }], completeness: 'complete' }]
  }
  if (name === 'Write') return [{ path, operation: 'unknown', materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' }]
  const edits = name === 'MultiEdit' && Array.isArray(data.edits) ? data.edits : [data]
  const materials: FileChange['materials'] = edits.flatMap(value => {
    const edit = record(value)
    return typeof edit.old_string === 'string' && typeof edit.new_string === 'string' ? [{ format: 'text' as const, scope: 'fragment' as const, oldText: edit.old_string, newText: edit.new_string }] : []
  })
  // A result that only reports success cannot prove replacement count or independent edits.
  const partial = name === 'MultiEdit' || edits.some(value => record(value).replace_all === true) || materials.length !== edits.length
  return [{ path, operation: 'modify', materials: materials.length ? materials : [{ format: 'unavailable', reason: 'notProvided' }], completeness: partial || !materials.length ? 'partial' : 'complete' }]
}

export function completeClaudeTool(previous: Extract<Item, { type: 'toolCall' }>, block: Record<string, unknown>): Item {
  const fileChanges = claudeFileChanges(previous.nativeType ?? previous.title, previous.input, block.structuredContent ?? block.content)
  const previousFields = { ...previous }
  let status: typeof previous.status
  if (previous.status === 'declined' || previous.status === 'interrupted') {
    status = previous.status
  } else if (block.is_error) {
    status = 'failed'
  } else {
    status = 'completed'
  }
  return {
    ...previousFields,
    status,
    output: block.content as import('@anureo/protocol').JsonValue,
    ...(fileChanges !== undefined ? { fileChanges } : {}),
  }
}
