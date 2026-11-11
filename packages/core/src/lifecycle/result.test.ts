import { expect, test } from 'bun:test';
import type { AhpEvent, AhpEventPayload, Item } from '@anureo/protocol';
import { ResultAccumulator } from './result';

function event(payload: AhpEventPayload): AhpEvent {
  return { sessionId: 'session', streamId: 'stream', turnId: 'turn', seq: 1, timestamp: '2026-11-10T00:00:00.000Z', ...payload } as AhpEvent;
}
const bytes = (item: Item) => Buffer.byteLength(JSON.stringify(item));
const terminal = { turnId: 'turn', status: 'interrupted' as const };

test('interrupted results preserve immutable native reason metadata without becoming failed', () => {
  const accumulator = new ResultAccumulator(1024, 10);
  const error = { code: 'USER_SKIPPED', message: 'skipped', retryable: false, outcomeUnknown: false, details: { workflowDisposition: 'skipped' } };
  const result = accumulator.finish({ ...terminal, error });
  expect(result).toMatchObject({ status: 'interrupted', error });
  error.details.workflowDisposition = 'changed';
  expect(result.status === 'interrupted' && result.error?.details?.workflowDisposition).toBe('skipped');
  expect(accumulator.finish(terminal)).not.toHaveProperty('error');
});

test('streamed text keeps exact serialized byte budgets across escapes and split surrogate pairs', () => {
  const accumulator = new ResultAccumulator(1024 * 1024, 10);
  const item: Item = { id: 'answer', type: 'agentMessage', phase: 'final', text: '' };
  accumulator.accept(event({ type: 'item/started', payload: { item } }));
  for (const text of [
    'quote"\\\n\t\0',
    '日本語',
    '\ud83d', // Paired across an empty delta.
    '',
    '\ude00',
    '\ud800', // Unpaired high surrogate.
    'a',
    '\udc00', // Unpaired low surrogate.
    '🦊',
  ]) {
    accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text } }));
    item.text += text;
    expect(accumulator.size).toBe(bytes(item));
  }
  const result = accumulator.finish(terminal);
  expect(result.text).toBe(item.text);
  expect(result.items).toEqual([item]);
});

test('reasoning and tool output deltas account for absent and replaced fields', () => {
  const cases: Array<{ item: Item; expected: Item; kind: 'reasoningSummary' | 'output' }> = [
    { item: { id: 'r', type: 'reasoning' }, expected: { id: 'r', type: 'reasoning', summary: '日本語\ntext' }, kind: 'reasoningSummary' },
    { item: { id: 't', type: 'toolCall', kind: 'command', title: 'tool' }, expected: { id: 't', type: 'toolCall', kind: 'command', title: 'tool', output: '日本語\ntext' }, kind: 'output' },
    { item: { id: 't', type: 'toolCall', kind: 'command', title: 'tool', output: { before: true } }, expected: { id: 't', type: 'toolCall', kind: 'command', title: 'tool', output: '日本語\ntext' }, kind: 'output' },
    { item: { id: 't', type: 'toolCall', kind: 'command', title: 'tool', output: null }, expected: { id: 't', type: 'toolCall', kind: 'command', title: 'tool', output: '日本語\ntext' }, kind: 'output' },
  ];
  for (const { item, expected, kind } of cases) {
    const accumulator = new ResultAccumulator(1024, 10);
    accumulator.accept(event({ type: 'item/started', payload: { item } }));
    for (const text of ['', '日本語', '\n', 'text']) accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind, text } }));
    expect(accumulator.size).toBe(bytes(expected));
    expect(accumulator.finish(terminal).items).toEqual([expected]);
  }
});

test('a rejected text delta leaves the retained result and its budget unchanged', () => {
  const item: Item = { id: 'answer', type: 'agentMessage', phase: 'final', text: 'start' };
  const expected = { ...item, text: 'start\n"end' };
  const accumulator = new ResultAccumulator(bytes(expected), 10);
  accumulator.accept(event({ type: 'item/started', payload: { item } }));
  accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: '\n"end' } }));
  expect(accumulator.size).toBe(bytes(expected));
  expect(() => accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: '!' } }))).toThrow('RESULT_BUDGET_EXCEEDED');
  expect(accumulator.size).toBe(bytes(expected));
  expect(accumulator.finish(terminal).text).toBe(expected.text);
});

test('authoritative patches and completion replace accumulated chunks and reset their budgets', () => {
  const accumulator = new ResultAccumulator(1024, 10);
  const item: Item = { id: 'answer', type: 'agentMessage', phase: 'final', text: 'initial' };
  accumulator.accept(event({ type: 'item/started', payload: { item } }));
  item.text = 'external mutation';
  accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: ' preview' } }));
  const first = accumulator.finish(terminal);
  expect(first.text).toBe('initial preview');
  const patch = { ...item, text: 'replacement' };
  accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'patch', value: patch } }));
  expect(accumulator.size).toBe(bytes(patch));
  accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: ' tail' } }));
  expect(accumulator.finish(terminal).text).toBe('replacement tail');
  const final = { ...item, text: 'final' };
  accumulator.accept(event({ type: 'item/completed', payload: { item: final } }));
  accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: 'ignored' } }));
  expect(accumulator.size).toBe(bytes(final));
  expect(accumulator.finish({ ...terminal, status: 'completed' }).text).toBe('final');
  expect(first.text).toBe('initial preview');
  expect(Object.isFrozen(first.items[0])).toBe(true);
  accumulator.clear();
  expect(accumulator.size).toBe(0);
  expect(accumulator.finish(terminal).items).toEqual([]);
});
