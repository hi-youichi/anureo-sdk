// Checks public client/session lifecycle behavior; must not implement production dispatch policy.
import { expect, test } from 'bun:test';
import { createClient, HarnessSdkError, type ClientOptions, type HarnessAdapter, type SessionEventSink, type SessionMethod } from '../index';
import { AHP_PROTOCOL_CONTRACT, type AhpEvent, type AhpRequestMap, type AhpResultMap, type Capabilities } from '@anureo/protocol';
import { deferred } from './deferred';

/** Shared native close receipt deliberately leaves execution stop unconfirmed for observation-only cleanup assertions. */
const closeResult = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' } as const;
/** Deterministic fixture capabilities let lifecycle tests reach native dispatch without unrelated capability failures. */
const capabilities: Capabilities = {
  input: { delivery: ['native', 'afterTurn'], steer: { target: 'turn', atomicMatch: true }, interrupt: { targets: ['turn','session'], reportsPendingInputs: true } },
  turn: { inputModalities: ['text'], overrides: ['model'] },
  session: { history: true, resume: true, fork: ['before'], revert: ['conversation'] },
  config: { options: [{ id: 'model', scope: 'session', schema: { type: 'string' } }] },
  review: true, compact: true, goal: { actions: ['set','clear'] }, interactions: ['userInput'],
};
/** Test-owned native operation: controls receipt/event ordering and may reject; fixture records dispatch before invoking it. */
type Run = (method: SessionMethod, params: AhpRequestMap[SessionMethod], sink: SessionEventSink) => Promise<unknown>;
/** Open a real public client/session around a test-owned native operation; return dispatch/sink/release probes or reject setup failure. Each test disposes the client in finally; no native processes are created. */
async function fixture(run: Run, options: Partial<ClientOptions> = {}, supported = capabilities) {
  // Native open assigns the sink before session creation resolves or any test can dispatch.
  let sink!: SessionEventSink, disposals = 0;
  const calls: Array<{ method: SessionMethod; params: AhpRequestMap[SessionMethod] }> = [];
  const adapter: HarnessAdapter = {
    /** Assert contract negotiation while returning deterministic capabilities without native processes. */
    async initialize(p) { expect(p.protocolContract).toBe(AHP_PROTOCOL_CONTRACT); return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'fixture', version: '1', adapter: 'fixture' }, capabilities: supported }; },
    /** Capture the actual runtime sink so tests control event/receipt timing independently. */
    async openSession(p, events) {
      sink = events;
      return { binding: p.binding, capabilities: supported,
        /** Record every native dispatch and delegate its exact receipt/event ordering to the test. */
        async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> { calls.push({ method, params }); return await run(method, params, sink) as AhpResultMap[M]; },
        /** Count release attempts so idempotent session cleanup is observable. */
        async dispose() { disposals++; },
      };
    },
    /** Adapter cleanup intentionally has no native resources in this fixture. */
    async dispose() {},
  };
  const client = await createClient({ adapter, identity: { adapterId: 'fixture', runtimeConfigId: 'local' }, ...options });
  return { client, adapter, session: await client.sessions.create({ cwd: process.cwd() }), calls,
    /** Expose the captured runtime sink for late native events. */
    get sink() { return sink; },
    /** Read the current release count after asynchronous cleanup. */
    get disposals() { return disposals; }
  };
}
/** Await a valid native start for the supplied execution through the ordered sink; publication errors reject so tests cannot proceed with unstarted work. */
async function started(sink: SessionEventSink, turnId: string) { await sink.emit({ type: 'turn/started', payload: { turnId } }); }
/** Await final item then terminal publication for one execution, rejecting sink failures; reusing the item ID deliberately verifies isolation between turns. */
async function completed(sink: SessionEventSink, turnId: string, text = 'answer') {
  await sink.emit({ type: 'item/completed', payload: { item: { id: 'reused', type: 'agentMessage', text, phase: 'final' } } }, { turnId });
  await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } });
}
/** Narrow a fixture request only where the test already knows it carries submission identity; performs no validation or mutation. */
const asSubmitParams = (p: AhpRequestMap[SessionMethod]) => p as AhpRequestMap['input/submit'];

function hookRequest(sessionId: string, requestId: string, input: string): AhpRequestMap['input/submit'] {
  return { sessionId, requestId, submissionId: `input-${requestId}`, delivery: 'native', input: [{ type: 'text', text: input }] };
}

test('input hooks apply to submit, steer and raw requests and validate the final detached input', async () => {
  const seen: string[] = [];
  const validators: NonNullable<NonNullable<ClientOptions['hooks']>['beforeInput']>[number][] = [
    event => {
      seen.push(`${event.method}:${(event.input[0] as { text: string }).text}`);
      Object.assign(event.input[0]!, { text: 'callback mutation' });
    },
    event => { expect(event.input[0]).toMatchObject({ text: 'final' }); },
  ];
  const f = await fixture(async (method, p, sink) => {
    const submission = asSubmitParams(p);
    if (method === 'turn/steer') return { submissionId: submission.submissionId, accepted: true, turnId: 'active' };
    if (submission.requestId !== 'raw') {
      await started(sink, 'active');
      await sink.bindSubmission(submission.submissionId, 'active');
    }
    return { submissionId: submission.submissionId, disposition: 'dispatched' };
  }, { hooks: {
    inputRevision: 'r1',
    transformInput: [
      () => [{ type: 'text', text: 'intermediate' }],
      event => { expect(event.input[0]).toMatchObject({ text: 'intermediate' }); return [{ type: 'text', text: 'final' }]; },
    ],
    beforeInput: validators,
  } });
  try {
    validators.push(() => ({ action: 'deny' }));
    expect(f.client.inputHookRevision).toBe('r1');
    const turn = await f.session.submit({ input: 'submit', delivery: 'afterTurn' });
    await turn.steer({ input: 'steer' });
    await f.session.request('input/submit', hookRequest(f.session.id, 'raw', 'raw'));
    expect(seen).toEqual(['input/submit:final', 'turn/steer:final', 'input/submit:final']);
    expect(f.calls.map(call => asSubmitParams(call.params).input)).toEqual(Array.from({ length: 3 }, () => [{ type: 'text', text: 'final' }]));
    expect(f.calls[0]!.params).toMatchObject({ delivery: 'afterTurn' });
    expect(f.calls[1]!.params).toMatchObject({ expectedTurnId: 'active' });
  } finally { await f.client.dispose(); }
});

