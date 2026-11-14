import type { FileChange, Item, JsonValue } from '@anureo/protocol'

/**
 * Project native Edit, MultiEdit and Write payloads into file evidence using only the supplied data.
 * Return undefined for other tools, an empty array when neither payload supplies a string path,
 * or one change. Prefer result.filePath over input.file_path and fall back to input evidence
 * when the result supplies no usable material.
 * ClaudeBackendSession.blockItem attaches input evidence to live and history items.
 * completeClaudeTool projects evidence again when a matching native result arrives.
 */
export function claudeFileChanges(name: string, input: unknown, result?: unknown): FileChange[] | undefined {
  if (!['Edit', 'MultiEdit', 'Write'].includes(name)) return undefined
  const data = record(input)
  const output = record(result)
  const path = typeof output.filePath === 'string'
    ? output.filePath
    : typeof data.file_path === 'string' ? data.file_path : undefined
  if (path === undefined) return []
  return [resultFileChange(path, name, output) ?? inputFileChange(path, name, data)]
}

/**
 * Return a new tool item from an earlier call and its matching native result. The caller supplies
 * JSON-normalized and privacy-projected content. The item exposes content as output and uses
 * structuredContent for file evidence when it is non-nullish, otherwise using content.
 * Declined and interrupted statuses survive later results. Other calls fail on truthy is_error
 * and complete otherwise.
 * ClaudeBackendSession.mapMessage stores and emits the item as item/completed, and projectHistory
 * replaces the earlier call's item in the history snapshot.
 */
export function completeClaudeTool(previous: Extract<Item, { type: 'toolCall' }>, block: Record<string, unknown>): Item {
  const name = previous.nativeType ?? previous.title
  const fileChanges = claudeFileChanges(name, previous.input, block.structuredContent ?? block.content)
  let status = previous.status
  if (status !== 'declined' && status !== 'interrupted') {
    status = block.is_error ? 'failed' : 'completed'
  }
  return {
    ...previous,
    status,
    output: block.content as JsonValue,
    ...(fileChanges !== undefined ? { fileChanges } : {}),
  }
}

type StructuredPatchHunk = Record<string, unknown> & {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Try raw patch, whole-file text, structured hunks and Write output in that order before falling back to input. */
function resultFileChange(path: string, name: string, output: Record<string, unknown>): FileChange | undefined {
  if (typeof output.patch === 'string') {
    return { path, operation: 'modify', materials: [{ format: 'unified', patch: output.patch }], completeness: 'complete' }
  }
  if ((output.oldText === null || typeof output.oldText === 'string') && typeof output.newText === 'string') {
    return {
      path,
      operation: output.oldText === null ? 'add' : 'modify',
      materials: [{ format: 'text', scope: 'file', oldText: output.oldText, newText: output.newText }],
      completeness: 'complete',
    }
  }
  const patch = structuredPatch(output.structuredPatch)
  if (patch !== undefined) {
    return { path, operation: output.type === 'create' ? 'add' : 'modify', materials: [{ format: 'unified', patch }], completeness: 'complete' }
  }
  if (name !== 'Write' || typeof output.content !== 'string') return undefined

  // An update can omit the original text. Null is evidence of an absent file only for create.
  const originalFile = output.originalFile
  const created = output.type === 'create'
  if (typeof originalFile !== 'string' && !(created && originalFile === null)) return undefined
  return {
    path,
    operation: created ? 'add' : 'modify',
    materials: [{ format: 'text', scope: 'file', oldText: originalFile, newText: output.content }],
    completeness: 'complete',
  }
}

/**
 * Preserve Edit and MultiEdit input fragments in request order. Only a single Edit with both
 * fragments and no replace_all flag set to true is complete evidence. Write input alone leaves
 * the operation and material unknown because it does not establish the prior state of the file.
 */
function inputFileChange(path: string, name: string, data: Record<string, unknown>): FileChange {
  if (name === 'Write') {
    return { path, operation: 'unknown', materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' }
  }
  const edits = name === 'MultiEdit' && Array.isArray(data.edits) ? data.edits : [data]
  const materials = edits.flatMap<FileChange['materials'][number]>(value => {
    const edit = record(value)
    if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return []
    return [{ format: 'text', scope: 'fragment', oldText: edit.old_string, newText: edit.new_string }]
  })
  // A result that only reports success cannot prove replacement count or independent edits.
  const partial = name === 'MultiEdit'
    || edits.some(value => record(value).replace_all === true)
    || materials.length !== edits.length
  return {
    path,
    operation: 'modify',
    materials: materials.length ? materials : [{ format: 'unavailable', reason: 'notProvided' }],
    completeness: partial || !materials.length ? 'partial' : 'complete',
  }
}

/** Render a nonempty pinned-SDK hunk array in native order after checking its hunk shapes. */
function structuredPatch(value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.length) return undefined
  const hunks = value.map(record)
  if (!hunks.every(isStructuredPatchHunk)) return undefined
  return hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`).join('')
}

/** Accept diff markers, including the backslash marker for a missing final newline. */
function isPatchLine(line: unknown): line is string {
  return typeof line === 'string' && /^[ +\\-]/.test(line)
}

/** Require nonnegative integer range fields and diff markers before using native positions. */
function isStructuredPatchHunk(hunk: Record<string, unknown>): hunk is StructuredPatchHunk {
  const hasValidRange = ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isInteger(hunk[key]) && (hunk[key] as number) >= 0)
  return hasValidRange && Array.isArray(hunk.lines) && hunk.lines.every(isPatchLine)
}
