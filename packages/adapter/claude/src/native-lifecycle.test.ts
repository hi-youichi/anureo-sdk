import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundedEventQueue, createClient, type Turn } from '@anureo/sdk';
import type { AhpEvent } from '@anureo/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAdapter, type ClaudeQuery } from './index';

async function fixture() {
  const output = new BoundedEventQueue<SDKMessage>();
  const inputs: SDKUserMessage[] = [];
  const waiters: Array<() => void> = [];
  let interruptReceipt: Awaited<ReturnType<ClaudeQuery['interrupt']>>;
  let interruptCalls = 0;
  const query: ClaudeQuery = {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    interrupt: async () => { interruptCalls++; return interruptReceipt; },
    setModel: async () => {}, setPermissionMode: async () => {}, setMaxThinkingTokens: async () => {},
    applyFlagSettings: async () => {}, rewindFiles: async () => ({ canRewind: true }), supportedModels: async () => [],
    close: () => { output.end(); },
  };
  const client = await createClient({
    adapter: createClaudeAdapter({ queryFactory: ({ prompt }) => {
      if (typeof prompt !== 'string') void (async () => {
        for await (const value of prompt) { inputs.push(value); for (const notify of waiters.splice(0)) notify(); }
      })();
      return query;
    } }),
    identity: { adapterId: 'claude', runtimeConfigId: 'native-fixture' },
  });
  const session = await client.sessions.create({ cwd: process.cwd() });
  const events: AhpEvent[] = [];
  const reader = session.events()[Symbol.asyncIterator]();
  const eventCollectionTask = (async () => {
    try {
      for (;;) {
        const next = await reader.next();
        if (next.done) break;
        events.push(next.value);
      }
    } catch {
      // session.close() can end this stream with OBSERVATION_CLOSED.
      // Ignore all read errors in this assertion collector so awaiting it cannot block client cleanup.
    }
  })();
  const send = (message: Record<string, unknown>) => output.write(message as unknown as SDKMessage);
  const assistant = (ids: string[] | undefined, text: string, id = 'native-message') => send({
    type: 'assistant', parent_tool_use_id: null, ...(ids ? { user_message_uuids: ids, user_message_uuid: ids.at(-1) } : {}),
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
  });
  const result = (ids: string[], text = 'native final', extra: Record<string, unknown> = {}) => send({
    type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', num_turns: 1,
    user_message_uuids: ids, user_message_uuid: ids.at(-1), usage: { input_tokens: 7, output_tokens: 9 }, ...extra,
  });
  return {
    client, session, inputs, events, send, assistant, result,
    async received(count: number) { while (inputs.length < count) await new Promise<void>(resolve => waiters.push(resolve)); },
    setInterruptReceipt(receipt: typeof interruptReceipt) { interruptReceipt = receipt; },
    get interruptCalls() { return interruptCalls; },
    async dispose() {
      await reader.return?.();
      await eventCollectionTask;
      await client.dispose();
    },
  };
}
const observe = (promise: Promise<Turn>) => { void promise.catch(() => {}); return promise; };

