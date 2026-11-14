// Exercises cooperating client/session lifecycle contracts; must not replace production admission or cleanup policy.
import { expect, test } from 'bun:test';
import { createClient, HarnessSdkError, type ClientOptions, type HarnessAdapter, type SessionEventSink, type SessionMethod } from '../index';
import { AHP_PROTOCOL_CONTRACT, type AhpEvent, type AhpRequestMap, type AhpResultMap, type Capabilities } from '@anureo/protocol';
import { deferred } from './deferred';

/** Fixture close receipt keeps native stop unconfirmed so tests cannot mistake observation teardown for execution completion. */
const closeResult = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' } as const;
/** Fixture negotiation advertises the controls used below; tests override behavior through Run rather than capability bypasses. */
const capabilities: Capabilities = {
  input: { delivery: ['native', 'afterTurn'], steer: { target: 'turn', atomicMatch: true }, interrupt: { targets: ['turn','session'], reportsPendingInputs: true } },
  turn: { inputModalities: ['text'], overrides: ['model'] },
  session: { history: true, resume: true, fork: ['before'], revert: ['conversation'] },
  config: { options: [{ id: 'model', scope: 'session', schema: { type: 'string' } }] },
  review: true, compact: true, goal: { actions: ['set','clear'] }, interactions: ['userInput'],
};
/** fixture supplies this callback to its backend execute port, recording dispatch before the test controls events, receipt or rejection. */
type Run = (method: SessionMethod, params: AhpRequestMap[SessionMethod], sink: SessionEventSink) => Promise<unknown>;
/** Build a public client/session around Run and return native dispatch, event and release probes. Client invokes the fixture adapter ports; setup failures reject. Tests own gates/readers and must await client.dispose in finally; the fixture starts no processes. */
async function fixture(run: Run, options: Partial<ClientOptions> = {}) {
  // Native open assigns the sink before session creation resolves or any test can dispatch.
  let sink!: SessionEventSink, disposals = 0;
  const calls: Array<{ method: SessionMethod; params: AhpRequestMap[SessionMethod] }> = [];
  const adapter: HarnessAdapter = {
    /** withStructuredOutput forwards Client.initialize here; assert negotiation and return capabilities without acquiring native resources. */
    async initialize(p) { expect(p.protocolContract).toBe(AHP_PROTOCOL_CONTRACT); return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'fixture', version: '1', adapter: 'fixture' }, capabilities }; },
    /** OutputSession.open invokes this port; capture its forwarding sink and return an owned in-memory backend. */
    async openSession(p, events) {
      sink = events;
      return { binding: p.binding, capabilities,
        /** OutputSession.execute invokes this backend port; record the attempt and propagate Run's receipt or rejection without retries. */
        async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> { calls.push({ method, params }); return await run(method, params, sink) as AhpResultMap[M]; },
        /** OutputSession.dispose releases this backend; count attempts so tests can detect repeated cleanup. */
        async dispose() { disposals++; },
      };
    },
    /** Client.dispose reaches this through the output wrapper after session cleanup; the fixture owns no adapter resources. */
    async dispose() {},
  };
  const client = await createClient({ adapter, identity: { adapterId: 'fixture', runtimeConfigId: 'local' }, ...options });
  return { client, adapter, session: await client.sessions.create({ cwd: process.cwd() }), calls,
    /** Tests read the captured forwarding sink after open resolves, including for events after a caller wait ends. */
    get sink() { return sink; },
    /** Tests read completed native release attempts after awaiting lifecycle cleanup. */
    get disposals() { return disposals; }
  };
}
/** Test Run callbacks await ordered turn/started publication before binding or item events; sink rejection stops the simulated native sequence. */
async function started(sink: SessionEventSink, turnId: string) { await sink.emit({ type: 'turn/started', payload: { turnId } }); }
/** Tests and Run callbacks await final-item then terminal publication, propagating sink failure. Reuse the item ID across turns to expose missing execution isolation; callers still own fixture cleanup. */
async function completed(sink: SessionEventSink, turnId: string, text = 'answer') {
  await sink.emit({ type: 'item/completed', payload: { item: { id: 'reused', type: 'agentMessage', text, phase: 'final' } } }, { turnId });
  await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } });
}
/** Submission-specific Run callbacks recover their known request type here; this test assertion neither validates params nor changes native admission. */
const asSubmitParams = (p: AhpRequestMap[SessionMethod]) => p as AhpRequestMap['input/submit'];