test('input policy rejection is deduplicated and sends only safe failure metadata', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let ran = 0;
  const f = await fixture(async () => { throw new Error('unexpected native dispatch'); }, { hooks: {
    inputRevision: 'r1',
    beforeInput: [async () => {
      ran++;
      entered.resolve();
      await release.promise;
      throw new HarnessSdkError('PRIVATE_ERROR', 'private callback error', false, true);
    }],
  } });
  const events: AhpEvent[] = [];
  const reading = (async () => { try { for await (const event of f.session.events()) events.push(event); } catch {} })();
  try {
    const params = hookRequest(f.session.id, 'once', 'private input');
    const first = f.session.request('input/submit', params);
    const duplicate = f.session.request('input/submit', params);
    await entered.promise;
    await expect(f.session.request('input/submit', { ...params, input: [{ type: 'text', text: 'different' }] }))
      .rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    const safe = { code: 'HOOK_FAILED', message: 'HOOK_FAILED', outcomeUnknown: false };
    const outcomes = Promise.allSettled([first, duplicate]);
    release.resolve();
    expect(await outcomes).toMatchObject([
      { status: 'rejected', reason: safe }, { status: 'rejected', reason: safe },
    ]);
    await f.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'BARRIER', message: 'barrier' } });
    expect(events.filter(event => event.type === 'submission/status')).toMatchObject([
      { payload: { submissionId: params.submissionId, status: 'rejected', error: safe } },
    ]);
    expect(ran).toBe(1);
    expect(f.calls).toHaveLength(0);
  } finally { release.resolve(); await f.client.dispose(); await reading; }
});

test('deny, invalid replacement and oversized inputs stop before backend submission', async () => {
  const f = await fixture(async () => { throw new Error('unexpected native dispatch'); }, {
    runtime: { queue: { maxFrameBytes: 1_024 } },
    hooks: {
      inputRevision: 'r1',
      transformInput: [event => {
        const block = event.input[0];
        if (block?.type !== 'text') return;
        switch (block.text) {
          case 'invalid': return [];
          case 'large': return [{ type: 'text', text: 'x'.repeat(2_048) }];
          case 'image': return [{ type: 'image', mimeType: 'image/png', data: 'AA==' }];
        }
      }],
      beforeInput: [() => ({ action: 'deny' })],
    },
  }, { ...capabilities, turn: { ...capabilities.turn, outputSchema: true } });
  try {
    for (const [input, code] of [
      ['deny', 'HOOK_DENIED'], ['invalid', 'HOOK_FAILED'],
      ['large', 'FRAME_TOO_LARGE'], ['image', 'CAPABILITY_UNSUPPORTED'],
    ] as const) {
      const outputSchema = input === 'deny' ? { type: 'invalid-schema-type' } : undefined;
      await expect(f.session.submit({ input, outputSchema })).rejects.toMatchObject({ code, outcomeUnknown: false });
    }
    expect(f.calls).toHaveLength(0);
  } finally { await f.client.dispose(); }
});

test('cancelQueued cancels the current hook batch once and returns both local and native IDs', async () => {
  const entered = deferred<void>(), release = deferred<void>(), aborted = deferred<void>();
  const f = await fixture(async (method, params) => {
    if (method === 'session/interrupt') return { accepted: true, cancelled: ['native'] };
    return { submissionId: asSubmitParams(params).submissionId, disposition: 'dispatched' };
  }, { hooks: {
    inputRevision: 'r1',
    beforeInput: [async (event, { signal }) => {
      if (event.requestId !== 'first') return;
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
    }],
  } }, { ...capabilities, input: { ...capabilities.input!, interrupt: { ...capabilities.input!.interrupt!, cancelQueued: true } } });
  try {
    const first = f.session.request('input/submit', hookRequest(f.session.id, 'first', 'x'));
    const second = f.session.request('input/submit', hookRequest(f.session.id, 'second', 'x'));
    await entered.promise;
    const params = { sessionId: f.session.id, requestId: 'interrupt', cancelQueued: true };
    const interrupted = f.session.request('session/interrupt', params);
    const third = f.session.request('input/submit', hookRequest(f.session.id, 'third', 'x'));
    const replay = f.session.request('session/interrupt', params);
    await aborted.promise;
    const cancelled = { code: 'REQUEST_ABORTED', outcomeUnknown: false };
    await expect(first).rejects.toMatchObject(cancelled);
    await expect(second).rejects.toMatchObject(cancelled);
    const receipt: AhpResultMap['session/interrupt'] = { accepted: true, cancelled: ['input-first', 'input-second', 'native'] };
    await expect(interrupted).resolves.toEqual(receipt);
    await expect(replay).resolves.toEqual(receipt);
    await expect(third).resolves.toMatchObject({ submissionId: 'input-third' });
    release.resolve();
    expect(f.calls.map(call => call.method)).toEqual(['session/interrupt', 'input/submit']);
  } finally { release.resolve(); await f.client.dispose(); }
});

