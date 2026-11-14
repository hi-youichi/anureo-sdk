import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { createClient, HarnessSdkError, type Session } from '@anureo/sdk';
import type { AhpEvent, InitializeParams, InteractionRequested, InteractionResponse } from '@anureo/protocol';
import { createAcpAdapter, type AcpAdapterOptions } from '../src/index';
import { stopOutcome } from '../src/stop';
import { rejectionOf } from './test-helpers';

const executable = resolve(import.meta.dirname, './fixtures/fake-acp.mjs');
/** Open a scripted peer and observe its events/interactions; callers must close the fixture, including after resume. */
async function fixture(args: string[] = [], options: Partial<AcpAdapterOptions> = {}) {
  const adapter = createAcpAdapter({ command: process.execPath, args: [executable, ...args], ...options });
  const runtime = await createClient({adapter,identity:{adapterId:'acp',runtimeConfigId:'fixture'},interactions:{approval:undefined,userInput:undefined,elicitation:undefined,dynamicTool:undefined}});
  const initialized = {capabilities:adapter.capabilities};
  let session: Session = await runtime.openSession({ requestId: 'open', mode: 'new', binding: { sessionId: 's', adapterId: 'acp', runtimeConfigId: 'fixture' }, cwd: process.cwd() });
  const events: AhpEvent[] = [];
  let response: ((request: InteractionRequested) => InteractionResponse) | undefined;
  let eventPumpError: unknown;
  /** Collect one attachment and answer configured interactions; until observes stream/response failures. */
  async function consume(observedSession: Session) {
    try {
      for await (const event of observedSession.events()) {
        events.push(event);
        if (event.type === 'interaction/requested' && response) {
          await observedSession.request('interaction/respond', {
            requestId: `answer-${event.payload.interactionId}`,
            sessionId: 's',
            interactionId: event.payload.interactionId,
            response: response(event.payload),
          });
        }
      }
    } catch (error) {
      eventPumpError = error;
    }
  }
  const pumps = [consume(session)];
  let counter = 0;
  /** Await an observed condition, failing early if the event pump cannot make progress. */
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      // Event pump errors propagate through this polling loop.
      if (eventPumpError) throw eventPumpError;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw Error('Timed out awaiting ACP fixture');
  };
  return {
    adapter, runtime, initialized, events, get session() { return session; }, until,
    respondWith(handler: (request: InteractionRequested) => InteractionResponse) { response = handler; },
    async start(text: string) { return (await session.submit({input:text})).id; },
    /** Await terminal publication, then include interaction resolutions associated by interaction ID. */
    async finished(turnId: string) {
      await until(() => events.some((event) => event.type === 'turn/completed' && event.payload.turnId === turnId));

      return eventsForTurn(events, turnId);
    },
    async resume() { const binding = session.binding; await session.close(); session = await runtime.openSession({ requestId: 'resume', mode: 'resume', binding, cwd: process.cwd() }); pumps.push(consume(session)); },
    async close() { await runtime.dispose(); await Promise.all(pumps); },
  };
}

/** Retain turn events and their interaction resolutions in observation order. Resolutions carry the
 * interaction ID even when the turn ID is absent. */
function eventsForTurn(events: AhpEvent[], turnId: string): AhpEvent[] {
  const turnInteractionIds = new Set<string>();
  for (const event of events) {
    if (event.turnId === turnId && event.type === 'interaction/requested') {
      turnInteractionIds.add(event.payload.interactionId);
    }
  }

  return events.filter((event) => event.turnId === turnId || (
    event.type === 'interaction/resolved' && turnInteractionIds.has(event.payload.interactionId)
  ));
}

