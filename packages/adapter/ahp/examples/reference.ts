/** A standalone AHP v1 peer backed by a scripted native execution. No model calls. */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createClient, HarnessSdkError, type Client, type HarnessAdapter, type BackendSession, type SessionEventSink, type SessionMethod, type Session } from '@anureo/sdk';
import { AHP_PROTOCOL_CONTRACT, assertRequest, isAhpMethod, negotiateVersion, supportsExtension, type Capabilities, type AhpRequestMap, type AhpResultMap, type AhpEvent, type SessionOpenParams } from '@anureo/protocol';

/**
 * Create a scripted AHP peer for stdio or an embedding transport. The supplied send callback
 * receives JSON-RPC frames without line delimiters. receive permits concurrent requests and awaits
 * its reply write. Execution events can continue afterward. Stop admitting requests before close
 * and await outstanding opens if their clients also need to be included in disposal.
 */
export function createReferenceHarness(send: (message: string) => void | Promise<void>) {
  const adapter = new ReferenceAdapter();
  // The harness retains and disposes every client when it closes.
  const ownedClients = new Set<Client>();
  const openSessions = new Map<string, OpenSessionRecord>();
  // Replay logs outlive session closure and remain for the harness lifetime.
  const replayLogs = new Map<string, AhpEvent[]>();
  let initialized = false;
  /** openSession and publishSessionEvents await the send. Record the source sequence first so it is available to concurrent replay. */
  const publish = async (event: AhpEvent) => {
    const source = openSessions.get(event.sessionId);
    if (!source) return;
    event = { ...event, streamId: source.streamId, seq: ++source.lastPublishedSeq };
    if (event.type === 'session/metadata') event = { ...event, type: 'extension', payload: { name: 'x-anureo/session-metadata', version: '1', data: event.payload } };
    const log = replayLogs.get(event.sessionId) ?? [];
    log.push(event);
    if (log.length > 2048) log.shift();
    replayLogs.set(event.sessionId, log);
    await send(JSON.stringify({ jsonrpc: '2.0', method: event.type, params: event }));
  };
  /** Drain events in order; a read/send rejection stops forwarding and is suppressed by openSession. */
  const publishSessionEvents = async (reader: AsyncIterator<AhpEvent>) => {
    for (;;) {
      const next = await reader.next();
      if (next.done) return;
      await publish(next.value);
    }
  };
  /** Own the client before opening; publish initial state before starting the ongoing event drain. */
  const openSession = async (params: SessionOpenParams) => {
    if (openSessions.has(params.binding.sessionId)) throw new HarnessSdkError('SESSION_ALREADY_OPEN');
    const client = await createClient({ adapter, identity: params.binding, interactions: { approval: undefined } });
    ownedClients.add(client);
    const session = await client.openSession(params);
    const streamId = randomUUID();
    const state = session.snapshot;
    openSessions.set(session.id, { session, streamId, lastPublishedSeq: 0 });
    const reader = session.events()[Symbol.asyncIterator]();
    await publish({ sessionId: session.id, streamId, seq: 1, timestamp: new Date().toISOString(), type: 'session/state', payload: state });
    void publishSessionEvents(reader).catch(() => {});
    return { binding: session.binding, streamId, state, capabilities: session.capabilities };
  };
  /** invoke returns a complete replay range or reports SOURCE_STREAM_UNAVAILABLE, including when old entries were evicted. */
  const readEvents = ({ sessionId, streamId, afterSeq, throughSeq }: ReplayRange) => {
    const events = (replayLogs.get(sessionId) ?? []).filter(
      event => event.streamId === streamId && event.seq > afterSeq && event.seq <= throughSeq,
    );
    if (events.length !== throughSeq - afterSeq) throw new HarnessSdkError('SOURCE_STREAM_UNAVAILABLE');
    return { events };
  };
  /** Enforce handshake/session admission and return SDK results; receive converts failures to RPC errors. */
  const invoke = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'initialize') {
      assertRequest(method, params);
      const result = await adapter.initialize(params);
      initialized = true;
      return result;
    }
    if (!initialized) throw new HarnessSdkError('NOT_INITIALIZED');
    if (method === 'session/open') {
      assertRequest(method, params);
      return openSession(params);
    }
    if (!params || typeof params !== 'object' || !('sessionId' in params) || typeof params.sessionId !== 'string') throw new HarnessSdkError('INVALID_PARAMS');
    if (method === 'x-anureo/events/read') {
      return readEvents(params as ReplayRange);
    }
    const source = openSessions.get(params.sessionId);
    if (!source) throw new HarnessSdkError('SESSION_NOT_FOUND');
    if (!isAhpMethod(method) || method === 'initialize' || method === 'session/open') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    assertRequest(method, params);
    const result = await source.session.request(method, params as AhpRequestMap[SessionMethod]);
    if (method === 'session/close') openSessions.delete(params.sessionId);
    return result;
  };
  return {
    /** Accept one frame and await its reply write. Independent callers can receive concurrently. */
    receive: createReceiver(send, invoke),
    /** Attempt all owned client disposals before rejecting the first release failure. */
    async close() {
      const outcomes = await Promise.allSettled([...ownedClients].map(client => client.dispose()));
      const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}
/**
 * Decode one JSON-RPC frame per call and invoke the harness dispatcher. Ignore initialized and
 * send parse/envelope errors directly. Dispatch or result-write failures attempt an RPC error reply.
 * An unusable envelope or failed error write can reject the returned receive promise.
 */
function createReceiver(
  send: (message: string) => void | Promise<void>,
  invoke: (method: string, params: unknown) => Promise<unknown>,
): (frame: string) => Promise<void> {
  return async function receive(frame) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(frame);
    } catch {
      await sendRpcError(send, null, { code: -32700, message: 'Parse error' });
      return;
    }
    if (message.method === 'initialized' && message.id === undefined) return;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id === undefined) {
      await sendRpcError(send, message.id ?? null, { code: -32600, message: 'Invalid request' });
      return;
    }
    try {
      const id = message.id;
      const result = await invoke(message.method, message.params);
      await send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause
        ? String(cause.code)
        : 'HARNESS_ERROR';
      await sendRpcError(send, message.id, {
        code: -32070,
        message: code,
        data: { code, retryable: false, outcomeUnknown: false },
      });
    }
  };
}