test('an unsupported queue interrupt leaves hooks pending and a native refusal preserves local cancellation', async () => {
  for (const supportsCancellation of [false, true]) {
    const entered = deferred<void>(), release = deferred<void>();
    const f = await fixture(async (method, params) => {
      if (method === 'session/interrupt') throw new HarnessSdkError('NATIVE_REFUSED');
      return { submissionId: asSubmitParams(params).submissionId, disposition: 'dispatched' };
    }, { hooks: { inputRevision: 'r1', beforeInput: [async () => { entered.resolve(); await release.promise; }] } }, {
      ...capabilities,
      input: { ...capabilities.input!, interrupt: { ...capabilities.input!.interrupt!, cancelQueued: supportsCancellation } },
    });
    try {
      const waiting = f.session.request('input/submit', hookRequest(f.session.id, 'held', 'x'));
      const outcome = Promise.allSettled([waiting]);
      await entered.promise;
      await expect(f.session.interrupt({ cancelQueued: true })).rejects.toMatchObject({
        code: supportsCancellation ? 'NATIVE_REFUSED' : 'CAPABILITY_UNSUPPORTED',
      });
      release.resolve();
      if (supportsCancellation) {
        expect(await outcome).toMatchObject([{ status: 'rejected', reason: { code: 'REQUEST_ABORTED', outcomeUnknown: false } }]);
      } else {
        expect(await outcome).toMatchObject([{ status: 'fulfilled', value: { submissionId: 'input-held' } }]);
      }
      expect(f.calls.map(call => call.method)).toEqual([supportsCancellation ? 'session/interrupt' : 'input/submit']);
    } finally { release.resolve(); await f.client.dispose(); }
  }
});

test('closing and observation failure reject inputs still in hooks with a definite outcome', async () => {
  for (const mode of ['close', 'dispose', 'fail'] as const) {
    const entered = deferred<void>(), release = deferred<void>();
    const f = await fixture(async () => closeResult, { hooks: {
      inputRevision: 'r1',
      beforeInput: [async () => { entered.resolve(); await release.promise; }],
    } });
    try {
      const waiting = f.session.submit({ input: 'held' });
      await entered.promise;
      const closing = mode === 'fail' ? f.sink.fail(new HarnessSdkError('PROTOCOL_ERROR')) : f.session[mode]();
      const code = { close: 'SESSION_CLOSING', dispose: 'SESSION_CLOSED', fail: 'PROTOCOL_ERROR' }[mode];
      await expect(waiting).rejects.toMatchObject({ code, outcomeUnknown: false });
      release.resolve();
      await closing;
      expect(f.calls.map(call => call.method)).toEqual(mode === 'close' ? ['session/close'] : []);
    } finally { release.resolve(); await f.client.dispose(); }
  }
});

test('a hook deadline frees the queue while an uncooperative callback is still running', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let signal: AbortSignal | undefined;
  const f = await fixture(async (_method, params) => ({ submissionId: asSubmitParams(params).submissionId, disposition: 'dispatched' }), { hooks: {
    inputRevision: 'r1',
    timeoutMs: 40,
    beforeInput: [async (event, context) => {
      if (event.requestId !== 'held') return;
      signal = context.signal;
      entered.resolve();
      await release.promise;
    }],
  } });
  try {
    const waiting = f.session.request('input/submit', hookRequest(f.session.id, 'held', 'x'));
    await entered.promise;
    await expect(waiting).rejects.toMatchObject({ code: 'HOOK_TIMEOUT', outcomeUnknown: false });
    expect(signal?.aborted).toBe(true);
    await f.session.request('input/submit', hookRequest(f.session.id, 'next', 'x'));
    release.resolve();
    expect(f.calls.map(call => call.params.requestId)).toEqual(['next']);
  } finally { release.resolve(); await f.client.dispose(); }
});

test('hook handoff keeps caller wait cancellation and backend observation closure independent', async () => {
  const entered = deferred<void>(), allow = deferred<void>(), sent = deferred<void>(), receipt = deferred<void>();
  const f = await fixture(async (_method, params) => {
    sent.resolve();
    await receipt.promise;
    return { submissionId: asSubmitParams(params).submissionId, disposition: 'dispatched' };
  }, { hooks: { inputRevision: 'r1', beforeInput: [async () => { entered.resolve(); await allow.promise; }] } });
  try {
    const params = hookRequest(f.session.id, 'wait', 'x');
    const signal = new AbortController();
    const first = f.session.request('input/submit', params, { signal: signal.signal });
    const follower = f.session.request('input/submit', params);
    await entered.promise;
    const aborted = Promise.allSettled([first]);
    signal.abort();
    expect(await aborted).toMatchObject([{ status: 'rejected', reason: { code: 'REQUEST_ABORTED', outcomeUnknown: true } }]);
    allow.resolve();
    await sent.promise;
    const closed = Promise.allSettled([follower]);
    await f.session.dispose();
    expect(await closed).toMatchObject([{ status: 'rejected', reason: { code: 'OBSERVATION_CLOSED', outcomeUnknown: true } }]);
    expect(f.calls).toHaveLength(1);
  } finally { allow.resolve(); receipt.resolve(); await f.client.dispose(); }
});

test('pending input bytes are bounded across sessions and released by cancellation', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture(async (_method, params) => ({ submissionId: asSubmitParams(params).submissionId, disposition: 'dispatched' }), {
    runtime: { queue: { maxBytes: 2_048 } },
    hooks: { inputRevision: 'r1', beforeInput: [async event => {
      if (event.requestId === 'hold') { entered.resolve(); await release.promise; }
    }] },
  });
  try {
    const other = await f.client.sessions.create({ cwd: process.cwd() });
    const first = f.session.request('input/submit', hookRequest(f.session.id, 'hold', 'x'.repeat(1_400)));
    await entered.promise;
    await expect(other.request('input/submit', hookRequest(other.id, 'oversubscribed', 'x'.repeat(1_400))))
      .rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED', outcomeUnknown: false });
    // This session can still process an independent small request.
    await other.request('input/submit', hookRequest(other.id, 'small', 'x'));
    const cancelled = Promise.allSettled([first]);
    await f.session.dispose();
    expect(await cancelled).toMatchObject([{ status: 'rejected', reason: { code: 'SESSION_CLOSED', outcomeUnknown: false } }]);
    await other.request('input/submit', hookRequest(other.id, 'large', 'x'.repeat(1_400)));
    expect(f.calls.map(call => call.params.requestId)).toEqual(['small', 'large']);
  } finally { release.resolve(); await f.client.dispose(); }
});