test('vanilla native stdio maps structured updates, complete authority, reused ids and unknown messages', async () => {
  const f = await fixture(); try {
    expect(f.initialized.capabilities.input?.steer).toBeUndefined(); expect(f.initialized.capabilities.session?.fork).toEqual([]);
    const first = await f.start('first'); const events = await f.finished(first);
    const messages = events.filter((event) => event.type === 'item/completed');
    expect(messages.some((event) => event.type === 'item/completed' && event.payload.item.type === 'agentMessage' && event.payload.item.text === 'Hello first')).toBe(true);
    expect(messages.some((event) => event.type === 'item/completed' && event.payload.item.type === 'toolCall' && event.payload.item.kind === 'command')).toBe(true);
    expect(messages.some((event) => event.type === 'item/completed' && event.payload.item.type === 'compaction' && event.payload.item.summary === 'full summary')).toBe(true);
    expect(events.some((event) => event.type === 'usage/updated' && event.payload.contextUsed === 5)).toBe(true);
    expect(events.some((event) => event.type === 'notice' && event.payload.code === 'ACP_UNKNOWN_UPDATE')).toBe(true);
    expect(messages.some((event) => event.type === 'item/completed' && event.payload.item.type === 'subagent')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('redact-me');
    const second = await f.start('second'); const again = await f.finished(second);
    expect(again.some((event) => event.type === 'item/completed' && event.payload.item.type === 'agentMessage' && event.payload.item.text === 'Hello second')).toBe(true);
    expect(await rejectionOf(f.session.request('turn/steer', { requestId: 'unsupported', sessionId: 's', submissionId:'unsupported-input',expectedTurnId: second, input: [{ type: 'text', text: 'no' }] }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  } finally { await f.close(); }
});

test('permission and form/URL elicitation round-trip original native requests with one resolution', async () => {
  const f = await fixture(); try {
    f.respondWith((request) => request.kind === 'approval' ? { kind: 'approval', optionId: 'allow' } : { kind: 'elicitation', action: 'accept', content: { name: 'Ada' } });
    for (const command of ['permission', 'elicitation', 'elicitation-url']) {
      const id = await f.start(command); const events = await f.finished(id);
      expect(events.filter((event) => event.type === 'interaction/requested')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'interaction/resolved')).toHaveLength(1);
      expect(events.find((event) => event.type === 'interaction/resolved')?.payload).toMatchObject({ outcome: 'responded' });
    }
  } finally { await f.close(); }
});

test('cancel is a native notification and waits for prompt cancelled before terminal', async () => {
  const f = await fixture(); try {
    const pending=f.session.submit({input:'wait'});void pending.catch(()=>{});await Promise.resolve();await f.session.interrupt();
    const turn=await pending;const events=await f.finished(turn.id);
    expect(events.filter((event) => event.type === 'turn/completed')).toHaveLength(1);
    expect(events.find((event) => event.type === 'turn/completed')?.payload).toMatchObject({ status: 'interrupted' });
  } finally { await f.close(); }
});

test('a definite ACP prompt failure releases the lane before its result settles', async () => {
  const f = await fixture();
  try {
    const failed = await f.session.submit({ input: 'fail-started' });
    expect(await failed.result()).toMatchObject({ status: 'failed' });
    const next = await f.session.submit({ input: 'next' });
    expect(await next.result()).toMatchObject({ status: 'completed', text: 'Hello next' });
  } finally { await f.close(); }
});

test('an inherited property is an unclassified ACP stop reason', () => {
  expect(stopOutcome('toString')).toMatchObject({ status: 'failed', notice: { code: 'ACP_STOP_UNKNOWN' } });
});

test('mode/config native operations update declared schemas and load snapshots do not replay live events', async () => {
  const snapshots: unknown[] = [];
  const f = await fixture(['--load-only'], { onLoadSnapshot: (_binding, updates) => snapshots.push(updates) }); try {
    expect(f.session.capabilities.config?.options.map((option) => option.id)).toEqual(['model-id', 'model', 'enabled', 'mode']);
    const state = await f.session.request('session/config/set', { requestId: 'config', sessionId: 's', patch: { model: 'second-model', mode: 'plan', enabled: true } });
    expect(state.config.model).toBe('second-model'); expect(state.config.mode).toBe('plan'); expect(state.config.enabled).toBe(true);
    await f.resume();
    expect(snapshots).toHaveLength(1); expect(JSON.stringify(snapshots)).toContain('loaded snapshot');
    expect(JSON.stringify(f.events)).not.toContain('loaded snapshot');
  } finally { await f.close(); }
});

for (const outcomeUnknown of [false, true]) test(`partial ACP config preserves confirmed fields and reports uncertainty=${outcomeUnknown}`, async () => {
  const f = await fixture();
  const original = f.adapter.call.bind(f.adapter);
  f.adapter.call = (async (method: string, params: unknown) => {
    if (method === 'session/set_mode') throw new HarnessSdkError('MODE_REJECTED', 'private native detail', false, outcomeUnknown);
    return original(method, params);
  }) as typeof f.adapter.call;
  try {
    await expect(f.session.request('session/config/set', { sessionId: 's', requestId: 'partial', patch: { enabled: true, mode: 'plan' } })).rejects.toMatchObject({
      code: 'CONFIG_PARTIAL', outcomeUnknown, details: { appliedKeys: ['enabled'], failedKey: 'mode', cause: { code: 'MODE_REJECTED' } },
    });
    expect(f.session.snapshot.config.enabled).toBe(true);
    expect(f.session.snapshot.config.mode).toBe('code');
    expect(f.session.snapshot.status).toBe(outcomeUnknown ? 'recoveryRequired' : 'ready');
    if (!outcomeUnknown) {
      await f.session.request('session/config/set', { sessionId: 's', requestId: 'next', patch: { enabled: false } });
      expect(f.session.snapshot.config.enabled).toBe(false);
    }
  } finally { await f.close(); }
});

test('configuration uses confirmed aliases and detects an option withdrawn mid-patch', async () => {
  const f = await fixture(['--scenario', 'canonical-config']);
  try {
    await expect(f.session.request('session/config/set', {
      requestId: 'canonical', sessionId: 's', patch: { model: 'second-model', enabled: true },
    })).rejects.toMatchObject({
      code: 'CONFIG_PARTIAL', outcomeUnknown: false,
      details: { appliedKeys: ['model'], failedKey: 'enabled', cause: { code: 'CAPABILITY_UNSUPPORTED' } },
    });
    expect(f.session.snapshot.config).toMatchObject({ model: 'fake-model', 'model-id': 'fake-model' });
    expect(f.session.snapshot.status).toBe('ready');
    expect(f.session.capabilities.config?.options.find(option => option.id === 'model')?.value).toBe('fake-model');
  } finally { await f.close(); }
});

test('a definite first-field ACP config rejection leaves the session unchanged and usable', async () => {
  const f = await fixture();
  const original = f.adapter.call.bind(f.adapter);
  f.adapter.call = (async (method: string, params: unknown) => {
    if (method === 'session/set_mode') throw new HarnessSdkError('MODE_REJECTED');
    return original(method, params);
  }) as typeof f.adapter.call;
  try {
    const before = f.session.snapshot.config;
    await expect(f.session.request('session/config/set', { sessionId: 's', requestId: 'rejected', patch: { mode: 'plan', enabled: true } })).rejects.toMatchObject({ code: 'MODE_REJECTED', outcomeUnknown: false });
    expect(f.session.snapshot.config).toEqual(before);
    expect(f.session.snapshot.status).toBe('ready');
  } finally { await f.close(); }
});

test('fs/terminal are explicit injected clients, never implicitly granted or executed', async () => {
  const plain = await fixture(); try {
    const events = await plain.finished(await plain.start('capabilities'));
    const message = events.find((event) => event.type === 'item/completed' && event.payload.item.type === 'agentMessage');
    const content = message?.type === 'item/completed' && message.payload.item.type === 'agentMessage' ? JSON.parse(message.payload.item.text) : undefined;
    expect(content.fs).toEqual({ readTextFile: false, writeTextFile: false }); expect(content.terminal).toBe(false);
  } finally { await plain.close(); }
  const calls: string[] = [];
  const f = await fixture([], {
    fs: { readTextFile: async () => { calls.push('read'); return { content: 'read' }; }, writeTextFile: async () => { calls.push('write'); } },
    terminal: {
      createTerminal: async () => { calls.push('create'); return { terminalId: 'terminal' }; }, terminalOutput: async () => { calls.push('output'); return { output: 'out', truncated: false }; },
      waitForTerminalExit: async () => { calls.push('wait'); return { exitCode: 0 }; }, killTerminal: async () => { calls.push('kill'); }, releaseTerminal: async () => { calls.push('release'); },
    },
  }); try {
    await f.finished(await f.start('fs')); await f.finished(await f.start('terminal'));
    expect(calls).toEqual(['read', 'write', 'create', 'output', 'wait', 'kill', 'release']);
  } finally { await f.close(); }
});

test('explicit versioned extension exposes optional semantics and structured subagents', async () => {
  const f = await fixture(['--extensions']); try {
    expect(f.initialized.capabilities.session?.fork).toEqual(['before', 'through']);
    const events = await f.finished(await f.start('extended'));
    expect(events.some((event) => event.type === 'item/completed' && event.payload.item.type === 'subagent' && event.payload.item.subagentId === 'child')).toBe(true);
    f.respondWith((request) => request.kind === 'userInput' ? { kind: 'userInput', answers: { q: 'answer' } } : { kind: 'dynamicTool', content: [{ type: 'text', text: 'result' }] });
    for (const command of ['userInput', 'dynamicTool']) expect((await f.finished(await f.start(command))).some((event) => event.type === 'interaction/resolved')).toBe(true);
    const goal = await f.session.request('goal/set', { requestId: 'goal', sessionId: 's', goal: { text: 'finish' } }); expect(goal.status).toBe('active');
    expect((await f.session.request('goal/clear', { requestId: 'clear', sessionId: 's' })).status).toBe('cleared');
    expect((await f.session.request('compact/start', { requestId: 'compact', sessionId: 's' })).status).toBe('completed');
    expect((await f.session.request('history/read', { requestId: 'history', sessionId: 's' })).snapshotToken).toBe('native-snapshot');
    expect((await f.session.request('session/revert', { requestId: 'revert', sessionId: 's', boundary: { turnId: 'native-turn', relation: 'before' }, scope: 'both' })).appliedScope).toBe('both');
    const fork = await f.runtime.openSession({ requestId: 'fork', mode: 'fork', binding: { sessionId: 'fork', adapterId: 'acp', runtimeConfigId: 'fixture' }, cwd: process.cwd(), fork: { sourceSessionId: 's', nativeRef: f.session.binding.nativeRef, boundary: { turnId: 'native-turn', relation: 'through' } } }); expect(fork.binding.nativeRef?.value).toStartWith('fork-');
    const review=await f.session.review({target:{}});
    expect((await f.finished(review.id)).filter((event) => event.type === 'turn/completed')).toHaveLength(1);
  } finally { await f.close(); }
});

test('unknown native requests are rejected and source loss rejects submission with unknown outcome and emits no terminal turn event', async () => {
  const f = await fixture(); try {
    const ordinary = await f.finished(await f.start('unknown-request')); expect(ordinary.find((event) => event.type === 'turn/completed')?.payload).toMatchObject({ status: 'completed' });
    const eventCountBeforeDisconnect=f.events.length;await expect(f.session.submit({input:'disconnect'})).rejects.toMatchObject({code:'ACP_CONNECTION_CLOSED',outcomeUnknown:true});
    expect(f.events.slice(eventCountBeforeDisconnect).some(event=>event.type==='turn/completed')).toBe(false);
  } finally { await f.close(); }
});

test('unsupported ACP major version fails before opening a session', async () => {
  const adapter = createAcpAdapter({ command: process.execPath, args: [executable, '--bad-version'] });
  try { expect(await rejectionOf(adapter.initialize({ protocolVersions: [1], protocolContract: "native-lifecycle", clientInfo: { name: 'test', version: '1' } }))).toMatchObject({ code: 'PROTOCOL_VERSION_UNSUPPORTED' }); }
  finally { await adapter.dispose(); }
});

test('concurrent adapter initialization shares acquisition and retries after failed release completes', async () => {
  const params: InitializeParams = { protocolVersions: [1], protocolContract: 'native-lifecycle', clientInfo: { name: 'test', version: '1' } };
  const { promise: releasing, resolve: startRelease } = Promise.withResolvers<void>();
  const { promise: release, resolve: finishRelease } = Promise.withResolvers<void>();
  let acquisitions = 0;
  let disposals = 0;
  const adapter = createAcpAdapter({
    async connect() {
      const attempt = ++acquisitions;
      let incoming!: ReadableStreamDefaultController;
      return {
        stream: {
          readable: new ReadableStream({ start: controller => { incoming = controller; } }),
          writable: new WritableStream({ write: frame => {
            incoming.enqueue({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: attempt === 1 ? 99 : 1 } });
          } }),
        },
        async dispose() {
          disposals++;
          if (attempt === 1) { startRelease(); await release; }
        },
      };
    },
  });
  try {
    const first = rejectionOf(adapter.initialize(params));
    const second = rejectionOf(adapter.initialize(params));
    await releasing;
    const duringCleanup = rejectionOf(adapter.initialize(params));
    finishRelease();
    for (const error of await Promise.all([first, second, duringCleanup])) {
      expect(error).toMatchObject({ code: 'PROTOCOL_VERSION_UNSUPPORTED' });
    }
    expect(acquisitions).toBe(1);
    expect(disposals).toBe(1);
    const results = await Promise.all([adapter.initialize(params), adapter.initialize(params)]);
    expect(results[0]).toEqual(results[1]);
    expect(acquisitions).toBe(2);
    expect(adapter.connected).toBe(true);
  } finally { finishRelease(); await adapter.dispose(); }
  expect(disposals).toBe(2);
});

test('invalid extension versions remain disabled and method-not-found updates the live capability snapshot', async () => {
  const unsupported = await fixture(['--extensions', '--bad-extension']);
  try { expect(unsupported.initialized.capabilities.session?.history).toBe(false); expect(unsupported.initialized.capabilities.interactions).not.toContain('dynamicTool'); }
  finally { await unsupported.close(); }
  const f = await fixture(['--extensions', '--missing-history']); try {
    const sibling = await f.runtime.sessions.create({ cwd: process.cwd(), config: { mode: 'plan' } });
    expect(f.session.capabilities.session?.history).toBe(true);
    expect(sibling.capabilities.session?.history).toBe(true);
    await expect(f.session.request('history/read', { requestId: 'missing-history', sessionId: 's' })).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED', details: { nativeCode: -32601 },
    });
    const later = await f.runtime.sessions.create({ cwd: process.cwd() });
    expect(f.session.capabilities.session?.history).toBe(false);
    expect(sibling.capabilities.session?.history).toBe(false);
    expect(sibling.snapshot.config.mode).toBe('plan');
    expect(later.capabilities.session?.history).toBe(false);
  } finally { await f.close(); }
});

