import type { FileChange, Item } from '@anureo/protocol'

/** Project Edit/MultiEdit/Write evidence without reading files or inventing positions.
 * ClaudeBackendSession.blockItem uses input evidence for live/history calls; completeClaudeTool
 * prefers result evidence when available. Return undefined for other tools, [] for a missing path,
 * and otherwise one change. A result filePath wins over input file_path; input-only edits prove
 * fragments, while input-only Write cannot prove creation or complete file contents. */
export function claudeFileChanges(name: string, input: unknown, result?: unknown): FileChange[] | undefined {
  if (!['Edit', 'MultiEdit', 'Write'].includes(name)) return undefined
  const data = record(input), output = record(result)
  const path = typeof output.filePath === 'string' ? output.filePath : typeof data.file_path === 'string' ? data.file_path : undefined
  if (path === undefined) return []
  return [resultFileChange(path, name, output) ?? inputFileChange(path, name, data)]
}

/** Merge a normalized native tool result without mutating the previous item.
 * ClaudeBackendSession.mapMessage publishes the returned item as completed; projectHistory replaces
 * an earlier call with it. Declined/interrupted statuses survive later results, even error results;
 * other calls fail on truthy is_error and complete otherwise. structuredContent takes precedence
 * for file evidence, while content remains the visible output. */
export function completeClaudeTool(previous: Extract<Item, { type: 'toolCall' }>, block: Record<string, unknown>): Item {
  const fileChanges = claudeFileChanges(previous.nativeType ?? previous.title, previous.input, block.structuredContent ?? block.content)
  let status: typeof previous.status
  if (previous.status === 'declined' || previous.status === 'interrupted') {
    status = previous.status
  } else if (block.is_error) {
    status = 'failed'
  } else {
    status = 'completed'
  }
  return {
    ...previous,
    status,
    output: block.content as import('@anureo/protocol').JsonValue,
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

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Prefer complete native material in order: raw patch, file text, typed hunks, then Write output. */
function resultFileChange(path: string, name: string, output: Record<string, unknown>): FileChange | undefined {
  if (typeof output.patch === 'string') {
    return { path, operation: 'modify', materials: [{ format: 'unified', patch: output.patch }], completeness: 'complete' }
  }
  if ((output.oldText === null || typeof output.oldText === 'string') && typeof output.newText === 'string') {
    return { path, operation: output.oldText === null ? 'add' : 'modify', materials: [{ format: 'text', scope: 'file', oldText: output.oldText, newText: output.newText }], completeness: 'complete' }
  }
  const patch = structuredPatch(output.structuredPatch)
  if (patch !== undefined) {
    return { path, operation: output.type === 'create' ? 'add' : 'modify', materials: [{ format: 'unified', patch }], completeness: 'complete' }
  }
  if (name === 'Write' && typeof output.content === 'string' && (typeof output.originalFile === 'string' || (output.type === 'create' && output.originalFile === null))) {
    return { path, operation: output.type === 'create' ? 'add' : 'modify', materials: [{ format: 'text', scope: 'file', oldText: output.originalFile as string | null, newText: output.content }], completeness: 'complete' }
  }
  return undefined
}

/** Fall back to input fragments, marking uncertain replacement counts and missing material partial. */
function inputFileChange(path: string, name: string, data: Record<string, unknown>): FileChange {
  if (name === 'Write') return { path, operation: 'unknown', materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' }
  const edits = name === 'MultiEdit' && Array.isArray(data.edits) ? data.edits : [data]
  const materials: FileChange['materials'] = edits.flatMap(value => {
    const edit = record(value)
    return typeof edit.old_string === 'string' && typeof edit.new_string === 'string' ? [{ format: 'text' as const, scope: 'fragment' as const, oldText: edit.old_string, newText: edit.new_string }] : []
  })
  // A result that only reports success cannot prove replacement count or independent edits.
  const partial = name === 'MultiEdit' || edits.some(value => record(value).replace_all === true) || materials.length !== edits.length
  return { path, operation: 'modify', materials: materials.length ? materials : [{ format: 'unavailable', reason: 'notProvided' }], completeness: partial || !materials.length ? 'partial' : 'complete' }
}

/** Render only nonempty, fully validated pinned-SDK hunk arrays; otherwise allow input fallback. */
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

/** Reject incomplete ranges or unmarked lines before treating a native hunk as positioned evidence. */
function isStructuredPatchHunk(hunk: Record<string, unknown>): hunk is StructuredPatchHunk {
  const hasValidRange = ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isInteger(hunk[key]) && (hunk[key] as number) >= 0)
  return hasValidRange && Array.isArray(hunk.lines) && hunk.lines.every(isPatchLine)
}
