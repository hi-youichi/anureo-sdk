import { expect, test } from 'bun:test'
import { claudeFileChanges, completeClaudeTool } from './file-changes'

test('Claude edits are fragments without invented positions, with partial repeated replacements', () => {
  expect(claudeFileChanges('Edit', { file_path: 'a', old_string: 'a', new_string: 'b' })).toMatchObject([{ operation: 'modify', completeness: 'complete', materials: [{ format: 'text', scope: 'fragment', oldText: 'a', newText: 'b' }] }])
  const multi = claudeFileChanges('MultiEdit', { file_path: 'a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }] })![0]!
  expect(multi.materials).toHaveLength(2)
  expect(multi.completeness).toBe('partial')
  expect(claudeFileChanges('Edit', { file_path: 'a', old_string: 'a', new_string: 'b', replace_all: true })![0]!.completeness).toBe('partial')
})

test('Write input alone cannot prove new-file creation; structured result is preferred', () => {
  expect(claudeFileChanges('Write', { file_path: 'a', content: 'contents' })).toMatchObject([{ operation: 'unknown', completeness: 'partial', materials: [{ format: 'unavailable' }] }])
  expect(claudeFileChanges('Write', { file_path: 'a', content: 'contents' }, { oldText: '', newText: 'contents' })).toMatchObject([{ operation: 'modify', materials: [{ oldText: '' }] }])
})

test('running Claude tools fail when is_error is true and complete when it is absent', () => {
  const previous = { id: 'edit', type: 'toolCall' as const, kind: 'fileChange' as const, title: 'Edit', nativeType: 'Edit', input: { file_path: 'a', old_string: 'old', new_string: 'new' }, status: 'running' as const }
  expect(completeClaudeTool(previous, { is_error: true, content: 'failed' })).toMatchObject({ status: 'failed' })
  expect(completeClaudeTool(previous, { content: 'ok' })).toMatchObject({ status: 'completed' })
})


test('pinned SDK structured hunks prove replacement positions; Write null on update never proves creation', () => {
  const result = claudeFileChanges('Edit', { file_path: 'a', old_string: 'a', new_string: 'b', replace_all: true }, { filePath: 'a', structuredPatch: [{ oldStart: 57, oldLines: 1, newStart: 57, newLines: 1, lines: ['-a', '+b'] }] })![0]!
  expect(result).toMatchObject({ completeness: 'complete', materials: [{ patch: '@@ -57,1 +57,1 @@\n-a\n+b\n' }] })
  expect(claudeFileChanges('Write', { file_path: 'a' }, { type: 'update', filePath: 'a', originalFile: null, content: 'large update', structuredPatch: [] })![0]!.operation).toBe('unknown')
  expect(claudeFileChanges('Write', { file_path: 'a' }, { type: 'create', filePath: 'a', originalFile: null, content: 'created', structuredPatch: [] })).toMatchObject([{ operation: 'add', materials: [{ scope: 'file', oldText: null }] }])
})

test('structured hunks without diff markers cannot prove positions and fall back to text', () => {
  const result = claudeFileChanges('Edit', { file_path: 'a', old_string: 'old', new_string: 'new' }, { filePath: 'a', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['unprefixed'] }] })![0]!
  expect(result.completeness).toBe('complete')
  expect(result.materials).toMatchObject([{ format: 'text', scope: 'fragment', oldText: 'old', newText: 'new' }])
})

test('file evidence keeps result precedence and distinguishes unsupported tools from missing paths', () => {
  expect(claudeFileChanges('Bash', { file_path: 'input' })).toBeUndefined()
  expect(claudeFileChanges('Edit', {})).toEqual([])
  expect(claudeFileChanges('Write', { file_path: 'input' }, {
    filePath: 'output', patch: '', oldText: null, newText: 'new',
    type: 'create', content: 'contents', originalFile: null,
    structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }],
  })).toEqual([{ path: 'output', operation: 'modify', materials: [{ format: 'unified', patch: '' }], completeness: 'complete' }])
})

test.each(['declined', 'interrupted'] as const)('tool results preserve %s status and prefer structured evidence', status => {
  const previous = { id: 'write', type: 'toolCall' as const, kind: 'fileChange' as const, title: 'Write', input: { file_path: 'a' }, status }
  const content = { patch: 'less authoritative' }
  const item = completeClaudeTool(previous, { is_error: true, content, structuredContent: { oldText: null, newText: 'created' } })
  expect(item).toMatchObject({ status, output: content, fileChanges: [{ operation: 'add', materials: [{ scope: 'file', oldText: null, newText: 'created' }] }] })
  expect(previous).toEqual({ id: 'write', type: 'toolCall', kind: 'fileChange', title: 'Write', input: { file_path: 'a' }, status })
})