test('a malformed mutation result leaves the native outcome unknown', async () => {
  const f = await fixture(['--extensions', '--scenario', 'malformed-goal']);
  try {
    await expect(f.session.request('goal/set', { requestId: 'malformed', sessionId: 's', goal: { text: 'finish' } })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR', outcomeUnknown: true,
    });
    expect(f.session.snapshot.status).toBe('recoveryRequired');
  } finally { await f.close(); }
});

test('a permission option ID cannot substitute for the policy kind', async () => {
  const f = await fixture([], { autoRespondPermission: 'allow-once' });
  try {
    f.respondWith(() => ({ kind: 'approval', optionId: 'deny' }));
    const events = await f.finished(await f.start('permission-id-collision'));
    expect(events.some(event => event.type === 'interaction/resolved')).toBe(true);
    expect(events.some(event => event.type === 'notice' && event.payload.code === 'ACP_PERMISSION_AUTO_ANSWERED')).toBe(false);
  } finally { await f.close(); }
});

test('duplicate attachments preserve the live owner and its native routing', async () => {
  const f = await fixture();
  try {
    const reference = f.session.reference;
    const otherId = { ...reference.binding, sessionId: 'duplicate' };
    const otherNative = { ...reference.binding, nativeRef: { provider: 'acp', value: 'other-native' } };
    for (const binding of [reference.binding, otherId, otherNative]) {
      await expect(f.runtime.sessions.resume({ ...reference, binding })).rejects.toMatchObject({ code: 'SESSION_ALREADY_OPEN' });
    }
    expect((await (await f.session.submit({ input: 'still owned' })).result()).text).toBe('Hello still owned');
    await f.resume();
    expect((await (await f.session.submit({ input: 'resumed' })).result()).text).toBe('Hello resumed');
  } finally { await f.close(); }
});

