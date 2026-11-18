/** Pure byte-accounting coverage for history pages: CJK-safe capping, JSON stubs and budget shrinking; adapters keep their own integration regressions. */
import { describe, expect, test } from 'bun:test'
import type { HistoryItem, Item } from '@anureo/protocol'
import { DEFAULT_HISTORY_ITEM_BYTES, capHistoryEntry, capItem, historyItemBytes, pageEndWithinBudget } from './history-pages'

/** Wrap an item in the canonical history envelope adapters emit; ids stay unique so assertions can track pages. */
function envelope(item: Item): HistoryItem {
  return { turnId: 'turn-1', nativeTurnId: 'native-1', nativeItemId: item.id, item }
}

/** Shrink pages until the budget holds while always keeping one item; a non-positive budget must disable shrinking entirely. */
describe('pageEndWithinBudget', () => {
  test('shrinks to the byte budget but never below one item', () => {
    const items = ['a'.repeat(60_000), 'b'.repeat(60_000), 'c'.repeat(60_000)].map(text => envelope({ id: text.slice(0, 4), type: 'agentMessage', text }))
    expect(items.map(historyItemBytes).every(size => size > 60_000)).toBe(true)
    // 60KB items: two exceed a 100KB budget, so the window must shrink to one item.
    expect(pageEndWithinBudget(items, 0, 2, 100_000)).toBe(1)
    // Three 60KB items fit a 200KB budget.
    expect(pageEndWithinBudget(items, 0, 3, 200_000)).toBe(3)
    // A window that already holds one item cannot shrink further; it returns the original end unchanged.
    expect(pageEndWithinBudget(items, 1, 2, 1)).toBe(2)
    // Non-positive budgets disable shrinking; callers own sane defaults.
    expect(pageEndWithinBudget(items, 0, 3, 0)).toBe(3)
  })
})

/** Cap oversized content on SDK items with byte-accurate boundaries; unchanged items must keep their reference so hot paths stay allocation-free. */
describe('capItem', () => {
  test('leaves small items untouched and returns the same reference', () => {
    const small = envelope({ id: 's', type: 'agentMessage', text: 'done' })
    expect(capHistoryEntry(small)).toBe(small)
    expect(capItem(small.item)).toBe(small.item)
  })
  test('caps multi-byte text without splitting the marker off', () => {
    const huge = envelope({ id: 'cjk', type: 'agentMessage', text: '日本語'.repeat(30_000) })
    const capped = capItem(huge.item)
    expect(capped).not.toBe(huge.item)
    expect(capped.extensions).toMatchObject({ historyTruncated: true })
    expect(capped.type === 'agentMessage' ? capped.text.endsWith('\n[truncated]') : false).toBe(true)
    expect(Buffer.byteLength(capped.type === 'agentMessage' ? capped.text : '', 'utf8')).toBeLessThanOrEqual(DEFAULT_HISTORY_ITEM_BYTES + Buffer.byteLength('\n[truncated]'))
  })
  test('stubs oversized structured values and preserves the original size', () => {
    const big = { result: 'z'.repeat(100_000) }
    const item = capItem({ id: 't', type: 'toolCall', kind: 'other', title: 'big output', output: big })
    expect(item.extensions).toMatchObject({ historyTruncated: true })
    expect(item.type === 'toolCall' && item.output !== null && typeof item.output === 'object' && !Array.isArray(item.output) ? item.output.truncated : undefined).toBe(true)
    expect(item.type === 'toolCall' && item.output !== null && typeof item.output === 'object' && !Array.isArray(item.output) && typeof item.output.originalBytes === 'number' ? item.output.originalBytes : 0).toBeGreaterThan(100_000)
    // Small structured values keep their identity so pages without oversized items allocate nothing.
    const smallOutput = { ok: true }
    const untouched = capItem({ id: 't2', type: 'toolCall', kind: 'other', title: 'small output', output: smallOutput })
    expect(untouched.type === 'toolCall' ? untouched.output : undefined).toBe(smallOutput)
  })
  test('capHistoryEntry replaces the envelope only when its item changed', () => {
    const big = envelope({ id: 'b', type: 'reasoning', text: 'w'.repeat(70_000) })
    const capped = capHistoryEntry(big)
    expect(capped).not.toBe(big)
    expect(capped.turnId).toBe('turn-1')
    expect(capHistoryEntry(envelope({ id: 'n', type: 'agentMessage', text: 'fine' }))).not.toBe(undefined)
  })
})
