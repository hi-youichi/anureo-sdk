import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { itemStatus, mapItems, nativeInput } from '../src/mapping'

describe('native input mapping', () => {
  test('text, inline images, remote images and file mentions map to native records', () => {
    const file = new URL('file:///C:/work/dir/readme.md')
    expect(nativeInput([
      { type: 'text', text: 'inspect this' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'image', data: 'c2Vjb25k', mimeType: 'image/png', url: 'https://images.test/pic.png' },
      { type: 'file', uri: file.href },
    ])).toEqual([
      { type: 'text', text: 'inspect this' },
      { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' },
      { type: 'image', url: 'https://images.test/pic.png' },
      { type: 'mention', path: fileURLToPath(file.href), name: 'readme.md' },
    ])
  })
  test('non-file URIs are rejected before reaching the native runtime', () => {
    expect(() => nativeInput([{ type: 'file', uri: 'https://example.test/report' }])).toThrow('Codex file input requires a file URI')
  })
})

describe('native item status vocabulary', () => {
  test('every denial word maps to declined', () => {
    expect(itemStatus('declined', false)).toBe('declined')
    expect(itemStatus('denied', false)).toBe('declined')
  })
})

describe('native userMessage content projection', () => {
  test('remote images, local images and unsupported blocks stay typed', () => {
    const [item] = mapItems({ id: 'u1', type: 'userMessage', content: [
      { type: 'text', text: 'see attached' },
      { type: 'image', url: 'https://images.test/chart.png' },
      { type: 'localImage', path: '/tmp/scratch/chart.png' },
      { type: 'futureBlock', anything: true },
    ] }, true)
    if (item.type !== 'userMessage') throw new Error('unexpected item type')
    expect(item.content).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'image', url: 'https://images.test/chart.png' },
      { type: 'file', uri: '/tmp/scratch/chart.png' },
      { type: 'text', text: '[unsupported native input]' },
    ])
  })
})