test('closing a session drops late peer traffic and preserves fork lookup', async () => {
  const f = await fixture(['--extensions', '--scenario', 'no-close'], {
    terminal: {
      createTerminal: async () => { throw new Error('retired session reached the terminal port'); },
      terminalOutput: async () => ({ output: '', truncated: false }),
      waitForTerminalExit: async () => ({ exitCode: 0 }),
      killTerminal: async () => {},
      releaseTerminal: async () => {},
    },
  });
  try {
    const retired = await f.runtime.sessions.create({ cwd: process.cwd() });
    const binding = retired.binding;
    await retired.close();
    expect(await f.adapter.call('_test/late-traffic', { sessionId: binding.nativeRef?.value })).toEqual({ terminalRejected: true });
    await f.until(() => f.events.some(event => event.type === 'notice' && event.payload.code === 'ACP_ELICITATION_COMPLETE'));
    expect(f.events.some(event => event.type === 'notice' && event.payload.code === 'ACP_UNKNOWN_NOTIFICATION')).toBe(true);
    expect(f.events.some(event => event.type === 'session/metadata' && event.payload.title === 'Late title')).toBe(false);
    const fork = await f.runtime.openSession({
      requestId: 'fork-closed', mode: 'fork', cwd: process.cwd(), binding: { ...f.runtime.identity, sessionId: 'fork-closed' },
      fork: { sourceSessionId: binding.sessionId, boundary: { turnId: 'native-turn', relation: 'through' } },
    });
    expect(fork.binding.nativeRef?.value).toStartWith('fork-');
  } finally { await f.close(); }
});