/** Gate the native receipt after binding and require submit to return a Turn first; the public observer must reach completion without an acknowledgement dependency. Finally release both gate and client. */
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

/** Publish native completion before association, then bind without an acceptance receipt. The public Turn must expose retained early text; finally dispose the client. */
test('a backend without acceptance receipts binds a previously completed native result', async () => {
  const f = await fixture(async (_m, p, sink) => {
    await started(sink, 'actual'); await completed(sink, 'actual', 'early');
    await sink.bindSubmission(asSubmitParams(p).submissionId, 'actual');
    return { submissionId: asSubmitParams(p).submissionId, disposition: 'dispatched' };
  });
  try { expect(await (await f.session.submit({ input: 'x' })).result()).toMatchObject({ text: 'early', status: 'completed' }); }
  finally { await f.client.dispose(); }
});

/** Associate two inputs with one native execution and cancel/dispose only one Turn observer. Its sibling must retain the shared result with no extra dispatch; finally dispose the client. */
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

/** Abort only the association observer of gated native dispatch. Later binding/completion must still publish once; finally release the receipt gate, dispose the client and drain the event reader. */
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

/** Force repeated native completions through one execution slot. New submissions must rotate older snapshots rather than pin results that predate them; finally release the fixture. */
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

/** Leave an older submission unbound after native completion, then exceed execution capacity. Observation must fail instead of losing its possible late result; finally dispose the client. */
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

/** Reject a second submission definitively while the first execution remains active. Only the rejected input wait must fail, and the retained Turn must still complete; finally dispose the client. */
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

/** Complete two active executions in reverse order with the same native item ID. Public activity and retained text must remain execution-local; finally dispose the fixture. */
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

/** Call the returned Turn control and inspect its native atomic target. A successful steer must retain the original execution and terminal result; finally dispose the client. */
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

