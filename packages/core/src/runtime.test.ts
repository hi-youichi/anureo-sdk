import { expect, test } from 'bun:test';
import { createClient, HarnessSdkError, type ClientOptions, type HarnessAdapter, type SessionEventSink, type SessionMethod } from './index';
import { AHP_PROTOCOL_CONTRACT, type AhpEvent, type AhpRequestMap, type AhpResultMap, type Capabilities } from '@anureo/protocol';
import { deferred } from './lifecycle/value';

const closeResult = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' } as const;
const capabilities: Capabilities = {
  input: { delivery: ['native', 'afterTurn'], steer: { target: 'turn', atomicMatch: true }, interrupt: { targets: ['turn','session'], reportsPendingInputs: true } },
  turn: { inputModalities: ['text'], overrides: ['model'] },
  session: { history: true, resume: true, fork: ['before'], revert: ['conversation'] },
  config: { options: [{ id: 'model', scope: 'session', schema: { type: 'string' } }] },
  review: true, compact: true, goal: { actions: ['set','clear'] }, interactions: ['userInput'],
};
type Run = (method: SessionMethod, params: AhpRequestMap[SessionMethod], sink: SessionEventSink) => Promise<unknown>;
async function fixture(run: Run, options: Partial<ClientOptions> = {}) {
  let sink!: SessionEventSink, disposals = 0;
  const calls: Array<{ method: SessionMethod; params: AhpRequestMap[SessionMethod] }> = [];
  const adapter: HarnessAdapter = {
    async initialize(p) { expect(p.protocolContract).toBe(AHP_PROTOCOL_CONTRACT); return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'fixture', version: '1', adapter: 'fixture' }, capabilities }; },
    async openSession(p, events) {
      sink = events;
      return { binding: p.binding, capabilities,
        async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> { calls.push({ method, params }); return await run(method, params, sink) as AhpResultMap[M]; },
        async dispose() { disposals++; },
      };
    }, async dispose() {},
  };
  const client = await createClient({ adapter, identity: { adapterId: 'fixture', runtimeConfigId: 'local' }, ...options });
  return { client, session: await client.sessions.create({ cwd: process.cwd() }), calls, get sink() { return sink; }, get disposals() { return disposals; } };
}
async function started(sink: SessionEventSink, turnId: string) { await sink.emit({ type: 'turn/started', payload: { turnId } }); }
async function completed(sink: SessionEventSink, turnId: string, text = 'answer') {
  await sink.emit({ type: 'item/completed', payload: { item: { id: 'reused', type: 'agentMessage', text, phase: 'final' } } }, { turnId });
  await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } });
}
const input = (p: AhpRequestMap[SessionMethod]) => p as AhpRequestMap['input/submit'];

test('submit returns a Turn from binding before a delayed receipt; no public Submission stage', async () => {
  const ack = deferred<void>();
  const f = await fixture(async (_m, p, sink) => {
    await started(sink, 'actual'); await sink.bindSubmission(input(p).submissionId, 'actual');
    await ack.promise; return { submissionId: input(p).submissionId, disposition: 'dispatched' };
  });
  try {
    const turn = await f.session.submit({ input: 'x' }, { timeoutMs: 100 });
    expect(turn.id).toBe('actual'); expect('accepted' in turn).toBe(false);
    await completed(f.sink, turn.id); expect((await turn.result()).text).toBe('answer');
  } finally { ack.resolve(); await f.client.dispose(); }
});

test('a backend without acceptance receipts binds a previously completed native result', async () => {
  const f = await fixture(async (_m, p, sink) => {
    await started(sink, 'actual'); await completed(sink, 'actual', 'early');
    await sink.bindSubmission(input(p).submissionId, 'actual');
    return { submissionId: input(p).submissionId, disposition: 'dispatched' };
  });
  try { expect(await (await f.session.submit({ input: 'x' })).result()).toMatchObject({ text: 'early', status: 'completed' }); }
  finally { await f.client.dispose(); }
});

