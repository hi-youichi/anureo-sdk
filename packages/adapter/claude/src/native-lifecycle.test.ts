import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundedEventQueue, createClient, type Session, type Turn } from '@anureo/sdk';
import type { AhpEvent } from '@anureo/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAdapter, type ClaudeQuery, type ClaudeQueryFactory } from './index';

/** Open a session whose test controls native replies and whose observer records published events.
 * Tests must await dispose, including after an explicit session close. */
async function fixture() {
  const native = createManualQuery();
  const client = await createClient({
    adapter: createClaudeAdapter({ queryFactory: native.queryFactory }),
    identity: { adapterId: 'claude', runtimeConfigId: 'native-fixture' },
  });
  const session = await client.sessions.create({ cwd: process.cwd() });
  const observation = collectSessionEvents(session);
  return {
    session,
    native,
    events: observation.events,
    /** Detach and drain the test's collector before disposing the client and its native query. */
    async dispose() {
      await observation.stop();
      await client.dispose();
    },
  };
}

/** Supply the query ClaudeBackendSession.startQuery uses to consume test submissions.
 * The test waits for prompt consumption before echoing UUIDs, while the adapter pump reads the
 * scripted replies. The backend owns query closure. */
function createManualQuery() {
  const output = new BoundedEventQueue<SDKMessage>();
  const inputs: SDKUserMessage[] = [];
  const waiters: Array<() => void> = [];
  let interruptReceipt: Awaited<ReturnType<ClaudeQuery['interrupt']>>;
  let interruptCalls = 0;
  const query: ClaudeQuery = {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    interrupt: async () => {
      interruptCalls++;
      return interruptReceipt;
    },
    setModel: async () => {},
    setPermissionMode: async () => {},
    setMaxThinkingTokens: async () => {},
    applyFlagSettings: async () => {},
    rewindFiles: async () => ({ canRewind: true }),
    supportedModels: async () => [],
    close: () => { output.end(); },
  };

  /** Record input before waking tests so they can build native replies with the actual UUID. */
  async function captureInputs(prompt: AsyncIterable<SDKUserMessage>) {
    for await (const value of prompt) {
      inputs.push(value);
      for (const notify of waiters.splice(0)) notify();
    }
  }

  /** Enqueue a scripted native message. Queue write completion does not await SDK publication. */
  function send(message: Record<string, unknown>) {
    return output.write(message as unknown as SDKMessage);
  }

  const queryFactory: ClaudeQueryFactory = ({ prompt }) => {
    if (typeof prompt !== 'string') void captureInputs(prompt);
    return query;
  };
  return {
    queryFactory,
    inputs,
    send,
    /** Script root assistant output, omitting correlation fields when ids is undefined. */
    assistant(ids: string[] | undefined, text: string, id = 'native-message') {
      return send({
        type: 'assistant',
        parent_tool_use_id: null,
        ...(ids ? { user_message_uuids: ids, user_message_uuid: ids.at(-1) } : {}),
        message: { id, role: 'assistant', content: [{ type: 'text', text }] },
      });
    },
    /** Script a root terminal with the supplied correlation list and optional result field overrides. */
    result(ids: string[], text = 'native final', extra: Record<string, unknown> = {}) {
      return send({
        type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', num_turns: 1,
        user_message_uuids: ids, user_message_uuid: ids.at(-1), usage: { input_tokens: 7, output_tokens: 9 }, ...extra,
      });
    },
    /** Wait until the query has consumed count inputs. Tests must submit that many before waiting. */
    async received(count: number) {
      while (inputs.length < count) await new Promise<void>(resolve => waiters.push(resolve));
    },
    /** Read a consumed input's UUID by zero-based position or fail with the missing test evidence. */
    inputUuid(index: number): string {
      const uuid = inputs[index]?.uuid;
      if (!uuid) throw new Error(`Missing native UUID for input ${index + 1}`);
      return uuid;
    },
    /** Select the receipt the next session interrupt will read, leaving output under test control. */
    setInterruptReceipt(receipt: typeof interruptReceipt) { interruptReceipt = receipt; },
    get interruptCalls() { return interruptCalls; },
  };
}

/** Subscribe before dispatch and accumulate events until the observer closes. Tests assert close
 * failures through Turn.result(), so a rejected read only ends this collector. */
function collectSessionEvents(session: Session) {
  const events: AhpEvent[] = [];
  const reader = session.events()[Symbol.asyncIterator]();
  const collection = (async () => {
    try {
      for (;;) {
        const next = await reader.next();
        if (next.done) break;
        events.push(next.value);
      }
    } catch {
      // Closing active observation may reject the pending read.
    }
  })();
  return {
    events,
    /** Release the subscription and wait for the collector to stop recording events. */
    async stop() {
      await reader.return?.();
      await collection;
    },
  };
}

/** Observe early submission rejection while a test drives native replies, preserving the original
 * promise so the test still sees its binding or rejection. */
function observe(promise: Promise<Turn>) {
  void promise.catch(() => {});
  return promise;
}

