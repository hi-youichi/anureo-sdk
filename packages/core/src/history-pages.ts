/** Owns shared history page byte accounting and oversized-item capping for adapters; it must not perform I/O or interpret native payloads beyond SDK Item shapes. */
import type { HistoryItem, InputBlock, Item, JsonObject, JsonValue } from '@anureo/protocol'

/** Serialized byte budget for one public history page; sized so any transport hop (8MiB AHP frames, 16MiB default WS receive limits) carries it with margin. Adapters may override through their own options. */
export const DEFAULT_HISTORY_PAGE_BYTES = 4 * 1024 * 1024
/** Per-item content ceiling applied while building history snapshots; mirrors the live execution-output cap so replayed history never carries more payload than a live turn would. */
export const DEFAULT_HISTORY_ITEM_BYTES = 64 * 1024
/** In-band marker appended to capped text fields; consumers can distinguish truncated replay from short native content without a protocol change. */
const TRUNCATED_MARKER = '\n[truncated]'

/** Measure one history envelope's serialized UTF-8 size. SDK items are structured clones, so serialization cannot cycle; caller owns undefined/empty pages. */
export function historyItemBytes(entry: HistoryItem): number {
  return Buffer.byteLength(JSON.stringify(entry) ?? '', 'utf8')
}

/**
 * Shrink a half-open [offset, end) page window until its serialized size fits the budget, keeping
 * at least one item so cursors always make progress even when a single item exceeds the budget.
 * A non-positive budget disables shrinking; oversized single items then rely on capping.
 */
export function pageEndWithinBudget(items: readonly HistoryItem[], offset: number, end: number, budgetBytes: number): number {
  if (!(budgetBytes > 0)) return end
  let adjusted = end
  let total = 0
  for (let index = offset; index < adjusted; index++) total += historyItemBytes(items[index]!)
  while (adjusted > offset + 1 && total > budgetBytes) {
    adjusted -= 1
    total -= historyItemBytes(items[adjusted]!)
  }
  return adjusted
}

/** Append the truncation marker only when the text actually exceeds the budget; halving keeps the loop bounded without char-class assumptions. */
function capString(value: string, budgetBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= budgetBytes) return value
  const markerBudget = budgetBytes - Buffer.byteLength(TRUNCATED_MARKER, 'utf8')
  let text = value.slice(0, Math.max(0, Math.floor(markerBudget)))
  while (text.length > 0 && Buffer.byteLength(text, 'utf8') > markerBudget) text = text.slice(0, Math.ceil(text.length / 2))
  return text + TRUNCATED_MARKER
}

/** Cap one JSON content value: strings keep an in-band marker, structured values become a bounded stub that records the original size and a head preview. */
function capJson(value: JsonValue, budgetBytes: number): JsonValue {
  if (typeof value === 'string') return capString(value, budgetBytes)
  const encoded = JSON.stringify(value)
  if (encoded !== undefined && Buffer.byteLength(encoded, 'utf8') <= budgetBytes) return value
  return { truncated: true, originalBytes: encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8'), head: encoded === undefined ? '' : encoded.slice(0, 1024) }
}

/** True when a string field is present and over the budget; keeps the switch readable. */
function overBudget(value: string | undefined, limitBytes: number): boolean {
  return value !== undefined && Buffer.byteLength(value, 'utf8') > limitBytes
}

/**
 * Cap oversized text/JSON content fields on one SDK Item without mutating the input.
 * Capped items gain `extensions.historyTruncated`; unchanged items return the caller's
 * reference untouched so hot paths stay allocation-free. Small history fields (plan steps,
 * titles, identities) are intentionally left alone.
 */
export function capItem(item: Item, limitBytes: number = DEFAULT_HISTORY_ITEM_BYTES): Item {
  let next: Item | undefined
  switch (item.type) {
    case 'agentMessage':
      if (overBudget(item.text, limitBytes)) next = { ...item, text: capString(item.text!, limitBytes) }
      break
    case 'reasoning': {
      const text = overBudget(item.text, limitBytes) ? capString(item.text!, limitBytes) : item.text
      const summary = overBudget(item.summary, limitBytes) ? capString(item.summary!, limitBytes) : item.summary
      if (text !== item.text || summary !== item.summary) next = { ...item, text, summary }
      break
    }
    case 'userMessage': {
      const content = item.content.map((block: InputBlock) => (block.type === 'text' && overBudget(block.text, limitBytes) ? { ...block, text: capString(block.text, limitBytes) } : block))
      if (content.some((block, index) => block !== item.content[index])) next = { ...item, content }
      break
    }
    case 'toolCall': {
      const input = item.input !== undefined ? capJson(item.input, limitBytes) : item.input
      const output = item.output !== undefined ? capJson(item.output, limitBytes) : item.output
      if (input !== item.input || output !== item.output) next = { ...item, input, output }
      break
    }
    case 'hook': {
      const input = item.input !== undefined ? capJson(item.input, limitBytes) : item.input
      const output = item.output !== undefined ? capJson(item.output, limitBytes) : item.output
      if (input !== item.input || output !== item.output) next = { ...item, input, output }
      break
    }
  }
  if (!next) return item
  const extensions: JsonObject = { ...(item.extensions ?? {}), historyTruncated: true }
  return { ...next, extensions }
}

/** Cap one history envelope's item; the envelope reference is replaced only when its item changed, so untouched pages stay allocation-free. */
export function capHistoryEntry(entry: HistoryItem, limitBytes: number = DEFAULT_HISTORY_ITEM_BYTES): HistoryItem {
  const capped = capItem(entry.item, limitBytes)
  return capped === entry.item ? entry : { ...entry, item: capped }
}
