// Owns package-internal retention of canonical file-change material and its JSON mirrors.
import type { FileChange, Item, JsonObject, JsonValue } from '@anureo/protocol'

/**
 * boundMaterial caps available materials across every file in one tool-call item. Existing
 * unavailable metadata does not consume this count; excess available materials are omitted.
 */
export const FILE_CHANGE_MATERIAL_LIMIT = 50
/**
 * Per-item UTF-8 text budget used by boundFileChangeItem.
 * Canonical material reserves bytes before mirrors; JSON keys and item metadata are outside the cap.
 */
export const FILE_CHANGE_TEXT_LIMIT = 256 * 1024

/**
 * Bound a tool call's file-change evidence without mutating the input. Items without fileChanges
 * and non-tool items pass through by identity. Canonical material consumes the shared byte budget
 * before input, output, raw and extensions, in that order. Overflow sets x-anureo/fileChangesTruncated.
 * Only loss of canonical material downgrades a change's completeness and existing stat accuracy.
 * SecretRedactor.toolCall calls this after redaction, so live events and history get the same
 * retention rules. Callers own protocol validation and publication.
 */
export function boundFileChangeItem(item: Item): Item {
  if (item.type !== 'toolCall' || item.fileChanges === undefined) return item
  const budget: RetentionBudget = {
    bytes: FILE_CHANGE_TEXT_LIMIT,
    materials: 0,
    truncated: false,
    encoder: new TextEncoder(),
  }
  const fileChanges = item.fileChanges.map(change => boundChange(change, budget))
  const result = { ...item, fileChanges }
  if (item.input !== undefined) result.input = boundMirror(item.input, budget)
  if (item.output !== undefined) result.output = boundMirror(item.output, budget)
  if (item.raw !== undefined) result.raw = boundMirror(item.raw, budget)
  if (item.extensions) result.extensions = boundMirror(item.extensions, budget) as JsonObject
  if (budget.truncated) result.extensions = { ...result.extensions, 'x-anureo/fileChangesTruncated': true }
  return result
}

/** boundFileChangeItem owns these per-pass counters; boundMaterial and boundMirror consume them in order. */
interface RetentionBudget {
  /** Remaining UTF-8 bytes; discarded replacement sides still reserve the text they consumed. */
  bytes: number
  /** Number of available materials visited, including materials omitted after the count limit. */
  materials: number
  /** Sticky flag used to mark the item's extensions when either retention cap was exceeded. */
  truncated: boolean
  encoder: TextEncoder
}

/** takeText returns a retained prefix; boundMaterial uses completeness to avoid authoritative partial replacements. */
interface TakenText {
  value: string
  /** Whether all source text fit; an empty retained prefix can also represent overflow. */
  complete: boolean
}

/**
 * boundMaterial and boundMirror use this shared accounting rather than independent budgets. Return
 * text within the remaining UTF-8 allowance and debit it. Overflow sets the sticky truncation flag
 * and keeps only complete newline-terminated lines, dropping any split UTF-8 character with its line.
 * Debit only the retained prefix, leaving unused bytes available to later material or mirrors.
 */
function takeText(budget: RetentionBudget, value: string): TakenText {
  const encoded = budget.encoder.encode(value)
  if (encoded.byteLength <= budget.bytes) {
    budget.bytes -= encoded.byteLength
    return { value, complete: true }
  }
  const decoded = new TextDecoder().decode(encoded.subarray(0, budget.bytes))
  const prefix = decoded.slice(0, decoded.lastIndexOf('\n') + 1)
  budget.bytes -= budget.encoder.encode(prefix).byteLength
  budget.truncated = true
  return { value: prefix, complete: false }
}

/**
 * boundChange calls this in source order with the item-wide budget. Return retained material and a
 * partial flag, omitting material beyond the count cap. An empty retained patch becomes unavailable.
 * Replacement sides must both fit to remain usable. Their consumed bytes stay reserved even when
 * the replacement becomes unavailable metadata.
 */
function boundMaterial(material: FileChange['materials'][number], budget: RetentionBudget): {
  material?: FileChange['materials'][number]
  partial: boolean
} {
  if (material.format === 'unavailable') return { material, partial: false }
  if (++budget.materials > FILE_CHANGE_MATERIAL_LIMIT) {
    budget.truncated = true
    return { partial: true }
  }
  if (material.format === 'unified') {
    const patch = takeText(budget, material.patch)
    return {
      material: patch.value ? { ...material, patch: patch.value } : { format: 'unavailable', reason: 'tooLarge' },
      partial: !patch.complete,
    }
  }
  const oldText = material.oldText === null ? null : takeText(budget, material.oldText)
  const newText = takeText(budget, material.newText)
  if ((oldText !== null && !oldText.complete) || !newText.complete) {
    return { material: { format: 'unavailable', reason: 'tooLarge' }, partial: true }
  }
  return { material: { ...material, oldText: oldText === null ? null : oldText.value, newText: newText.value }, partial: false }
}

/**
 * boundFileChangeItem maps canonical changes through this before traversing mirrors. Retain material
 * in order and downgrade completeness/stat accuracy when a cap discards content; keep a metadata placeholder
 * when all supplied material was omitted. Only the shared budget is mutated, never the source change.
 */
function boundChange(change: FileChange, budget: RetentionBudget): FileChange {
  let partial = false
  const materials: FileChange['materials'] = []
  for (const material of change.materials) {
    const retained = boundMaterial(material, budget)
    partial ||= retained.partial
    if (retained.material) materials.push(retained.material)
  }
  if (!materials.length && change.materials.length) materials.push({ format: 'unavailable', reason: 'tooLarge' })
  const result = { ...change, materials }
  if (partial) {
    result.completeness = 'partial'
    if (change.stats) result.stats = { ...change.stats, accuracy: 'partial' }
  }
  return result
}

/**
 * boundFileChangeItem invokes this for input, output, raw and extensions after canonical material.
 * Return recursively bounded JSON without changing keys or scalar types. String values consume the
 * remaining budget in traversal order; only the shared budget is mutated.
 */
function boundMirror(value: JsonValue, budget: RetentionBudget): JsonValue {
  if (typeof value === 'string') return takeText(budget, value).value
  if (Array.isArray(value)) return value.map(entry => boundMirror(entry, budget))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, boundMirror(child, budget)]))
  return value
}