/** Return a shape-valid steer receipt naming a different execution. The public control must reject PROTOCOL_ERROR, preserving identity validation before successful receipt handling; finally release the client. */
test('mismatched native steer identity fails closed rather than reporting success', async () => {
  const f = await fixture(async (m,p,sink) => {
    if (m === 'turn/steer') { const v = p as AhpRequestMap['turn/steer']; return { accepted: true, submissionId: v.submissionId, turnId: 'wrong' }; }
    await started(sink,'actual');return { submissionId: asSubmitParams(p).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
  });
  try { const turn=await f.session.submit({input:'a'}); await expect(turn.steer({input:'b'})).rejects.toMatchObject({code:'PROTOCOL_ERROR'}); }
  finally {await f.client.dispose();}
});

/** Apply native metadata omission/null patches and a request-owned revert reference. Public snapshots and resume references must preserve those distinct updates; finally dispose the fixture. */
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

/** Gate shared native close while testing business rejection and explicit Turn control admission. After receipt, require one release, preserved completed results and unknown unfinished observation; finally release the gate and client. */
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

/** Reject native close definitively and then complete the active execution. The failed close must restore running status without losing the Turn; finally dispose the client. */
test('definite close rejection restores an active session',async()=>{
  const f=await fixture(async(m,p,sink)=>{if(m==='session/close')throw new HarnessSdkError('CLOSE_DENIED');await started(sink,'active');return {submissionId:asSubmitParams(p).submissionId,accepted:true,disposition:'started',turnId:'active'};});
  try{const turn=await f.session.submit({input:'x'});await expect(f.session.close()).rejects.toMatchObject({code:'CLOSE_DENIED'});expect(f.session.snapshot.status).toBe('running');await completed(f.sink,turn.id);expect((await turn.result()).status).toBe('completed');}
  finally{await f.client.dispose();}
});

/** Hold native close beyond the default wait but inside an explicit caller deadline. The surviving observer must receive the late receipt and cleanup; finally release the gate and client. */
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

/** Abort and time out separate observers of one gated native close. A remaining observer must still receive one receipt after resource release; finally release the gate and dispose the client. */
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

/** Reject oversized inputs before native dispatch at a one-submission limit. A later valid input must still complete with exactly one native attempt; finally dispose the client. */
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

/** Fill the request cache with gated maintenance, reject inputs, then release maintenance. New input must regain submission capacity without hidden dispatches; finally release the gate and client. */
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

/** Supply malformed waits and foreign session identity through public methods. Typed admission errors must precede every native attempt; finally dispose the client. */
test('invalid timeout parameters and mismatched session bindings never dispatch requests',async()=>{
  const f=await fixture(async()=>closeResult);
  try{
    await expect(f.session.submit({input:'x'},{timeoutMs:0})).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await expect(f.session.close({timeoutMs:Infinity})).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await expect(f.session.request('compact/start',{sessionId:'wrong',requestId:'x'})).rejects.toMatchObject({code:'SESSION_BINDING_MISMATCH'});
    expect(f.calls).toHaveLength(0);
  }finally{await f.client.dispose();}
});

/** Replay the same raw request concurrently, then vary payload and submission reservation independently. Require one native attempt plus distinct request/submission conflict errors; finally dispose the fixture. */
test('raw requests dedupe and reject conflicting submission identity',async()=>{
  const f=await fixture(async(_m,p,sink)=>{await started(sink,'actual');return {submissionId:asSubmitParams(p).submissionId,accepted:true,disposition:'started',turnId:'actual'};});
  try{
    const p:AhpRequestMap['input/submit']={sessionId:f.session.id,requestId:'request',submissionId:'input',delivery:'native',input:[{type:'text',text:'a'}]};
    const [a,b]=await Promise.all([f.session.request('input/submit',p),f.session.request('input/submit',p)]);expect(a).toEqual(b);expect(f.calls).toHaveLength(1);
    await expect(f.session.request('input/submit',{...p,input:[{type:'text',text:'b'}]})).rejects.toMatchObject({code:'REQUEST_ID_CONFLICT'});
    await expect(f.session.request('input/submit',{...p,requestId:'other'})).rejects.toMatchObject({code:'SUBMISSION_ID_CONFLICT'});
  }finally{await f.client.dispose();}
});

/** Abandon one wait while its native request fills the cache; identical replay must survive pressure, and only a settled outcome may make room for new work. */
test('a full request cache replays abandoned work without evicting its unsettled outcome', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const result = { maintenanceId: 'compact', status: 'completed' } as const;
  const f = await fixture(async () => { entered.resolve(); await release.promise; return result; }, {
    runtime: { requestCacheSize: 1 },
  });
  try {
    const params: AhpRequestMap['compact/start'] = { sessionId: f.session.id, requestId: 'original' };
    const controller = new AbortController();
    const abandoned = f.session.request('compact/start', params, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });

    const replay = f.session.request('compact/start', params);
    await expect(f.session.request('compact/start', { ...params, requestId: 'new' })).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' });
    expect(f.calls).toHaveLength(1);
    release.resolve();
    expect(await replay).toEqual(result);

    expect(await f.session.request('compact/start', { ...params, requestId: 'new' })).toEqual(result);
    expect(f.calls.map(call => call.params.requestId)).toEqual(['original', 'new']);
  } finally { release.resolve(); await f.client.dispose(); }
});

/** Abandon a history wait while its host projection is gated. Replay must await one projected, revalidated outcome, preserving privacy and frozen results; finally release the gate and client. */
for (const validProjection of [true, false]) test(`history projection survives caller cancellation and revalidates hook output (valid=${validProjection})`, async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const secret = 'PRIVATE_HISTORY_VALUE';
  const nativePage: AhpResultMap['history/read'] = { items: [{ turnId: 'old', item: { id: 'message', type: 'agentMessage', text: secret } }] };
  let projections = 0;
  const f = await fixture(async () => nativePage, {
    interactions: { userInput: undefined },
    runtime: {
      /** Session.executeRequest calls this after marked-secret projection; gate its result beyond caller abort and optionally return malformed JavaScript data. */
      async redactHistory(binding, page) {
        projections++;
        expect(binding.adapterId).toBe('fixture');
        expect(page.items[0]?.item).toMatchObject({ text: '[redacted]' });
        entered.resolve();
        await release.promise;
        return validProjection ? { ...page, snapshotToken: 'projected' } : { items: null } as unknown as AhpResultMap['history/read'];
      },
    },
  });
  try {
    const interaction = f.sink.requestInteraction({ kind: 'userInput', interactionId: 'secret', questions: [{ id: 'q', prompt: 'Secret', secret: true }] }, async () => {});
    await f.session.request('interaction/respond', { sessionId: f.session.id, requestId: 'answer', interactionId: 'secret', response: { kind: 'userInput', answers: { q: secret } } });
    await interaction;
    const params: AhpRequestMap['history/read'] = { sessionId: f.session.id, requestId: 'history' };
    const controller = new AbortController();
    const abandoned = f.session.request('history/read', params, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    const replay = f.session.request('history/read', params);
    release.resolve();
    if (validProjection) {
      const result = await replay;
      expect(result.snapshotToken).toBe('projected');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.items[0]?.item)).toBe(true);
    } else {
      await expect(replay).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(projections).toBe(1);
    expect(f.calls.map(call => call.method)).toEqual(['history/read']);
    expect(nativePage.items[0]?.item).toMatchObject({ text: secret });
    expect(f.session.snapshot.status).toBe('ready');
  } finally { release.resolve(); await f.client.dispose(); }
});

