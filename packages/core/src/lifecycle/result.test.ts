// Verifies retained-result accounting, ordering and isolation.
import { expect, test } from 'bun:test';
import type { AhpEvent, AhpEventPayload, Item, Usage } from '@anureo/protocol';
import { ResultAccumulator } from './result';

/** Direct tests supply payloads here; return a fixed envelope without running Session's validation or ordering. */
function event(payload: AhpEventPayload): AhpEvent {
  return { sessionId: 'session', streamId: 'stream', turnId: 'turn', seq: 1, timestamp: '2026-11-10T00:00:00.000Z', ...payload } as AhpEvent;
}
/** Budget assertions use full serialization as an independent oracle for incremental accounting. */
const bytes = (item: Item) => Buffer.byteLength(JSON.stringify(item));
/** Direct finish calls use this native interruption payload without an error or terminal usage override. */
const terminal = { turnId: 'turn', status: 'interrupted' as const };

/** Mutate native error details after finish; the interrupted snapshot must retain detached metadata and status. */
test('interrupted results preserve immutable native reason metadata without becoming failed', () => {
  const accumulator = new ResultAccumulator(1024, 10);
  const error = { code: 'USER_SKIPPED', message: 'skipped', retryable: false, outcomeUnknown: false, details: { workflowDisposition: 'skipped' } };
  const result = accumulator.finish({ ...terminal, error });
  expect(result).toMatchObject({ status: 'interrupted', error });
  error.details.workflowDisposition = 'changed';
  expect(result.status === 'interrupted' && result.error?.details?.workflowDisposition).toBe('skipped');
  expect(accumulator.finish(terminal)).not.toHaveProperty('error');
});

/** Feed escaped and split-surrogate chunks; compare every retained size with the fully serialized item. */
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

/** Materialize optional and non-string fields, including empty chunks, and verify exact final content/budgets. */
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

/** Fill the exact byte limit, then reject another chunk; neither retained text nor accounting may change. */
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

/** Replace provisional content twice and then reset; earlier snapshots must remain frozen and independent. */
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

/** Complete messages out of order; replacing an earlier item must preserve its original final-text position. */
test('terminal text follows first-seen final-message order and preserves empty separators', () => {
  const accumulator = new ResultAccumulator(1024, 10);
  const first: Item = { id: 'first', type: 'agentMessage', phase: 'final', text: 'preview' };
  const interim: Item = { id: 'interim', type: 'agentMessage', text: 'not final' };
  const empty: Item = { id: 'empty', type: 'agentMessage', phase: 'final', text: '' };
  const last: Item = { id: 'last', type: 'agentMessage', phase: 'final', text: 'last' };
  for (const item of [first, interim, empty, last]) {
    accumulator.accept(event({ type: 'item/started', payload: { item } }));
  }
  accumulator.accept(event({ type: 'item/completed', payload: { item: last } }));
  accumulator.accept(event({ type: 'item/completed', payload: { item: { ...first, text: 'first' } } }));
  const result = accumulator.finish({ ...terminal, status: 'completed' });
  expect(result.text).toBe('first\n\nlast');
  expect(result.items.map(item => item.id)).toEqual(['first', 'interim', 'empty', 'last']);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.items)).toBe(true);
});

/** Reject replacement bytes and new-item capacity separately, then verify the item still accepts deltas. */
test('rejected authoritative snapshots leave retention and byte accounting unchanged', () => {
  const item: Item = { id: 'answer', type: 'agentMessage', phase: 'final', text: 'fits' };
  const updated = { ...item, text: 'fits!' };
  const second: Item = { id: 'r', type: 'reasoning' };
  const accumulator = new ResultAccumulator(bytes(updated) + bytes(second), 1);
  accumulator.accept(event({ type: 'item/started', payload: { item } }));
  expect(() => accumulator.accept(event({ type: 'item/completed', payload: { item: { ...item, text: 'too large'.repeat(10) } } }))).toThrow('RESULT_BUDGET_EXCEEDED');
  expect(() => accumulator.accept(event({ type: 'item/started', payload: { item: second } }))).toThrow('RESULT_BUDGET_EXCEEDED');
  expect(accumulator.size).toBe(bytes(item));
  expect(accumulator.finish(terminal).items).toEqual([item]);
  accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: '!' } }));
  expect(accumulator.size).toBe(bytes(updated));
  expect(accumulator.finish(terminal).items).toEqual([updated]);
});

test('extension patches and text deltas for another item family leave retained content unchanged', () => {
  const item: Item = { id: 'answer', type: 'agentMessage', phase: 'final', text: 'initial' };
  const accumulator = new ResultAccumulator(1024, 10);
  accumulator.accept(event({ type: 'item/started', payload: { item } }));
  accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'patch', value: { custom: true }, text: 'ignored' } }));
  accumulator.accept(event({ type: 'item/delta', payload: { itemId: item.id, kind: 'output', text: 'ignored' } }));
  expect(accumulator.size).toBe(bytes(item));
  expect(accumulator.finish(terminal).items).toEqual([item]);
});

/** Exercise usage precedence, detached native/default error metadata and reset; failures remain result values. */
test('terminal snapshots select turn usage and preserve native or default failure metadata', () => {
  const accumulator = new ResultAccumulator(1024, 10);
  const observed: Usage = { provider: 'test', source: 'native', scope: 'turn', input: 1 };
  const latest: Usage = { ...observed, input: 2 };
  const native: Usage = { ...observed, input: 3 };
  for (const usage of [observed, latest]) {
    accumulator.accept(event({ type: 'usage/updated', payload: usage }));
  }
  latest.input = 99;
  accumulator.accept(event({ type: 'usage/updated', payload: { ...observed, scope: 'session', input: 100 } }));
  const fallback = accumulator.finish({ ...terminal, status: 'failed' });
  expect(fallback).toMatchObject({ status: 'failed', usage: { input: 2 }, error: { code: 'TURN_FAILED', message: 'Turn failed', retryable: false, outcomeUnknown: false } });
  expect(accumulator.finish({ ...terminal, usage: { ...native, scope: 'session' } }).usage?.input).toBe(2);
  const error = { code: 'NATIVE_FAILURE', message: 'native reason', retryable: true, outcomeUnknown: true, details: { reason: 'original' } };
  const result = accumulator.finish({ ...terminal, status: 'failed', usage: native, error });
  native.input = 99;
  error.details.reason = 'changed';
  expect(result).toMatchObject({ status: 'failed', usage: { input: 3 }, error: { code: 'NATIVE_FAILURE', retryable: true, outcomeUnknown: true, details: { reason: 'original' } } });
  expect(Object.isFrozen(result.usage)).toBe(true);
  accumulator.clear();
  expect(accumulator.finish(terminal)).not.toHaveProperty('usage');
  expect(fallback.usage?.input).toBe(2);
});