/** Hold the native receipt until association returns a Turn, proving submission observation cannot depend on receipt acknowledgement; finally releases the gate and client. */
test('submit returns a Turn from binding before a delayed receipt; no public Submission stage', async () => {
  const ack = deferred<void>();
  const f = await fixture(async (_m, p, sink) => {
    await started(sink, 'actual'); await sink.bindSubmission(asSubmitParams(p).submissionId, 'actual');
    await ack.promise; return { submissionId: asSubmitParams(p).submissionId, disposition: 'dispatched' };
  });
  try {
    const turn = await f.session.submit({ input: 'x' }, { timeoutMs: 100 });
    expect(turn.id).toBe('actual'); expect('accepted' in turn).toBe(false);
    await completed(f.sink, turn.id); expect((await turn.result()).text).toBe('answer');
  } finally { ack.resolve(); await f.client.dispose(); }
});

/** Complete native work before binding so the public result must come from retained execution state; dispose the fixture after asserting the early text. */
test('a backend without acceptance receipts binds a previously completed native result', async () => {
  const f = await fixture(async (_m, p, sink) => {
    await started(sink, 'actual'); await completed(sink, 'actual', 'early');
    await sink.bindSubmission(asSubmitParams(p).submissionId, 'actual');
    return { submissionId: asSubmitParams(p).submissionId, disposition: 'dispatched' };
  });
  try { expect(await (await f.session.submit({ input: 'x' })).result()).toMatchObject({ text: 'early', status: 'completed' }); }
  finally { await f.client.dispose(); }
});

/** Join one execution through two submissions, abort/dispose one observer, and require the sibling to retain the native result without extra dispatch. */
test('two submissions share one actual result and independent observers', async () => {
  const f = await fixture(async (_m, p, sink) => {
    await started(sink, 'shared'); await sink.bindSubmission(asSubmitParams(p).submissionId, 'shared');
    return { submissionId: asSubmitParams(p).submissionId, accepted: true, disposition: 'joined', turnId: 'shared' };
  });
  try {
    const a = await f.session.submit({ input: 'a' }), b = await f.session.submit({ input: 'b' });
    expect(a).not.toBe(b); expect(a.id).toBe(b.id);
    const abort = new AbortController(); const wait = a.result({ signal: abort.signal }); abort.abort();
    await expect(wait).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    await a.dispose(); await completed(f.sink, b.id, 'shared answer');
    expect((await b.result()).text).toBe('shared answer'); expect(f.calls).toHaveLength(2);
  } finally { await f.client.dispose(); }
});

/** Abort only the submission wait while dispatch remains gated; capture later binding/completion events and drain the reader during cleanup. */
test('cancelled submit waiting retains dispatch and later association without resending', async () => {
  const sent = deferred<void>(), release = deferred<void>(); let submitted = '';
  const f = await fixture(async (_m, p) => { submitted = asSubmitParams(p).submissionId; sent.resolve(); await release.promise; return { submissionId: submitted, disposition: 'dispatched' }; });
  const events: AhpEvent[] = [];
  const reading = (async () => { try { for await (const event of f.session.events()) events.push(event); } catch {} })();
  try {
    const abort = new AbortController(); const waiting = f.session.submit({ input: 'x' }, { signal: abort.signal });
    await sent.promise; abort.abort(); await expect(waiting).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(f.session.snapshot.status).toBe('ready');
    await started(f.sink, 'late'); await f.sink.bindSubmission(submitted, 'late'); await completed(f.sink, 'late');
    expect(events.some(e => e.type === 'submission/bound' && e.payload.submissionId === submitted)).toBe(true);
    expect(f.calls).toHaveLength(1);
  } finally { release.resolve(); await f.client.dispose(); await reading; }
});

/** Repeat completed work at a one-execution limit so newly admitted submissions cannot pin snapshots that predate them; release the client in finally. */
test('completed snapshots rotate while newly pending submissions do not pin older executions', async () => {
  let n = 0;
  const f = await fixture(async (_m, p, sink) => {
    const id = `turn-${++n}`; await started(sink, id); await sink.bindSubmission(asSubmitParams(p).submissionId, id); await completed(sink, id);
    return { submissionId: asSubmitParams(p).submissionId, accepted: true, disposition: 'started', turnId: id };
  }, { limits: { maxExecutions: 1, maxSubmissions: 2 } });
  try {
    for (let i = 0; i < 6; i++) expect((await (await f.session.submit({ input: 'x' })).result()).status).toBe('completed');
    expect(f.session.snapshot.status).toBe('ready');
  } finally { await f.client.dispose(); }
});