/** Confirm native stop without a terminal event. Close must release the backend while the unfinished Turn still rejects with unknown result diagnostics; finally dispose the client. */
test('confirmed native close reports stop confirmation without inventing an unfinished Turn result', async () => {
  const receipt = { ...closeResult, executionStopped: 'confirmed' } as const;
  const f = await fixture(async (method, params, sink) => {
    if (method === 'session/close') return receipt;
    await started(sink, 'active');
    return { submissionId: asSubmitParams(params).submissionId, accepted: true, disposition: 'started', turnId: 'active' };
  });
  try {
    const turn = await f.session.submit({ input: 'work' });
    expect(await f.session.close()).toEqual(receipt);
    await expect(turn.result()).rejects.toMatchObject({
      code: 'OBSERVATION_CLOSED', outcomeUnknown: true,
      details: { source: 'sdk', executionStopped: 'confirmed' },
    });
    expect(f.disposals).toBe(1);
  } finally { await f.client.dispose(); }
});

/** Patch a retained tool snapshot before interrupted completion. Turn.result must expose the replacement content under the original item identity; finally dispose the client. */
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

/** Patch an item into a different identity or family in separate fixtures. Both sink publication and public observation must reject typed protocol errors; finally release each client. */
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

/** Overflow one Turn reader while draining a sibling. The sibling and retained result must complete without native interruption; return the slow reader and finally dispose the fixture. */
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

/** Register a marked answer through manual interaction, then reject native input with private diagnostics. Public status must redact content while the input wait retains its error code; release the reader and client. */
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