test('failed initial configuration closes the acquired native session', async () => {
  const f = await fixture(['--scenario', 'observe-close']);
  try {
    await expect(f.runtime.sessions.create({ cwd: process.cwd(), config: { missing: true } })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await f.until(() => f.events.some(event => event.type === 'notice' && event.payload.code === 'ACP_UNKNOWN_NOTIFICATION'
      && JSON.stringify(event.payload.raw).includes('native-2')));
    expect(f.adapter.sessions.size).toBe(1);
  } finally { await f.close(); }
});

test('an open deadline retains correlation until its late native reply is drained', async () => {
  const adapter = createAcpAdapter({ command: process.execPath, args: [executable, '--scenario', 'slow-first-open'] });
  const client = await createClient({ adapter, identity: { adapterId: 'acp', runtimeConfigId: 'fixture' } });
  const closedSessions: unknown[] = [];
  const original = adapter.call.bind(adapter);
  adapter.call = (async (method: string, params: unknown) => {
    const result = await original(method, params);
    if (method === 'session/close') closedSessions.push(params);
    return result;
  }) as typeof adapter.call;
  try {
    adapter.options.requestTimeoutMs = 40;
    await expect(client.sessions.create({ cwd: process.cwd() })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: true });
    adapter.options.requestTimeoutMs = 1_000;
    const next = await client.sessions.create({ cwd: process.cwd() });
    expect(next.binding.nativeRef?.value).toBe('native-2');
    expect(next.snapshot.metadata?.title).toBeUndefined();
    expect(closedSessions).toEqual([{ sessionId: 'native-1' }]);
    expect(adapter.sessions.size).toBe(1);
  } finally { await client.dispose(); }
});