test('mid-run UUID changes and a multi-input result bind independent observations to one real execution', async () => {
  const f = await fixture();
  try {
    const firstBinding = observe(f.session.submit({ input: 'first' }));
    await f.received(1);
    const firstInputUuid = f.inputs[0]!.uuid!;

    await f.assistant([firstInputUuid], 'working');
    const firstObservation = await firstBinding;

    const secondBinding = observe(f.session.submit({ input: 'focus' }));
    await f.received(2);
    const secondInputUuid = f.inputs[1]!.uuid!;

    await f.assistant([secondInputUuid], 'updated');
    const secondObservation = await secondBinding;

    expect(secondObservation.id).toBe(firstObservation.id);
    expect(firstObservation.id).not.toBe(firstInputUuid);
    expect(firstObservation.id).not.toBe(secondInputUuid);
    await f.result([firstInputUuid, secondInputUuid]);
    const [firstResult, secondResult] = await Promise.all([firstObservation.result(), secondObservation.result()]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.usage).toMatchObject({ input: 7, output: 9 });
    expect(f.events.filter(e => e.type === 'turn/started')).toHaveLength(1);
    expect(f.events.filter(e => e.type === 'turn/completed')).toHaveLength(1);
    expect(f.events.filter(e => e.type === 'submission/bound')).toHaveLength(2);
    expect(f.inputs.map(input => input.priority)).toEqual(['next', 'next']);
    await expect(firstObservation.steer({ input: 'exact' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(firstObservation.interrupt()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  } finally { await f.dispose(); }
});

test('afterTurn uses native later priority and binds to a later actual execution', async () => {
  const f = await fixture();
  try {
    const first = observe(f.session.submit({ input: 'first' })); await f.received(1);
    const one = f.inputs[0]!.uuid!; await f.assistant([one], 'first'); const a = await first;
    const second = observe(f.session.submit({ input: 'later', delivery: 'afterTurn' })); await f.received(2);
    expect(f.inputs[1]!.priority).toBe('later'); const two = f.inputs[1]!.uuid!;
    await f.result([one], 'first final'); expect((await a.result()).text).toBe('first final');
    await f.assistant([two], 'second'); const b = await second;
    expect(b.id).not.toBe(a.id); await f.result([two], 'second final'); expect((await b.result()).text).toBe('second final');
  } finally { await f.dispose(); }
});

test('missing early UUIDs do not guess binding; final correlation list resolves the same execution', async () => {
  const f = await fixture();
  try {
    let bound = false;
    const pending = observe(f.session.submit({ input: 'first' })); void pending.then(() => { bound = true; });
    await f.received(1); await f.assistant(undefined, 'working');
    await new Promise(resolve => setImmediate(resolve)); expect(bound).toBe(false);
    await f.result([f.inputs[0]!.uuid!]); const turn = await pending;
    expect((await turn.result()).status).toBe('completed');
    expect(f.events.filter(e => e.type === 'turn/started')).toHaveLength(1);
  } finally { await f.dispose(); }
});

test('hook refusal and a zero-turn result reject only those inputs without inventing executions', async () => {
  const f = await fixture();
  try {
    const refused = observe(f.session.submit({ input: 'refused' })); await f.received(1);
    await f.send({ type: 'system', subtype: 'input_refused', refused_user_message_uuid: f.inputs[0]!.uuid });
    await expect(refused).rejects.toMatchObject({ code: 'NATIVE_INPUT_REJECTED' });
    const empty = observe(f.session.submit({ input: 'hook ends input' })); await f.received(2);
    await f.result([f.inputs[1]!.uuid!], '', { num_turns: 0 });
    await expect(empty).rejects.toMatchObject({ code: 'NATIVE_INPUT_NOT_EXECUTED' });
    expect(f.events.filter(e => e.type.startsWith('turn/'))).toHaveLength(0);
    const valid = observe(f.session.submit({ input: 'valid' })); await f.received(3);
    await f.result([f.inputs[2]!.uuid!]); expect((await (await valid).result()).status).toBe('completed');
  } finally { await f.dispose(); }
});

test('session interruption reports queued input while normal native completion wins the race', async () => {
  const f = await fixture();
  try {
    const pending = observe(f.session.submit({ input: 'first' })); await f.received(1);
    const first = f.inputs[0]!.uuid!; await f.assistant([first], 'working'); const a = await pending;
    const queued = observe(f.session.submit({ input: 'later', delivery: 'afterTurn' })); await f.received(2);
    const later = f.inputs[1]!.uuid!; f.setInterruptReceipt({ still_queued: [later] });
    const receipt = await f.session.interrupt(); expect(receipt.stillQueued).toHaveLength(1); expect(f.interruptCalls).toBe(1);
    const dispatched = f.events.flatMap(e => e.type === 'submission/status' && e.payload.status === 'dispatched' ? [e.payload.submissionId] : []);
    expect(receipt.stillQueued).toEqual([dispatched.at(-1)!]);
    await f.result([first]); expect((await a.result()).status).toBe('completed');
    await f.result([later]); expect((await (await queued).result()).status).toBe('completed');
  } finally { await f.dispose(); }
});

test('active close ends observation without an invented native terminal', async () => {
  const f = await fixture();
  try {
    const pending = observe(f.session.submit({ input: 'first' })); await f.received(1);
    await f.assistant([f.inputs[0]!.uuid!], 'working'); const turn = await pending;
    expect(await f.session.close()).toMatchObject({ observationClosed: true, executionStopped: 'unconfirmed' });
    await expect(turn.result()).rejects.toMatchObject({ code: 'OBSERVATION_CLOSED' });
    expect(f.events.some(e => e.type === 'turn/completed')).toBe(false);
  } finally { await f.dispose(); }
});

test('the pinned official SDK correlates root submissions through an actual child executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anureo-native-sdk-'));
  const client = await createClient({
    adapter: createClaudeAdapter({ command: fileURLToPath(new URL('../tests/fixtures/fake-claude.mjs', import.meta.url)), executableRuntime: 'node', stateDir: join(directory, 'state') }),
    identity: { adapterId: 'claude', runtimeConfigId: 'official-sdk' },
  });
  try {
    const session = await client.sessions.create({ cwd: directory });
    const turn = await session.submit({ input: 'probe' }, { timeoutMs: 3000 });
    expect((await turn.result({ timeoutMs: 3000 })).text).toBe('external executable probe passed');
    await session.close();
  } finally {
    await client.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 15_000);

test('incomplete correlation evidence does not bind an omitted input or fabricate its failure', async () => {
  const f = await fixture();
  try {
    const first = observe(f.session.submit({ input: 'first' })); await f.received(1);
    const one = f.inputs[0]!.uuid!; await f.assistant([one], 'working'); const turn = await first;
    const omitted = observe(f.session.submit({ input: 'no echo' }, { timeoutMs: 30 })); await f.received(2);
    // An older/partial echo names only one input. Do not guess that the other joined it.
    await f.result([one]); expect((await turn.result()).status).toBe('completed');
    await expect(omitted).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: true });
    expect(f.events.filter(event => event.type === 'submission/bound')).toHaveLength(1);
    expect(f.events.filter(event => event.type === 'turn/completed')).toHaveLength(1);
    expect(f.events.some(event => event.type === 'submission/status' && event.payload.status === 'rejected')).toBe(false);
  } finally { await f.dispose(); }
});

test('the native correlation window rejects excess input before silently losing an association', async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const pending = Array.from({ length: 64 }, (_, i) => observe(f.session.submit({ input: `input-${i}` }, { signal: abort.signal })));
    await f.received(64);
    await expect(f.session.submit({ input: 'beyond-window' })).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' });
    expect(f.inputs).toHaveLength(64); expect(f.events.some(event => event.type === 'turn/started')).toBe(false);
    abort.abort(); await Promise.allSettled(pending);
    expect(f.interruptCalls).toBe(0);
  } finally { abort.abort(); await f.dispose(); }
});