/** Pass malformed JavaScript values through a deliberate type assertion. submit must reject INVALID_PARAMS before the adapter is called; finally dispose the fixture. */
test('malformed JavaScript input fails with typed validation before native dispatch', async () => {
  const f = await fixture(async () => closeResult);
  try {
    for (const value of [undefined, null, 42, { text: 'missing discriminant' }, [() => 'uncloneable']]) {
      await expect(f.session.submit({ input: value as unknown as import('../index').Input })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(f.calls).toHaveLength(0);
  } finally { await f.client.dispose(); }
});

/** Exercise setup failure with successful and failed cleanup. createClient must preserve original failure identity or ordered safe aggregation, releasing the failed adapter exactly once; finally dispose the independent fixture client. */
for (const cleanupFails of [false, true]) test(`failed client initialization preserves setup and cleanup failures (cleanupFails=${cleanupFails})`, async () => {
  const f = await fixture(async () => closeResult);
  const setupFailure = new HarnessSdkError('SETUP_FAILED');
  let releases = 0;
  const adapter: HarnessAdapter = {
    ...f.adapter,
    /** The output wrapper forwards initialization here; reject before opens so createClient must await adapter cleanup. */
    async initialize() { throw setupFailure; },
    /** withStructuredOutput invokes this during failed initialization cleanup; count release and optionally reject so createClient must aggregate both causes. */
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

/** Count opens while checking wait, shape, identity and capability precedence. Rejections must acquire no backend, and one valid fork must still open afterward; finally dispose the client. */
test('open admission rejects invalid bindings and fork modes before native dispatch', async () => {
  const f = await fixture(async () => closeResult);
  let opens = 0;
  const nativeOpen = f.adapter.openSession;
  /** OutputSession.open invokes this replacement port; count admission reaching native open and return the original fixture backend or failure. */
  f.adapter.openSession = async (params, sink) => { opens++; return nativeOpen(params, sink); };
  const reference = { ...f.session.reference, binding: { ...f.session.binding, nativeRef: { provider: 'fixture', value: 'native-session' } } };
  const foreign = { ...reference, binding: { ...reference.binding, runtimeConfigId: 'foreign' } };
  try {
    const abort = new AbortController(); abort.abort();
    const malformedForeignFork = { ...foreign, mode: 'fork' as const, requestId: 'malformed-foreign-fork' };
    // Each request violates several rules: caller-wait checks must win before shape/binding/capability admission.
    await expect(f.client.openSession(malformedForeignFork, { signal: abort.signal, timeoutMs: 0 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(f.client.openSession(malformedForeignFork, { signal: abort.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    await expect(f.client.openSession(malformedForeignFork)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(f.client.openSession({
      ...foreign, mode: 'fork', requestId: 'foreign-unsupported-fork',
      fork: { sourceSessionId: reference.binding.sessionId, nativeRef: reference.binding.nativeRef, boundary: { turnId: 'turn', relation: 'through' } },
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' });
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

/** Abort an open observer while native attachment is gated. Its late backend must be released exactly once without reopening observation; finally release the gate and dispose the client. */
test('aborting an open observer still releases a late native backend without reopening', async () => {
  const f = await fixture(async () => closeResult);
  const entered = deferred<void>(), release = deferred<void>(), disposed = deferred<void>();
  const nativeOpen = f.adapter.openSession;
  let opens = 0, releases = 0;
  /** OutputSession.open invokes this replacement port; gate native attachment beyond caller cancellation, then return a backend whose late release is observable. */
  f.adapter.openSession = async (params, sink) => {
    opens++; entered.resolve(); await release.promise;
    const backend = await nativeOpen(params, sink);
    return { ...backend,
      /** OutputSession.open releases this late backend after teardown; resolve disposed only after native cleanup so the test can await it independently of open rejection. */
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

/** Delay an owned session release and call client disposal twice. Admission must close immediately, both callers must share teardown, and adapter release must follow sessions; finally release the gate and client. */
test('client disposal closes admission and waits for sessions before releasing the adapter', async () => {
  const f = await fixture(async () => closeResult);
  const disposingSession = deferred<void>(), release = deferred<void>();
  const order: string[] = [];
  const nativeOpen = f.adapter.openSession;
  /** OutputSession.open invokes this replacement port for the extra session; return a delayed-release backend so client disposal ordering can be observed. */
  f.adapter.openSession = async (params, sink) => {
    const backend = await nativeOpen(params, sink);
    return { ...backend,
      /** OutputSession.dispose invokes this backend release; publish entry, await the test's gate, then record successful native cleanup before adapter release. */
      async dispose() {
        disposingSession.resolve(); await release.promise; await backend.dispose(); order.push('session');
      },
    };
  };
  /** withStructuredOutput invokes this adapter release after its sessions; record the order Client.dispose must expose after awaiting owned session cleanup. */
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

/** Settle a native interaction manually while its automatic host handler is gated. Aborted host work must retain capacity until it settles, suppress its late answer, then admit another handler; finally release the gate and client. */
test('aborted automatic handlers retain capacity until host work settles and suppress late answers', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let signal: AbortSignal | undefined;
  let handlers = 0;
  const response = { kind: 'userInput', answers: { q: 'answer' } } as const;
  const responses: Array<unknown> = [];
  const f = await fixture(async () => closeResult, {
    runtime: { maxPendingInteractions: 1 },
    interactions: {
      /** Session.startInteractionHandler invokes this host callback after publication; gate its first answer so settlement aborts its signal before the owned work finishes. */
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
  /** requestInteraction supplies this responder to the registry; record native answers/cancellations so an aborted handler cannot deliver a second reply. */
  const responder = async (value: unknown, reason?: string) => { responses.push({ value, reason }); };
  /** This test allocates distinct interaction identities for each capacity probe while retaining the same answer contract; no registration occurs here. */
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