test('session disposal releases a terminal whose creation is still pending', async () => {
  const { promise: entered, resolve: begin } = Promise.withResolvers<void>();
  const { promise: creating, resolve: finish } = Promise.withResolvers<{ terminalId: string }>();
  const released: string[] = [];
  const f = await fixture([], { terminal: {
    createTerminal: () => { begin(); return creating; },
    terminalOutput: async () => ({ output: '', truncated: false }),
    waitForTerminalExit: async () => ({ exitCode: 0 }),
    killTerminal: async () => {},
    releaseTerminal: async ({ terminalId }) => { released.push(terminalId); },
  } });
  try {
    const pending = f.session.submit({ input: 'terminal-create-only' }).catch(() => {});
    await entered;
    const closing = f.session.close();
    await f.until(() => f.adapter.sessions.get('s')?.disposed === true);
    finish({ terminalId: 'pending-terminal' });
    await closing;
    expect(released).toEqual(['pending-terminal']);
    await pending;
  } finally {
    finish({ terminalId: 'pending-terminal' });
    await f.close();
  }
});

test('native authentication requirements remain diagnosable without propagating raw provider data', async () => {
  const runtime = await createClient({identity:{adapterId:'acp',runtimeConfigId:'fixture'},adapter:createAcpAdapter({ command: process.execPath, args: [executable, '--auth-required'] })});
  try {
    expect(await rejectionOf(runtime.openSession({ requestId: 'auth-open', mode: 'new', binding: { sessionId: 'auth', adapterId: 'acp', runtimeConfigId: 'fixture' }, cwd: process.cwd() }))).toMatchObject({ code: 'AUTH_REQUIRED', outcomeUnknown: false });
  } finally { await runtime.dispose(); }
});

