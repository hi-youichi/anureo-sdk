import type { FileChange, Item, JsonValue } from '@anureo/protocol'

export const FILE_CHANGE_MATERIAL_LIMIT = 50
export const FILE_CHANGE_TEXT_LIMIT = 256 * 1024

/** One budget covers canonical material and every retained input/output/raw mirror. */
export function boundFileChangeItem(item: Item): Item {
  if (item.type !== 'toolCall' || item.fileChanges === undefined) return item
  let bytes = FILE_CHANGE_TEXT_LIMIT, materials = 0, truncated = false
  const encoder = new TextEncoder()
  const take = (value: string): { value: string; complete: boolean } => {
    const encoded = encoder.encode(value)
    if (encoded.byteLength <= bytes) { bytes -= encoded.byteLength; return { value, complete: true } }
    // Keep only complete lines: a truncated hunk must never acquire fake validity.
    let prefix = new TextDecoder().decode(encoded.subarray(0, bytes))
    const end = prefix.lastIndexOf('\n')
    prefix = end < 0 ? '' : prefix.slice(0, end + 1)
    bytes -= encoder.encode(prefix).byteLength
    truncated = true
    return { value: prefix, complete: false }
  }
  const fileChanges: FileChange[] = item.fileChanges.map(change => {
    let partial = false
    const next: FileChange['materials'] = []
    for (const material of change.materials) {
      if (material.format === 'unavailable') { next.push(material); continue }
      if (++materials > FILE_CHANGE_MATERIAL_LIMIT) { partial = truncated = true; continue }
      if (material.format === 'unified') {
        const patch = take(material.patch); partial ||= !patch.complete
        next.push(patch.value ? { ...material, patch: patch.value } : { format: 'unavailable', reason: 'tooLarge' })
      } else {
        const oldText = material.oldText === null ? null : take(material.oldText)
        const newText = take(material.newText)
        if ((oldText !== null && !oldText.complete) || !newText.complete) {
          // Independently truncated sides do not describe a replacement. Preserve metadata only.
          partial = true; next.push({ format: 'unavailable', reason: 'tooLarge' })
        } else next.push({ ...material, oldText: oldText === null ? null : oldText.value, newText: newText.value })
      }
    }
    if (!next.length && change.materials.length) next.push({ format: 'unavailable', reason: 'tooLarge' })
    return { ...change, materials: next, ...(partial ? { completeness: 'partial', ...(change.stats ? { stats: { ...change.stats, accuracy: 'partial' } } : {}) } : {}) }
  })
  const mirror = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return take(value).value
    if (Array.isArray(value)) return value.map(mirror)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mirror(child)]))
    return value
  }
  const result = { ...item, fileChanges, ...(item.input !== undefined ? { input: mirror(item.input) } : {}), ...(item.output !== undefined ? { output: mirror(item.output) } : {}), ...(item.raw !== undefined ? { raw: mirror(item.raw) } : {}), ...(item.extensions ? { extensions: mirror(item.extensions) as import('@anureo/protocol').JsonObject } : {}) }
  if (truncated) result.extensions = { ...result.extensions, 'x-anureo/fileChangesTruncated': true }
  return result
}