/** Leave an older submission unbound after completion, then force capacity pressure; require failure instead of eviction of its possible late result. */
test('older unbound input pins its possible late result instead of silently evicting it', async () => {
  let n = 0;
  const f = await fixture(async (_m, p, sink) => {
    if (++n === 1) { await started(sink, 'first'); await completed(sink, 'first'); }
    else await started(sink, 'second');
    return { submissionId: asSubmitParams(p).submissionId, disposition: 'dispatched' };
  }, { limits: { maxExecutions: 1 } });
  try {
    await expect(f.session.submit({ input: 'first' }, { timeoutMs: 5 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await expect(f.session.submit({ input: 'second' })).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' });
    expect(f.session.snapshot.status).toBe('closed');
  } finally { await f.client.dispose(); }
});

/** Reject a second native input definitively while retaining the first execution; completing the first proves rejection stays local to its submission. */
test('definite input rejection leaves another execution usable', async () => {
  let n = 0;
  const f = await fixture(async (_m, p, sink) => {
    if (++n === 2) throw new HarnessSdkError('NATIVE_BUSY');
    await started(sink, 'kept'); return { submissionId: asSubmitParams(p).submissionId, accepted: true, disposition: 'started', turnId: 'kept' };
  });
  try {
    const a = await f.session.submit({ input: 'a' }); await expect(f.session.submit({ input: 'b' })).rejects.toMatchObject({ code: 'NATIVE_BUSY' });
    await completed(f.sink, a.id); expect((await a.result()).status).toBe('completed');
  } finally { await f.client.dispose(); }
});

/** Complete two active executions in reverse order using the same item ID; verify activity and final text stay scoped to each turn. */
test('interleaved executions and reused item IDs remain isolated', async () => {
  let n = 0;
  const f = await fixture(async (_m,p,sink) => { const turnId = `actual-${++n}`; await started(sink, turnId); return { submissionId: asSubmitParams(p).submissionId, accepted: true, disposition: 'started', turnId }; });
  try {
    const a = await f.session.submit({ input: 'a' }), b = await f.session.submit({ input: 'b' });
    expect(f.session.snapshot.activeTurnIds).toEqual([a.id,b.id]);
    await completed(f.sink,b.id,'b'); await completed(f.sink,a.id,'a');
    expect((await a.result()).text).toBe('a'); expect((await b.result()).text).toBe('b');
  } finally { await f.client.dispose(); }
});

/** Steer through the returned Turn and inspect the native atomic target; completion must still belong to the original execution. */
test('exact steer uses the actual target and keeps one execution', async () => {
  const f = await fixture(async (m,p,sink) => {
    if (m === 'turn/steer') { const v = p as AhpRequestMap['turn/steer']; return { accepted: true, submissionId: v.submissionId, turnId: v.expectedTurnId }; }
    await started(sink,'actual'); return { submissionId: asSubmitParams(p).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
  });
  try {
    const turn = await f.session.submit({ input: 'a' }); await turn.steer({ input: 'change scope' });
    expect(f.calls[1]!.params).toMatchObject({ expectedTurnId: turn.id }); expect(f.session.snapshot.activeTurnIds).toEqual([turn.id]);
    await completed(f.sink,turn.id); expect((await turn.result()).status).toBe('completed');
  } finally { await f.client.dispose(); }
});

/** Return a schema-valid steer receipt for another turn and require a protocol failure, preventing a successful receipt from hiding identity drift. */
test('mismatched native steer identity fails closed rather than reporting success', async () => {
  const f = await fixture(async (m,p,sink) => {
    if (m === 'turn/steer') { const v = p as AhpRequestMap['turn/steer']; return { accepted: true, submissionId: v.submissionId, turnId: 'wrong' }; }
    await started(sink,'actual');return { submissionId: asSubmitParams(p).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
  });
  try { const turn=await f.session.submit({input:'a'}); await expect(turn.steer({input:'b'})).rejects.toMatchObject({code:'PROTOCOL_ERROR'}); }
  finally {await f.client.dispose();}
});

/** Apply omitted/null metadata fields and a native revert reference through public entry points; snapshots must preserve patch semantics and resume identity. */
test('metadata patches and revert refs update snapshots and resume references', async () => {
  const f=await fixture(async (_m,p)=>({appliedScope:'conversation',boundary:(p as AhpRequestMap['session/revert']).boundary,nativeRef:{provider:'fixture',value:'new'}}));
  try {
    await f.sink.emit({type:'session/metadata',payload:{title:'new title'}});
    await f.sink.emit({type:'session/metadata',payload:{}});expect(f.session.snapshot.metadata?.title).toBe('new title');
    await f.session.request('session/revert',{sessionId:f.session.id,requestId:'revert',scope:'conversation',boundary:{turnId:'boundary',relation:'before'}});
    expect(f.session.reference.binding.nativeRef?.value).toBe('new');
    await f.sink.emit({type:'session/metadata',payload:{title:null}});expect(f.session.snapshot.metadata?.title).toBeNull();
  }finally{await f.client.dispose();}
});

/** Gate native close to inspect control admission and concurrent callers; after release require one cleanup, retained terminal results and unknown unfinished outcomes. */
test('active close is shared, preserves retained terminals and leaves unfinished results unknown', async () => {
  const closeRelease = deferred<void>();
  let n = 0;
  const f = await fixture(async (m, p, sink) => {
    if (m === 'session/close') {
      await closeRelease.promise;
      return closeResult;
    }
    if (m === 'turn/interrupt') return { accepted: true, turnId: (p as AhpRequestMap['turn/interrupt']).turnId };
    const turnId = `turn-${++n}`;
    await started(sink, turnId);
    return { submissionId: asSubmitParams(p).submissionId, accepted: true, disposition: 'started', turnId };
  });
  try {
    const finished = await f.session.submit({ input: 'first' });
    await completed(f.sink, finished.id);
    const active = await f.session.submit({ input: 'second' });

    const firstClose = f.session.close();
    const secondClose = f.session.close();
    await expect(f.session.submit({ input: 'late' })).rejects.toMatchObject({ code: 'SESSION_CLOSING' });
    await active.interrupt();
    closeRelease.resolve();
    expect(await firstClose).toEqual(closeResult);
    await secondClose;

    await expect(active.result()).rejects.toMatchObject({ code: 'OBSERVATION_CLOSED', outcomeUnknown: true, details: { source: 'sdk' } });
    expect((await finished.result()).status).toBe('completed');
    expect(f.calls.filter(c => c.method === 'session/close')).toHaveLength(1);
    expect(f.disposals).toBe(1);
  } finally {
    closeRelease.resolve();
    await f.client.dispose();
  }
});

/** Reject native close definitively, then complete active work to prove business admission/status can recover without discarding the execution. */
test('definite close rejection restores an active session',async()=>{
  const f=await fixture(async(m,p,sink)=>{if(m==='session/close')throw new HarnessSdkError('CLOSE_DENIED');await started(sink,'active');return {submissionId:asSubmitParams(p).submissionId,accepted:true,disposition:'started',turnId:'active'};});
  try{const turn=await f.session.submit({input:'x'});await expect(f.session.close()).rejects.toMatchObject({code:'CLOSE_DENIED'});expect(f.session.snapshot.status).toBe('running');await completed(f.sink,turn.id);expect((await turn.result()).status).toBe('completed');}
  finally{await f.client.dispose();}
});

/** Hold close past the default timeout but within the explicit observer deadline; release in finally so late native cleanup cannot be abandoned. */
test('close honors a longer caller deadline than the default request timeout', async () => {
  const release = deferred<void>();
  const f = await fixture(async () => { await release.promise; return closeResult; }, { runtime: { requestTimeoutMs: 5 } });
  try {
    let settled = false;
    const closing = f.session.close({ timeoutMs: 1000 });
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release.resolve();
    expect(await closing).toEqual(closeResult);
    expect(f.session.snapshot.status).toBe('closed');
    expect(f.disposals).toBe(1);
  } finally { release.resolve(); await f.client.dispose(); }
});

/** Abort and time out separate observers of a gated shared close; a surviving observer must see its single native receipt and resource release. */
test('timing out or aborting a close observer preserves the shared close and its late cleanup', async () => {
  const release = deferred<void>();
  const f = await fixture(async () => { await release.promise; return closeResult; });
  try {
    const controller = new AbortController();
    const aborted = f.session.close({ signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    await expect(f.session.close({ timeoutMs: 5 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(f.session.snapshot.status).toBe('closing');
    const closing = f.session.close();
    release.resolve();
    expect(await closing).toEqual(closeResult);
    expect(f.session.snapshot.status).toBe('closed');
    expect(f.calls.filter(call => call.method === 'session/close')).toHaveLength(1);
    expect(f.disposals).toBe(1);
  } finally { release.resolve(); await f.client.dispose(); }
});

/** Repeatedly exceed frame capacity before dispatch, then submit valid work at a one-submission limit to verify admission failures release bookkeeping. */
test('inputs rejected before native dispatch do not exhaust submission capacity', async () => {
  const f = await fixture(async (_method, params, sink) => {
    await started(sink, 'valid'); await sink.bindSubmission(asSubmitParams(params).submissionId, 'valid');
    await completed(sink, 'valid');
    return { submissionId: asSubmitParams(params).submissionId, disposition: 'dispatched' };
  }, { limits: { maxSubmissions: 1 }, runtime: { queue: { maxFrameBytes: 2048 } } });
  try {
    for (let i = 0; i < 3; i++) await expect(f.session.submit({ input: 'x'.repeat(3000) })).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' });
    expect((await (await f.session.submit({ input: 'valid' })).result()).status).toBe('completed');
    expect(f.calls).toHaveLength(1);
  } finally { await f.client.dispose(); }
});

/** Occupy the request cache with gated maintenance, reject inputs, then release it; valid input must reuse submission capacity without hidden native attempts. */
test('request-cache backpressure before dispatch also releases submission capacity', async () => {
  const release = deferred<void>();
  const f = await fixture(async (method, params, sink) => {
    if (method === 'compact/start') { await release.promise; return { maintenanceId: 'compact', status: 'completed' }; }
    await started(sink, 'valid'); await sink.bindSubmission(asSubmitParams(params).submissionId, 'valid');
    await completed(sink, 'valid');
    return { submissionId: asSubmitParams(params).submissionId, disposition: 'dispatched' };
  }, { limits: { maxSubmissions: 1 }, runtime: { requestCacheSize: 1 } });
  try {
    const compact = f.session.request('compact/start', { sessionId: f.session.id, requestId: 'compact' });
    for (let i = 0; i < 3; i++) await expect(f.session.submit({ input: 'blocked' })).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' });
    release.resolve(); await compact;
    expect((await (await f.session.submit({ input: 'valid' })).result()).status).toBe('completed');
    expect(f.calls.map(call => call.method)).toEqual(['compact/start', 'input/submit']);
  } finally { release.resolve(); await f.client.dispose(); }
});

/** Use malformed wait options and a foreign session identity; all public failures must precede native dispatch. */
test('invalid timeout parameters and mismatched session bindings never dispatch requests',async()=>{
  const f=await fixture(async()=>closeResult);
  try{
    await expect(f.session.submit({input:'x'},{timeoutMs:0})).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await expect(f.session.close({timeoutMs:Infinity})).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await expect(f.session.request('compact/start',{sessionId:'wrong',requestId:'x'})).rejects.toMatchObject({code:'SESSION_BINDING_MISMATCH'});
    expect(f.calls).toHaveLength(0);
  }finally{await f.client.dispose();}
});

/** Replay one raw request concurrently and then vary request/submission identity separately; require exactly one dispatch and distinct conflict errors. */
test('raw requests dedupe and reject conflicting submission identity',async()=>{
  const f=await fixture(async(_m,p,sink)=>{await started(sink,'actual');return {submissionId:asSubmitParams(p).submissionId,accepted:true,disposition:'started',turnId:'actual'};});
  try{
    const p:AhpRequestMap['input/submit']={sessionId:f.session.id,requestId:'request',submissionId:'input',delivery:'native',input:[{type:'text',text:'a'}]};
    const [a,b]=await Promise.all([f.session.request('input/submit',p),f.session.request('input/submit',p)]);expect(a).toEqual(b);expect(f.calls).toHaveLength(1);
    await expect(f.session.request('input/submit',{...p,input:[{type:'text',text:'b'}]})).rejects.toMatchObject({code:'REQUEST_ID_CONFLICT'});
    await expect(f.session.request('input/submit',{...p,requestId:'other'})).rejects.toMatchObject({code:'SUBMISSION_ID_CONFLICT'});
  }finally{await f.client.dispose();}
});

/** Patch a retained tool snapshot before interrupted completion; the result must reflect new content while preserving item identity. */
test('item-shaped patch snapshots update retained results without changing item identity', async () => {
  const f = await fixture(async (_method, params, sink) => {
    await started(sink, 'actual'); await sink.bindSubmission(asSubmitParams(params).submissionId, 'actual');
    return { submissionId: asSubmitParams(params).submissionId, disposition: 'dispatched' };
  });
  try {
    const turn = await f.session.submit({ input: 'work' });
    await f.sink.emit({ type: 'item/started', payload: { item: { id: 'tool', type: 'toolCall', kind: 'command', title: 'Work', input: { command: 'old' } } } }, { turnId: turn.id });
    await f.sink.emit({ type: 'item/delta', payload: { itemId: 'tool', kind: 'patch', value: { id: 'tool', type: 'toolCall', kind: 'command', title: 'Work', input: { command: 'new' } } } }, { turnId: turn.id });
    await f.sink.emit({ type: 'turn/completed', payload: { turnId: turn.id, status: 'interrupted' } });
    expect((await turn.result()).items).toMatchObject([{ id: 'tool', input: { command: 'new' } }]);
  } finally { await f.client.dispose(); }
});

/** Attempt identity and content-family changes through item patches; require both event rejection and typed observation failure for each isolated fixture. */
test('a patch cannot move an item into another identity or content family', async () => {
  const patches: import('@anureo/protocol').JsonObject[] = [ { id: 'other', type: 'agentMessage', text: 'bad' }, { id: 'item', type: 'notice', severity: 'info', text: 'bad' } ];
  for (const value of patches) {
    const f = await fixture(async (_method, params, sink) => {
      await started(sink, 'actual'); return { submissionId: asSubmitParams(params).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
    });
    try {
      const turn = await f.session.submit({ input: 'work' });
      await f.sink.emit({ type: 'item/started', payload: { item: { id: 'item', type: 'agentMessage', text: '' } } }, { turnId: turn.id });
      await expect(f.sink.emit({ type: 'item/delta', payload: { itemId: 'item', kind: 'patch', value } }, { turnId: turn.id })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      await expect(turn.result()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', details: { source: 'sdk' } });
    } finally { await f.client.dispose(); }
  }
});

/** Overflow one reader while draining a sibling; completion and retained results must survive without native interrupt dispatch. */
test('one overflowing observer does not interrupt a sibling or discard the retained native result', async () => {
  const f = await fixture(async (_method, params, sink) => {
    await started(sink, 'actual'); return { submissionId: asSubmitParams(params).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
  });
  try {
    const turn = await f.session.submit({ input: 'work' });
    const slow = turn.events({ queue: { maxEvents: 1 } })[Symbol.asyncIterator]();
    const sibling = turn.observe(), reader = sibling.events()[Symbol.asyncIterator]();
    const fast = (async () => { const events: AhpEvent[] = []; for (;;) { const next = await reader.next(); if (next.done) return events; events.push(next.value); } })();
    await f.sink.emit({ type: 'item/started', payload: { item: { id: 'message', type: 'agentMessage', text: '' } } }, { turnId: turn.id });
    await completed(f.sink, turn.id);
    await slow.next(); await expect(slow.next()).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' });
    expect((await fast).at(-1)?.type).toBe('turn/completed');
    expect((await sibling.result()).status).toBe('completed');
    expect(f.calls.every(call => call.method === 'input/submit')).toBe(true);
    await slow.return?.();
  } finally { await f.client.dispose(); }
});

/** Mark a secret through a manual interaction before native submission rejection; inspect public diagnostics for redaction while preserving the rejection code. */
test('submission rejection diagnostics redact marked answers and authentication fields', async () => {
  const sent = deferred<void>(); let submissionId = '';
  const f = await fixture(async (_method, params) => {
    submissionId = asSubmitParams(params).submissionId; sent.resolve(); return { submissionId, disposition: 'dispatched' };
  }, { interactions: { userInput: undefined } });
  try {
    const secret = 'PRIVATE_SUBMISSION_VALUE';
    const interaction = f.sink.requestInteraction({ kind: 'userInput', interactionId: 'secret', questions: [{ id: 'q', prompt: 'Secret', secret: true }] }, async () => {});
    await f.session.request('interaction/respond', { sessionId: f.session.id, requestId: 'answer', interactionId: 'secret', response: { kind: 'userInput', answers: { q: secret } } }); await interaction;
    const reader = f.session.events()[Symbol.asyncIterator]();
    const waiting = f.session.submit({ input: 'rejected' }); void waiting.catch(() => {}); await sent.promise;
    await f.sink.emit({ type: 'submission/status', payload: { submissionId, status: 'rejected', error: { code: 'NATIVE_REJECTED', message: secret, retryable: false, outcomeUnknown: false, details: { echoed: secret, authorization: 'Bearer credential' } } } });
    let rejected: AhpEvent | undefined;
    while (!rejected) { const next = await reader.next(); if (next.done) throw new Error('Missing rejection'); if (next.value.type === 'submission/status' && next.value.payload.status === 'rejected') rejected = next.value; }
    expect(JSON.stringify(rejected)).not.toContain(secret); expect(JSON.stringify(rejected)).not.toContain('Bearer credential');
    await expect(waiting).rejects.toMatchObject({ code: 'NATIVE_REJECTED' }); await reader.return?.();
  } finally { await f.client.dispose(); }
});

/** Pass invalid JavaScript values through the typed facade deliberately; each must reject with validation before invoking the adapter. */
test('malformed JavaScript input fails with typed validation before native dispatch', async () => {
  const f = await fixture(async () => closeResult);
  try {
    for (const value of [undefined, null, 42, { text: 'missing discriminant' }, [() => 'uncloneable']]) {
      await expect(f.session.submit({ input: value as unknown as import('../index').Input })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(f.calls).toHaveLength(0);
  } finally { await f.client.dispose(); }
});

/** Fail client initialization with both cleanup outcomes; require original error identity or ordered aggregation and exactly one adapter release. */
for (const cleanupFails of [false, true]) test(`failed client initialization preserves setup and cleanup failures (cleanupFails=${cleanupFails})`, async () => {
  const f = await fixture(async () => closeResult);
  const setupFailure = new HarnessSdkError('SETUP_FAILED');
  let releases = 0;
  const adapter: HarnessAdapter = {
    ...f.adapter,
    /** Fail before opens so the factory must release its adapter before rejecting. */
    async initialize() { throw setupFailure; },
    /** Count the release attempt and optionally fail to exercise safe aggregation. */
    async dispose() { releases++; if (cleanupFails) throw new HarnessSdkError('CLEANUP_FAILED'); },
  };
  try {
    const opening = createClient({ adapter, identity: f.client.identity });
    if (cleanupFails) {
      await expect(opening).rejects.toMatchObject({
        code: 'RESOURCE_RELEASE_FAILED',
        details: { errors: [{ code: 'SETUP_FAILED' }, { code: 'CLEANUP_FAILED' }] },
      });
    } else await expect(opening).rejects.toBe(setupFailure);
    expect(releases).toBe(1);
  } finally { await f.client.dispose(); }
});

/** Count native opens while varying foreign bindings and fork modes, then admit one valid fork to prove validation does not poison later admission. */
test('open admission rejects invalid bindings and fork modes before native dispatch', async () => {
  const f = await fixture(async () => closeResult);
  let opens = 0;
  const nativeOpen = f.adapter.openSession;
  /** Count opens while preserving the fixture's native backend behavior. */
  f.adapter.openSession = async (params, sink) => { opens++; return nativeOpen(params, sink); };
  const reference = { ...f.session.reference, binding: { ...f.session.binding, nativeRef: { provider: 'fixture', value: 'native-session' } } };
  const foreign = { ...reference, binding: { ...reference.binding, runtimeConfigId: 'foreign' } };
  try {
    await expect(f.client.sessions.resume(foreign)).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' });
    await expect(f.client.sessions.fork(foreign, { boundary: { turnId: 'turn', relation: 'before' } })).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' });
    await expect(f.client.openSession({ ...reference, mode: 'fork', requestId: 'missing-fork' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(f.client.sessions.fork(reference, { boundary: { turnId: 'turn', relation: 'through' } })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(opens).toBe(0);
    const fork = await f.client.sessions.fork(reference, { boundary: { turnId: 'turn', relation: 'before' } });
    expect(fork.id).not.toBe(f.session.id);
    expect(opens).toBe(1);
  } finally { await f.client.dispose(); }
});

/** Abort a public open before a gated native backend arrives; wait for its release to prove late attachment cannot reopen or leak native ownership. */
test('aborting an open observer still releases a late native backend without reopening', async () => {
  const f = await fixture(async () => closeResult);
  const entered = deferred<void>(), release = deferred<void>(), disposed = deferred<void>();
  const nativeOpen = f.adapter.openSession;
  let opens = 0, releases = 0;
  /** Hold native attachment beyond the caller's cancellation to exercise late cleanup. */
  f.adapter.openSession = async (params, sink) => {
    opens++; entered.resolve(); await release.promise;
    const backend = await nativeOpen(params, sink);
    return { ...backend,
      /** Observe late native resource release independently of the rejected open Promise. */
      async dispose() { releases++; await backend.dispose(); disposed.resolve(); },
    };
  };
  const abort = new AbortController();
  try {
    const opening = f.client.sessions.create({ cwd: process.cwd() }, { signal: abort.signal });
    void opening.catch(() => {});
    await entered.promise; abort.abort();
    await expect(opening).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(releases).toBe(0);
    release.resolve(); await disposed.promise;
    await f.client.dispose();
    expect(opens).toBe(1); expect(releases).toBe(1);
  } finally { release.resolve(); await f.client.dispose(); }
});

/** Delay one owned session release and observe shared client disposal; admission must close immediately and adapter cleanup must follow every session. */
test('client disposal closes admission and waits for sessions before releasing the adapter', async () => {
  const f = await fixture(async () => closeResult);
  const disposingSession = deferred<void>(), release = deferred<void>();
  const order: string[] = [];
  const nativeOpen = f.adapter.openSession;
  /** Give an additional owned session a controllably slow release. */
  f.adapter.openSession = async (params, sink) => {
    const backend = await nativeOpen(params, sink);
    return { ...backend,
      /** Delay session cleanup so adapter ordering and shared disposal are observable. */
      async dispose() {
        disposingSession.resolve(); await release.promise; await backend.dispose(); order.push('session');
      },
    };
  };
  /** Record client-wide release after every owned session has settled. */
  f.adapter.dispose = async () => { order.push('adapter'); };
  try {
    await f.client.sessions.create({ cwd: process.cwd() });
    const disposal = f.client.dispose();
    expect(f.client.dispose()).toBe(disposal);
    await disposingSession.promise;
    await expect(f.client.sessions.create({ cwd: process.cwd() })).rejects.toMatchObject({ code: 'CLIENT_DISPOSED' });
    expect(order).toEqual([]);
    release.resolve(); await disposal;
    expect(order).toEqual(['session', 'adapter']);
    expect(f.disposals).toBe(2);
  } finally { release.resolve(); await f.client.dispose(); }
});

/** Manually settle an interaction while its automatic handler is gated; the aborted handler must keep its capacity slot until host work settles, then permit a new interaction without sending a late answer. */
test('aborted automatic handlers retain capacity until host work settles and suppress late answers', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let signal: AbortSignal | undefined;
  let handlers = 0;
  const response = { kind: 'userInput', answers: { q: 'answer' } } as const;
  const responses: Array<unknown> = [];
  const f = await fixture(async () => closeResult, {
    runtime: { maxPendingInteractions: 1 },
    interactions: {
      /** Hold only the first handler beyond native settlement so capacity tracks live host work rather than registry membership. */
      userInput: async (_request, context) => {
        if (++handlers === 1) {
          signal = context.signal;
          entered.resolve();
          await release.promise;
        }
        return response;
      },
    },
  });
  /** Record native replies/cancellations; late automatic answers would add an unwanted extra reply. */
  const responder = async (value: unknown, reason?: string) => { responses.push({ value, reason }); };
  /** Allocate independent registry identities while keeping the response contract identical. */
  const request = (interactionId: string) => ({ kind: 'userInput' as const, interactionId, questions: [{ id: 'q', prompt: 'Question' }] });
  try {
    const pending = f.sink.requestInteraction(request('first'), responder);
    await entered.promise;
    await f.session.request('interaction/respond', { sessionId: f.session.id, requestId: 'manual', interactionId: 'first', response });
    expect(await pending).toEqual(response);
    expect(signal?.aborted).toBe(true);
    await expect(f.sink.requestInteraction(request('blocked'), responder)).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' });
    expect(handlers).toBe(1);

    release.resolve();
    // Let the released handler's response guard and finally run before probing capacity again.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await f.sink.requestInteraction(request('next'), responder)).toEqual(response);
    expect(handlers).toBe(2);
    expect(responses).toEqual([
      { value: response, reason: undefined },
      { value: null, reason: 'capacity' },
      { value: response, reason: undefined },
    ]);
  } finally { release.resolve(); await f.client.dispose(); }
});
