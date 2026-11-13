// Bounds retained file-change material and mirrors; must not redact secrets or interpret patch validity.
import type { FileChange, Item, JsonValue } from '@anureo/protocol'

/** Maximum retained available materials across one tool-call item; excess material becomes unavailable metadata. */
export const FILE_CHANGE_MATERIAL_LIMIT = 50
/** UTF-8 byte budget shared by canonical change material and all mirrors within one item. */
export const FILE_CHANGE_TEXT_LIMIT = 256 * 1024

interface RetentionBudget {
  bytes: number
  materials: number
  truncated: boolean
  encoder: TextEncoder
}

interface TakenText {
  value: string
  complete: boolean
}

/** Create per-item retention state; canonical material must consume it before mirrors to preserve source priority. */
function createRetentionBudget(): RetentionBudget {
  return { bytes: FILE_CHANGE_TEXT_LIMIT, materials: 0, truncated: false, encoder: new TextEncoder() }
}

/** Consume UTF-8 bytes from the item budget; on overflow retain whole lines so a partial hunk cannot look authoritative. */
function takeText(budget: RetentionBudget, value: string): TakenText {
  const encoded = budget.encoder.encode(value)
  if (encoded.byteLength <= budget.bytes) {
    budget.bytes -= encoded.byteLength
    return { value, complete: true }
  }
  let prefix = new TextDecoder().decode(encoded.subarray(0, budget.bytes))
  const end = prefix.lastIndexOf('\n')
  prefix = end < 0 ? '' : prefix.slice(0, end + 1)
  budget.bytes -= budget.encoder.encode(prefix).byteLength
  budget.truncated = true
  return { value: prefix, complete: false }
}

/** Bound each change in order using the shared material count and text budget; mark replacement material partial if either side is incomplete. */
function boundChanges(changes: FileChange[], budget: RetentionBudget): FileChange[] {
  return changes.map(change => {
    let partial = false
    const next: FileChange['materials'] = []
    for (const material of change.materials) {
      if (material.format === 'unavailable') { next.push(material); continue }
      if (++budget.materials > FILE_CHANGE_MATERIAL_LIMIT) { partial = budget.truncated = true; continue }
      if (material.format === 'unified') {
        const patch = takeText(budget, material.patch); partial ||= !patch.complete
        next.push(patch.value ? { ...material, patch: patch.value } : { format: 'unavailable', reason: 'tooLarge' })
      } else {
        const oldText = material.oldText === null ? null : takeText(budget, material.oldText)
        const newText = takeText(budget, material.newText)
        if ((oldText !== null && !oldText.complete) || !newText.complete) {
          partial = true; next.push({ format: 'unavailable', reason: 'tooLarge' })
        } else next.push({ ...material, oldText: oldText === null ? null : oldText.value, newText: newText.value })
      }
    }
    if (!next.length && change.materials.length) next.push({ format: 'unavailable', reason: 'tooLarge' })
    return { ...change, materials: next, ...(partial ? { completeness: 'partial', ...(change.stats ? { stats: { ...change.stats, accuracy: 'partial' } } : {}) } : {}) }
  })
}

/** Consume the remaining budget in mirrors without changing their JSON shape; traversal order defines which strings are retained. */
function boundMirror(value: JsonValue, budget: RetentionBudget): JsonValue {
  if (typeof value === 'string') return takeText(budget, value).value
  if (Array.isArray(value)) return value.map(entry => boundMirror(entry, budget))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, boundMirror(child, budget)]))
  return value
}

/** Return a bounded copy of a file-change tool item, or the original unrelated item; preserve metadata while marking incomplete material. Canonical material consumes the shared byte budget before mirrors. No file I/O occurs. */
export function boundFileChangeItem(item: Item): Item {
  if (item.type !== 'toolCall' || item.fileChanges === undefined) return item
  const budget = createRetentionBudget()
  const fileChanges = boundChanges(item.fileChanges, budget)
  const result = { ...item, fileChanges, ...(item.input !== undefined ? { input: boundMirror(item.input, budget) } : {}), ...(item.output !== undefined ? { output: boundMirror(item.output, budget) } : {}), ...(item.raw !== undefined ? { raw: boundMirror(item.raw, budget) } : {}), ...(item.extensions ? { extensions: boundMirror(item.extensions, budget) as import('@anureo/protocol').JsonObject } : {}) }
  if (budget.truncated) result.extensions = { ...result.extensions, 'x-anureo/fileChangesTruncated': true }
  return result
}