test('outgoing JSONL frame limits fail explicitly rather than sending unbounded input', async () => {
  const f = await fixture([], { maxFrameBytes: 1024 });
  try {
    await expect(f.session.submit({input:'x'.repeat(2048)})).rejects.toMatchObject({code:'BACKPRESSURE_EXCEEDED'});
    expect(f.events.some(event=>event.type==='turn/completed')).toBe(false);
  } finally { await f.close(); }
});


for (const loadOnly of [false, true]) {
  test(`restores ACP titles during ${loadOnly ? 'load' : 'resume'} without replaying metadata as history`, async () => {
    const snapshots: unknown[] = [];
    const f = await fixture(['--scenario', 'titles', ...(loadOnly ? ['--load-only'] : [])], { onLoadSnapshot: (_binding, updates) => snapshots.push(updates) });
    try {
      await f.resume();
      const title = `Restored via session/${loadOnly ? 'load' : 'resume'}`;
      expect(f.session.snapshot.metadata?.title).toBe(title);
      expect(f.events.some(event => event.type === 'item/started' || event.type === 'item/completed' || event.type === 'turn/started')).toBe(false);
      expect(JSON.stringify(snapshots)).not.toContain('session_info_update');
      expect(JSON.stringify(snapshots)).not.toContain(title);
      expect(snapshots).toHaveLength(loadOnly ? 1 : 0);
    } finally { await f.close(); }
  });
}
