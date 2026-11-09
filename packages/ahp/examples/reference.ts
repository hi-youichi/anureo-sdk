/** A standalone AHP v1 peer backed by a scripted native execution. No model calls. */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createClient, HarnessSdkError, type Client, type HarnessAdapter, type BackendSession, type SessionEventSink, type SessionMethod, type Session } from '@anureo/sdk';
import { AHP_PROTOCOL_CONTRACT, assertRequest, isAhpMethod, negotiateVersion, supportsExtension, type Capabilities, type AhpRequestMap, type AhpResultMap, type AhpEvent, type SessionOpenParams } from '@anureo/protocol';

const capabilities: Capabilities = {
  input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
  turn: { inputModalities: ['text'] }, interactions: ['approval'],
  extensions: [{ name: 'x-anureo/event-replay', version: '1' }, { name: 'x-anureo/session-metadata', version: '1' }],
};
class ReferenceAdapter implements HarnessAdapter {
  metadataEnabled = false;
  async initialize(params: AhpRequestMap['initialize']) {
    assertRequest('initialize', params); negotiateVersion(params.protocolVersions);
    this.metadataEnabled ||= supportsExtension(params.clientCapabilities ?? {}, 'x-anureo/session-metadata', '1');
    return { protocolVersion: 1 as const, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'reference', version: '1', adapter: 'reference/1' }, capabilities };
  }
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    let active: string | undefined, closed = false;
    const binding = { ...params.binding, nativeRef: { provider: 'reference', value: params.binding.sessionId } };
    const metadataEnabled = this.metadataEnabled;
    return {
      binding, capabilities,
      async execute<M extends SessionMethod>(method: M, value: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
        if (method === 'session/close') return { closed: true, observationClosed: true, executionStopped: 'unconfirmed' } as AhpResultMap[M];
        if (method === 'turn/interrupt') {
          const { turnId } = value as AhpRequestMap['turn/interrupt'];
          if (active !== turnId) throw new HarnessSdkError('TURN_MISMATCH');
          active = undefined; await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'interrupted' } });
          return { accepted: true, turnId } as AhpResultMap[M];
        }
        if (method !== 'input/submit') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
        if (active) throw new HarnessSdkError('SESSION_BUSY', 'The scripted backend admits one execution at a time');
        const input = value as AhpRequestMap['input/submit'];
        const turnId = randomUUID(); active = turnId;
        await sink.emit({ type: 'turn/started', payload: { turnId } });
        await sink.bindSubmission(input.submissionId, turnId);
        const text = input.input.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (metadataEnabled && text.startsWith('/title ')) await sink.emit({ type: 'session/metadata', payload: { title: text.slice(7) || null } });
        if (text !== '/wait') void (async () => {
          if (text === '/approval') await sink.requestInteraction({ kind: 'approval', interactionId: `approval:${turnId}`, turnId, options: [{ id: 'allow', label: 'Allow once', semantic: 'allowOnce' }, { id: 'deny', label: 'Deny', semantic: 'deny' }] }, async () => {});
          if (closed || active !== turnId) return;
          await sink.emit({ type: 'item/started', payload: { item: { id: 'message', type: 'agentMessage', text: '' } } }, { turnId });
          await sink.emit({ type: 'item/completed', payload: { item: { id: 'message', type: 'agentMessage', text, phase: 'final' } } }, { turnId });
          active = undefined; await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } });
        })().catch(async () => {
          if (!closed && active === turnId) { active = undefined; await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: { code: 'SCRIPTED_EXECUTION_FAILED', message: 'Scripted execution failed', retryable: false, outcomeUnknown: false } } }); }
        });
        return { submissionId: input.submissionId, disposition: 'dispatched' } as AhpResultMap[M];
      },
      async dispose() { closed = true; },
    };
  }
  async dispose() {}
}

export function createReferenceHarness(send: (message: string) => void | Promise<void>) {
  const adapter = new ReferenceAdapter(), clients = new Set<Client>();
  const sessions = new Map<string, { session: Session; streamId: string; seq: number }>(), logs = new Map<string, AhpEvent[]>();
  let initialized = false;
  const publish = async (event: AhpEvent) => {
    const source = sessions.get(event.sessionId); if (!source) return;
    event = { ...event, streamId: source.streamId, seq: ++source.seq };
    if (event.type === 'session/metadata') event = { ...event, type: 'extension', payload: { name: 'x-anureo/session-metadata', version: '1', data: event.payload } };
    const log = logs.get(event.sessionId) ?? []; log.push(event); if (log.length > 2048) log.shift(); logs.set(event.sessionId, log);
    await send(JSON.stringify({ jsonrpc: '2.0', method: event.type, params: event }));
  };
  const invoke = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'initialize') { assertRequest(method, params); const result = await adapter.initialize(params); initialized = true; return result; }
    if (!initialized) throw new HarnessSdkError('NOT_INITIALIZED');
    if (method === 'session/open') {
      assertRequest(method, params); if (sessions.has(params.binding.sessionId)) throw new HarnessSdkError('SESSION_ALREADY_OPEN');
      const client = await createClient({ adapter, identity: params.binding, interactions: { approval: undefined } }); clients.add(client);
      const session = await client.openSession(params), streamId = randomUUID(), state = session.snapshot;
      sessions.set(session.id, { session, streamId, seq: 0 });
      const reader = session.events()[Symbol.asyncIterator]();
      await publish({ sessionId: session.id, streamId, seq: 1, timestamp: new Date().toISOString(), type: 'session/state', payload: state });
      void (async () => { for (;;) { const next = await reader.next(); if (next.done) return; await publish(next.value); } })().catch(() => {});
      return { binding: session.binding, streamId, state, capabilities: session.capabilities };
    }
    if (!params || typeof params !== 'object' || !('sessionId' in params) || typeof params.sessionId !== 'string') throw new HarnessSdkError('INVALID_PARAMS');
    if (method === 'x-anureo/events/read') {
      const p = params as { sessionId: string; streamId: string; afterSeq: number; throughSeq: number };
      const events = (logs.get(p.sessionId) ?? []).filter(e => e.streamId === p.streamId && e.seq > p.afterSeq && e.seq <= p.throughSeq);
      if (events.length !== p.throughSeq - p.afterSeq) throw new HarnessSdkError('SOURCE_STREAM_UNAVAILABLE');
      return { events };
    }
    const source = sessions.get(params.sessionId); if (!source) throw new HarnessSdkError('SESSION_NOT_FOUND');
    if (!isAhpMethod(method) || method === 'initialize' || method === 'session/open') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    assertRequest(method, params);
    const result = await source.session.request(method, params as AhpRequestMap[SessionMethod]);
    if (method === 'session/close') sessions.delete(params.sessionId);
    return result;
  };
  return {
    async receive(frame: string) {
      let message: Record<string, unknown>;
      try { message = JSON.parse(frame); } catch { await send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
      if (message.method === 'initialized' && message.id === undefined) return;
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id === undefined) { await send(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Invalid request' } })); return; }
      try { await send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: await invoke(message.method, message.params) })); }
      catch (cause) { const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'HARNESS_ERROR'; await send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32070, message: code, data: { code, retryable: false, outcomeUnknown: false } } })); }
    },
    async close() { const outcomes = await Promise.allSettled([...clients].map(client => client.dispose())); const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'); if (failed) throw failed.reason; },
  };
}
if (import.meta.main) {
  const harness = createReferenceHarness(message => { process.stdout.write(message + '\n'); });
  const input = createInterface({ input: process.stdin }); for await (const line of input) void harness.receive(line);
  await harness.close();
}