test('mid-run UUID changes and a multi-input result bind independent observations to one real execution', async () => {
  const f = await fixture();
  try {
    const firstBinding = observe(f.session.submit({ input: 'first' }));
    await f.native.received(1);
    const firstInputUuid = f.native.inputUuid(0);

    await f.native.assistant([firstInputUuid], 'working');
    const firstObservation = await firstBinding;

    const secondBinding = observe(f.session.submit({ input: 'focus' }));
    await f.native.received(2);
    const secondInputUuid = f.native.inputUuid(1);

    await f.native.assistant([secondInputUuid], 'updated');
    const secondObservation = await secondBinding;

    expect(secondObservation.id).toBe(firstObservation.id);
    expect(firstObservation.id).not.toBe(firstInputUuid);
    expect(firstObservation.id).not.toBe(secondInputUuid);
    await f.native.result([firstInputUuid, secondInputUuid]);
    const [firstResult, secondResult] = await Promise.all([firstObservation.result(), secondObservation.result()]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.usage).toMatchObject({ input: 7, output: 9 });
    expect(f.events.filter(e => e.type === 'turn/started')).toHaveLength(1);
    expect(f.events.filter(e => e.type === 'turn/completed')).toHaveLength(1);
    expect(f.events.filter(e => e.type === 'submission/bound')).toHaveLength(2);
    expect(f.native.inputs.map(input => input.priority)).toEqual(['next', 'next']);
    await expect(firstObservation.steer({ input: 'exact' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(firstObservation.interrupt()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  } finally { await f.dispose(); }
});

test('afterTurn uses native later priority and binds to a later actual execution', async () => {
  const f = await fixture();
  try {
    const first = observe(f.session.submit({ input: 'first' })); await f.native.received(1);
    const one = f.native.inputUuid(0); await f.native.assistant([one], 'first'); const a = await first;
    const second = observe(f.session.submit({ input: 'later', delivery: 'afterTurn' })); await f.native.received(2);
    expect(f.native.inputs[1]!.priority).toBe('later'); const two = f.native.inputUuid(1);
    await f.native.result([one], 'first final'); expect((await a.result()).text).toBe('first final');
    await f.native.assistant([two], 'second'); const b = await second;
    expect(b.id).not.toBe(a.id); await f.native.result([two], 'second final'); expect((await b.result()).text).toBe('second final');
  } finally { await f.dispose(); }
});

test('missing early UUIDs do not guess binding; final correlation list resolves the same execution', async () => {
  const f = await fixture();
  try {
    let bound = false;
    const pending = observe(f.session.submit({ input: 'first' })); void pending.then(() => { bound = true; }, () => {});
    await f.native.received(1); await f.native.assistant(undefined, 'working');
    await new Promise(resolve => setImmediate(resolve)); expect(bound).toBe(false);
    await f.native.result([f.native.inputUuid(0)]); const turn = await pending;
    expect((await turn.result()).status).toBe('completed');
    expect(f.events.filter(e => e.type === 'turn/started')).toHaveLength(1);
  } finally { await f.dispose(); }
});

test('hook refusal and a zero-turn result reject only those inputs without inventing executions', async () => {
  const f = await fixture();
  try {
    const refused = observe(f.session.submit({ input: 'refused' })); await f.native.received(1);
    await f.native.send({ type: 'system', subtype: 'input_refused', refused_user_message_uuid: f.native.inputUuid(0) });
    await expect(refused).rejects.toMatchObject({ code: 'NATIVE_INPUT_REJECTED' });
    const empty = observe(f.session.submit({ input: 'hook ends input' })); await f.native.received(2);
    await f.native.result([f.native.inputUuid(1)], '', { num_turns: 0 });
    await expect(empty).rejects.toMatchObject({ code: 'NATIVE_INPUT_NOT_EXECUTED' });
    expect(f.events.filter(e => e.type.startsWith('turn/'))).toHaveLength(0);
    const valid = observe(f.session.submit({ input: 'valid' })); await f.native.received(3);
    await f.native.result([f.native.inputUuid(2)]); expect((await (await valid).result()).status).toBe('completed');
  } finally { await f.dispose(); }
});

test('session interruption reports queued input while normal native completion wins the race', async () => {
  const f = await fixture();
  try {
    const pending = observe(f.session.submit({ input: 'first' })); await f.native.received(1);
    const first = f.native.inputUuid(0); await f.native.assistant([first], 'working'); const a = await pending;
    const queued = observe(f.session.submit({ input: 'later', delivery: 'afterTurn' })); await f.native.received(2);
    const later = f.native.inputUuid(1); f.native.setInterruptReceipt({ still_queued: [later] });
    const receipt = await f.session.interrupt(); expect(receipt.stillQueued).toHaveLength(1); expect(f.native.interruptCalls).toBe(1);
    const dispatched = f.events.flatMap(e => e.type === 'submission/status' && e.payload.status === 'dispatched' ? [e.payload.submissionId] : []);
    expect(receipt.stillQueued).toEqual([dispatched.at(-1)!]);
    await f.native.result([first]); expect((await a.result()).status).toBe('completed');
    await f.native.result([later]); expect((await (await queued).result()).status).toBe('completed');
  } finally { await f.dispose(); }
});

test('active close ends observation without an invented native terminal', async () => {
  const f = await fixture();
  try {
    const pending = observe(f.session.submit({ input: 'first' })); await f.native.received(1);
    await f.native.assistant([f.native.inputUuid(0)], 'working'); const turn = await pending;
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
    const first = observe(f.session.submit({ input: 'first' })); await f.native.received(1);
    const one = f.native.inputUuid(0); await f.native.assistant([one], 'working'); const turn = await first;
    const omitted = observe(f.session.submit({ input: 'no echo' }, { timeoutMs: 30 })); await f.native.received(2);
    // An older/partial echo names only one input. Do not guess that the other joined it.
    await f.native.result([one]); expect((await turn.result()).status).toBe('completed');
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
    await f.native.received(64);
    await expect(f.session.submit({ input: 'beyond-window' })).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' });
    expect(f.native.inputs).toHaveLength(64); expect(f.events.some(event => event.type === 'turn/started')).toBe(false);
    abort.abort(); await Promise.allSettled(pending);
    expect(f.native.interruptCalls).toBe(0);
  } finally { abort.abort(); await f.dispose(); }
});