/** Write the correlated error frame for receive and let serialization or transport failure escape. */
function sendRpcError(send: (message: string) => void | Promise<void>, id: unknown, error: RpcError) {
  return send(JSON.stringify({ jsonrpc: '2.0', id, error }));
}

interface RpcError {
  code: number;
  message: string;
  data?: { code: string; retryable: boolean; outcomeUnknown: boolean };
}

interface ReplayRange {
  sessionId: string;
  streamId: string;
  /** Exclusive lower sequence boundary. */
  afterSeq: number;
  /** Inclusive upper sequence boundary. */
  throughSeq: number;
}

const capabilities: Capabilities = {
  input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
  turn: { inputModalities: ['text'] }, interactions: ['approval'],
  extensions: [{ name: 'x-anureo/event-replay', version: '1' }, { name: 'x-anureo/session-metadata', version: '1' }],
};
/** Scripted native backend used by the reference peer; each open owns its active execution slot. */
class ReferenceAdapter implements HarnessAdapter {
  /**
   * The harness dispatcher and SDK wrapper both negotiate this scripted backend. Reject invalid
   * parameters or versions and retain title support for later opens once a caller advertises it.
   */
  async initialize(params: AhpRequestMap['initialize']) {
    assertRequest('initialize', params);
    negotiateVersion(params.protocolVersions);
    this.metadataEnabled ||= supportsExtension(params.clientCapabilities ?? {}, 'x-anureo/session-metadata', '1');
    return { protocolVersion: 1 as const, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'reference', version: '1', adapter: 'reference/1' }, capabilities };
  }
  /** OutputSession.open adopts this backend, which owns one scripted execution and publishes through the supplied sink. */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    let active: string | undefined;
    let closed = false;
    const binding = { ...params.binding, nativeRef: { provider: 'reference', value: params.binding.sessionId } };
    const metadataEnabled = this.metadataEnabled;
    /** Submit starts this in the background. Recheck active ownership after approval so interrupted work skips output. */
    const runExecution = async (turnId: string, text: string) => {
      if (text === '/approval') await sink.requestInteraction({ kind: 'approval', interactionId: `approval:${turnId}`, turnId, options: [{ id: 'allow', label: 'Allow once', semantic: 'allowOnce' }, { id: 'deny', label: 'Deny', semantic: 'deny' }] }, async () => {});
      if (closed || active !== turnId) return;
      await sink.emit({ type: 'item/started', payload: { item: { id: 'message', type: 'agentMessage', text: '' } } }, { turnId });
      await sink.emit({ type: 'item/completed', payload: { item: { id: 'message', type: 'agentMessage', text, phase: 'final' } } }, { turnId });
      active = undefined;
      await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } });
    };
    /** Convert background failure into a terminal only while this execution still owns the slot. */
    const handleExecutionFailure = async (turnId: string) => {
      if (!closed && active === turnId) {
        active = undefined;
        await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: { code: 'SCRIPTED_EXECUTION_FAILED', message: 'Scripted execution failed', retryable: false, outcomeUnknown: false } } });
      }
    };
    return {
      binding, capabilities,
      /**
       * OutputSession dispatches one scripted operation here. Submit returns a dispatch receipt,
       * interrupt waits for the active turn's terminal, and close confirms observation.
       * Busy, mismatched and unsupported requests reject.
       */
      async execute<M extends SessionMethod>(method: M, value: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
        if (method === 'session/close') {
          return { closed: true, observationClosed: true, executionStopped: 'unconfirmed' } as AhpResultMap[M];
        }
        if (method === 'turn/interrupt') {
          const { turnId } = value as AhpRequestMap['turn/interrupt'];
          if (active !== turnId) throw new HarnessSdkError('TURN_MISMATCH');
          active = undefined;
          await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'interrupted' } });
          return { accepted: true, turnId } as AhpResultMap[M];
        }
        if (method !== 'input/submit') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
        if (active) throw new HarnessSdkError('SESSION_BUSY', 'The scripted backend admits one execution at a time');
        const input = value as AhpRequestMap['input/submit'];
        const turnId = randomUUID();
        active = turnId;
        await sink.emit({ type: 'turn/started', payload: { turnId } });
        await sink.bindSubmission(input.submissionId, turnId);
        const text = input.input.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (metadataEnabled && text.startsWith('/title ')) {
          await sink.emit({ type: 'session/metadata', payload: { title: text.slice(7) || null } });
        }
        if (text !== '/wait') void runExecution(turnId, text).catch(() => handleExecutionFailure(turnId));
        return { submissionId: input.submissionId, disposition: 'dispatched' } as AhpResultMap[M];
      },
      /** Mark closed so executions waiting for approval skip output; the SDK owns observation teardown. */
      async dispose() { closed = true; },
    };
  }
  /** Session handles own all scripted state, so client disposal has no shared native resource to release. */
  async dispose() {}

  /** Enable metadata cumulatively during negotiation. Each open snapshots the current flag. */
  metadataEnabled = false;
}

type OpenSessionRecord = {
  session: Session;
  streamId: string;
  lastPublishedSeq: number;
};

if (import.meta.main) {
  const harness = createReferenceHarness(message => { process.stdout.write(message + '\n'); });
  const input = createInterface({ input: process.stdin });
  for await (const line of input) void harness.receive(line);
  await harness.close();
}