test('two submissions share one actual result and independent observers', async () => {
  const f = await fixture(async (_m, p, sink) => {
    await started(sink, 'shared'); await sink.bindSubmission(input(p).submissionId, 'shared');
    return { submissionId: input(p).submissionId, accepted: true, disposition: 'joined', turnId: 'shared' };
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

test('cancelled submit waiting retains dispatch and later association without resending', async () => {
  const sent = deferred<void>(), release = deferred<void>(); let submitted = '';
  const f = await fixture(async (_m, p) => { submitted = input(p).submissionId; sent.resolve(); await release.promise; return { submissionId: submitted, disposition: 'dispatched' }; });
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

test('completed snapshots rotate while newly pending submissions do not pin older executions', async () => {
  let n = 0;
  const f = await fixture(async (_m, p, sink) => {
    const id = `turn-${++n}`; await started(sink, id); await sink.bindSubmission(input(p).submissionId, id); await completed(sink, id);
    return { submissionId: input(p).submissionId, accepted: true, disposition: 'started', turnId: id };
  }, { limits: { maxExecutions: 1, maxSubmissions: 2 } });
  try {
    for (let i = 0; i < 6; i++) expect((await (await f.session.submit({ input: 'x' })).result()).status).toBe('completed');
    expect(f.session.snapshot.status).toBe('ready');
  } finally { await f.client.dispose(); }
});

test('older unbound input pins its possible late result instead of silently evicting it', async () => {
  let n = 0;
  const f = await fixture(async (_m, p, sink) => {
    if (++n === 1) { await started(sink, 'first'); await completed(sink, 'first'); }
    else await started(sink, 'second');
    return { submissionId: input(p).submissionId, disposition: 'dispatched' };
  }, { limits: { maxExecutions: 1 } });
  try {
    await expect(f.session.submit({ input: 'first' }, { timeoutMs: 5 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await expect(f.session.submit({ input: 'second' })).rejects.toMatchObject({ code: 'BACKPRESSURE_EXCEEDED' });
    expect(f.session.snapshot.status).toBe('closed');
  } finally { await f.client.dispose(); }
});

test('definite input rejection leaves another execution usable', async () => {
  let n = 0;
  const f = await fixture(async (_m, p, sink) => {
    if (++n === 2) throw new HarnessSdkError('NATIVE_BUSY');
    await started(sink, 'kept'); return { submissionId: input(p).submissionId, accepted: true, disposition: 'started', turnId: 'kept' };
  });
  try {
    const a = await f.session.submit({ input: 'a' }); await expect(f.session.submit({ input: 'b' })).rejects.toMatchObject({ code: 'NATIVE_BUSY' });
    await completed(f.sink, a.id); expect((await a.result()).status).toBe('completed');
  } finally { await f.client.dispose(); }
});

test('interleaved executions and reused item IDs remain isolated', async () => {
  let n = 0;
  const f = await fixture(async (_m,p,sink) => { const turnId = `actual-${++n}`; await started(sink, turnId); return { submissionId: input(p).submissionId, accepted: true, disposition: 'started', turnId }; });
  try {
    const a = await f.session.submit({ input: 'a' }), b = await f.session.submit({ input: 'b' });
    expect(f.session.snapshot.activeTurnIds).toEqual([a.id,b.id]);
    await completed(f.sink,b.id,'b'); await completed(f.sink,a.id,'a');
    expect((await a.result()).text).toBe('a'); expect((await b.result()).text).toBe('b');
  } finally { await f.client.dispose(); }
});

test('exact steer uses the actual target and keeps one execution', async () => {
  const f = await fixture(async (m,p,sink) => {
    if (m === 'turn/steer') { const v = p as AhpRequestMap['turn/steer']; return { accepted: true, submissionId: v.submissionId, turnId: v.expectedTurnId }; }
    await started(sink,'actual'); return { submissionId: input(p).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
  });
  try {
    const turn = await f.session.submit({ input: 'a' }); await turn.steer({ input: 'change scope' });
    expect(f.calls[1]!.params).toMatchObject({ expectedTurnId: turn.id }); expect(f.session.snapshot.activeTurnIds).toEqual([turn.id]);
    await completed(f.sink,turn.id); expect((await turn.result()).status).toBe('completed');
  } finally { await f.client.dispose(); }
});

test('mismatched native steer identity fails closed rather than reporting success', async () => {
  const f = await fixture(async (m,p,sink) => {
    if(m==='turn/steer')return { accepted: true, submissionId: input(p).submissionId, turnId: 'wrong' };
    await started(sink,'actual');return { submissionId: input(p).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
  });
  try { const turn=await f.session.submit({input:'a'}); await expect(turn.steer({input:'b'})).rejects.toMatchObject({code:'PROTOCOL_ERROR'}); }
  finally {await f.client.dispose();}
});

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

test('active close is shared, preserves retained terminals and leaves unfinished results unknown', async()=>{
  const close=deferred<void>();let n=0;
  const f=await fixture(async(m,p,sink)=>{
    if(m==='session/close'){await close.promise;return closeResult;}
    if(m==='turn/interrupt')return {accepted:true,turnId:(p as AhpRequestMap['turn/interrupt']).turnId};
    const turnId=`turn-${++n}`;await started(sink,turnId);return {submissionId:input(p).submissionId,accepted:true,disposition:'started',turnId};
  });
  try{
    const finished=await f.session.submit({input:'first'});await completed(f.sink,finished.id);
    const active=await f.session.submit({input:'second'});const a=f.session.close(),b=f.session.close();
    await expect(f.session.submit({input:'late'})).rejects.toMatchObject({code:'SESSION_CLOSING'});
    await active.interrupt();close.resolve();expect(await a).toEqual(closeResult);await b;
    await expect(active.result()).rejects.toMatchObject({code:'OBSERVATION_CLOSED',outcomeUnknown:true,details:{source:'sdk'}});
    expect((await finished.result()).status).toBe('completed');expect(f.calls.filter(c=>c.method==='session/close')).toHaveLength(1);expect(f.disposals).toBe(1);
  }finally{close.resolve();await f.client.dispose();}
});

test('definite close rejection restores an active session',async()=>{
  const f=await fixture(async(m,p,sink)=>{if(m==='session/close')throw new HarnessSdkError('CLOSE_DENIED');await started(sink,'active');return {submissionId:input(p).submissionId,accepted:true,disposition:'started',turnId:'active'};});
  try{const turn=await f.session.submit({input:'x'});await expect(f.session.close()).rejects.toMatchObject({code:'CLOSE_DENIED'});expect(f.session.snapshot.status).toBe('running');await completed(f.sink,turn.id);expect((await turn.result()).status).toBe('completed');}
  finally{await f.client.dispose();}
});

test('invalid wait and binding/capability requests never dispatch',async()=>{
  const f=await fixture(async()=>closeResult);
  try{
    await expect(f.session.submit({input:'x'},{timeoutMs:0})).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await expect(f.session.close({timeoutMs:Infinity})).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await expect(f.session.request('compact/start',{sessionId:'wrong',requestId:'x'})).rejects.toMatchObject({code:'SESSION_BINDING_MISMATCH'});
    expect(f.calls).toHaveLength(0);
  }finally{await f.client.dispose();}
});

test('raw requests dedupe and reject conflicting submission identity',async()=>{
  const f=await fixture(async(_m,p,sink)=>{await started(sink,'actual');return {submissionId:input(p).submissionId,accepted:true,disposition:'started',turnId:'actual'};});
  try{
    const p:AhpRequestMap['input/submit']={sessionId:f.session.id,requestId:'request',submissionId:'input',delivery:'native',input:[{type:'text',text:'a'}]};
    const [a,b]=await Promise.all([f.session.request('input/submit',p),f.session.request('input/submit',p)]);expect(a).toEqual(b);expect(f.calls).toHaveLength(1);
    await expect(f.session.request('input/submit',{...p,input:[{type:'text',text:'b'}]})).rejects.toMatchObject({code:'REQUEST_ID_CONFLICT'});
    await expect(f.session.request('input/submit',{...p,requestId:'other'})).rejects.toMatchObject({code:'SUBMISSION_ID_CONFLICT'});
  }finally{await f.client.dispose();}
});

test('item-shaped patch snapshots update retained results without changing item identity', async () => {
  const f = await fixture(async (_method, params, sink) => {
    await started(sink, 'actual'); await sink.bindSubmission(input(params).submissionId, 'actual');
    return { submissionId: input(params).submissionId, disposition: 'dispatched' };
  });
  try {
    const turn = await f.session.submit({ input: 'work' });
    await f.sink.emit({ type: 'item/started', payload: { item: { id: 'tool', type: 'toolCall', kind: 'command', title: 'Work', input: { command: 'old' } } } }, { turnId: turn.id });
    await f.sink.emit({ type: 'item/delta', payload: { itemId: 'tool', kind: 'patch', value: { id: 'tool', type: 'toolCall', kind: 'command', title: 'Work', input: { command: 'new' } } } }, { turnId: turn.id });
    await f.sink.emit({ type: 'turn/completed', payload: { turnId: turn.id, status: 'interrupted' } });
    expect((await turn.result()).items).toMatchObject([{ id: 'tool', input: { command: 'new' } }]);
  } finally { await f.client.dispose(); }
});

test('a patch cannot move an item into another identity or content family', async () => {
  const patches: import('@anureo/protocol').JsonObject[] = [ { id: 'other', type: 'agentMessage', text: 'bad' }, { id: 'item', type: 'notice', severity: 'info', text: 'bad' } ];
  for (const value of patches) {
    const f = await fixture(async (_method, params, sink) => {
      await started(sink, 'actual'); return { submissionId: input(params).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
    });
    try {
      const turn = await f.session.submit({ input: 'work' });
      await f.sink.emit({ type: 'item/started', payload: { item: { id: 'item', type: 'agentMessage', text: '' } } }, { turnId: turn.id });
      await expect(f.sink.emit({ type: 'item/delta', payload: { itemId: 'item', kind: 'patch', value } }, { turnId: turn.id })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      await expect(turn.result()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', details: { source: 'sdk' } });
    } finally { await f.client.dispose(); }
  }
});

test('one overflowing observer does not interrupt a sibling or discard the retained native result', async () => {
  const f = await fixture(async (_method, params, sink) => {
    await started(sink, 'actual'); return { submissionId: input(params).submissionId, accepted: true, disposition: 'started', turnId: 'actual' };
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

test('submission rejection diagnostics redact marked answers and authentication fields', async () => {
  const sent = deferred<void>(); let submissionId = '';
  const f = await fixture(async (_method, params) => {
    submissionId = input(params).submissionId; sent.resolve(); return { submissionId, disposition: 'dispatched' };
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

test('malformed JavaScript input fails with typed validation before native dispatch', async () => {
  const f = await fixture(async () => closeResult);
  try {
    for (const value of [undefined, null, 42, { text: 'missing discriminant' }, [() => 'uncloneable']]) {
      await expect(f.session.submit({ input: value as unknown as import('./index').Input })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(f.calls).toHaveLength(0);
  } finally { await f.client.dispose(); }
});
