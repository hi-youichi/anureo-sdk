import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { createHarnessRuntime, type HarnessSession } from '@anureo/sdk';
import type { AhpEvent, InteractionRequested, InteractionResponse } from '@anureo/protocol';
import { createAcpAdapter, type AcpAdapterOptions } from '../src/index';
import { rejectionOf } from '../../../scripts/harness-sdk/test-helpers';

const executable = resolve(import.meta.dirname, '../../../scripts/harness-sdk/fixtures/fake-acp.mjs');
async function fixture(args: string[] = [], options: Partial<AcpAdapterOptions> = {}) {
  const adapter = createAcpAdapter({ command: process.execPath, args: [executable, ...args], ...options });
  const runtime = createHarnessRuntime(adapter);
  const initialized = await runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'test', version: '1' }, clientCapabilities: { interactions: ['approval', 'userInput', 'elicitation', 'dynamicTool'] } });
  let session: HarnessSession = await runtime.openSession({ requestId: 'open', mode: 'new', binding: { sessionId: 's', adapterId: 'acp', runtimeConfigId: 'fixture' }, cwd: process.cwd() });
  const events: AhpEvent[] = [];
  let response: ((request: InteractionRequested) => InteractionResponse) | undefined;
  let consumedError: unknown;
  const consume = (value: HarnessSession) => (async () => {
    try { for await (const event of value.events()) { events.push(event); if (event.type === 'interaction/requested' && response) await value.respond({ requestId: `answer-${event.payload.interactionId}`, sessionId: 's', interactionId: event.payload.interactionId, response: response(event.payload) }); } }
    catch (error) { consumedError = error; }
  })();
  const pumps = [consume(session)];
  let counter = 0;
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 500; i++) { if (predicate()) return; if (consumedError) throw consumedError; await new Promise((resolve) => setTimeout(resolve, 2)); } throw Error('Timed out awaiting ACP fixture'); };
  return {
    adapter, runtime, initialized, events, get session() { return session; }, until,
    respondWith(handler: (request: InteractionRequested) => InteractionResponse) { response = handler; },
    async start(text: string) { const id = `turn-${++counter}`; await session.startTurn({ requestId: `start-${counter}`, sessionId: 's', turnId: id, input: [{ type: 'text', text }] }); return id; },
    async finished(id: string) { await until(() => events.some((event) => event.type === 'turn/completed' && event.payload.turnId === id)); const interactionIds = new Set(events.filter((event) => event.turnId === id && event.type === 'interaction/requested').map((event) => event.type === 'interaction/requested' ? event.payload.interactionId : '')); return events.filter((event) => event.turnId === id || (event.type === 'interaction/resolved' && interactionIds.has(event.payload.interactionId))); },
    async resume() { const binding = session.binding; await session.close(); session = await runtime.openSession({ requestId: 'resume', mode: 'resume', binding, cwd: process.cwd() }); pumps.push(consume(session)); },
    async close() { await runtime.dispose(); await Promise.all(pumps); },
  };
}

test('vanilla native stdio maps structured updates, complete authority, reused ids and unknown messages', async () => {
  const f = await fixture(); try {
    expect(f.initialized.capabilities.turn?.steer).toBe(false); expect(f.initialized.capabilities.session?.fork).toEqual([]);
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
    expect(await rejectionOf(f.session.steer({ requestId: 'unsupported', sessionId: 's', expectedTurnId: second, input: [{ type: 'text', text: 'no' }] }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
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
    const id = await f.start('wait'); await f.session.interrupt({ requestId: 'cancel', sessionId: 's', turnId: id });
    const events = await f.finished(id);
    expect(events.filter((event) => event.type === 'turn/completed')).toHaveLength(1);
    expect(events.find((event) => event.type === 'turn/completed')?.payload).toMatchObject({ status: 'interrupted' });
  } finally { await f.close(); }
});

test('mode/config native operations update declared schemas and load snapshots do not replay live events', async () => {
  const snapshots: unknown[] = [];
  const f = await fixture(['--load-only'], { onLoadSnapshot: (_binding, updates) => snapshots.push(updates) }); try {
    expect(f.session.capabilities.config?.options.map((option) => option.id)).toEqual(['model-id', 'model', 'enabled', 'mode']);
    const state = await f.session.setConfig({ requestId: 'config', sessionId: 's', patch: { model: 'second-model', mode: 'plan', enabled: true } });
    expect(state.config.model).toBe('second-model'); expect(state.config.mode).toBe('plan'); expect(state.config.enabled).toBe(true);
    await f.resume();
    expect(snapshots).toHaveLength(1); expect(JSON.stringify(snapshots)).toContain('loaded snapshot');
    expect(JSON.stringify(f.events)).not.toContain('loaded snapshot');
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
    const goal = await f.session.setGoal({ requestId: 'goal', sessionId: 's', goal: { text: 'finish' } }); expect(goal.status).toBe('active');
    expect((await f.session.clearGoal({ requestId: 'clear', sessionId: 's' })).status).toBe('cleared');
    expect((await f.session.compact({ requestId: 'compact', sessionId: 's' })).status).toBe('completed');
    expect((await f.session.readHistory({ requestId: 'history', sessionId: 's' })).snapshotToken).toBe('native-snapshot');
    expect((await f.session.revert({ requestId: 'revert', sessionId: 's', boundary: { turnId: 'native-turn', relation: 'before' }, scope: 'both' })).appliedScope).toBe('both');
    const fork = await f.runtime.openSession({ requestId: 'fork', mode: 'fork', binding: { sessionId: 'fork', adapterId: 'acp', runtimeConfigId: 'fixture' }, cwd: process.cwd(), fork: { sourceSessionId: 's', nativeRef: f.session.binding.nativeRef, boundary: { turnId: 'native-turn', relation: 'through' } } }); expect(fork.binding.nativeRef?.value).toStartWith('fork-');
    await f.session.review({ requestId: 'review', sessionId: 's', turnId: 'review-turn', target: {} });
    expect((await f.finished('review-turn')).filter((event) => event.type === 'turn/completed')).toHaveLength(1);
  } finally { await f.close(); }
});

test('unknown native requests are rejected and source loss produces an explicit failed observation', async () => {
  const f = await fixture(); try {
    const ordinary = await f.finished(await f.start('unknown-request')); expect(ordinary.find((event) => event.type === 'turn/completed')?.payload).toMatchObject({ status: 'completed' });
    const disconnected = await f.finished(await f.start('disconnect'));
    expect(disconnected.find((event) => event.type === 'turn/completed')?.payload).toMatchObject({ status: 'failed', error: { outcomeUnknown: true } });
  } finally { await f.close(); }
});

test('unsupported ACP major version fails before opening a session', async () => {
  const adapter = createAcpAdapter({ command: process.execPath, args: [executable, '--bad-version'] });
  try { expect(await rejectionOf(adapter.initialize({ protocolVersions: [1], clientInfo: { name: 'test', version: '1' } }))).toMatchObject({ code: 'PROTOCOL_VERSION_UNSUPPORTED' }); }
  finally { await adapter.dispose(); }
});

test('invalid extension versions remain disabled and method-not-found updates the live capability snapshot', async () => {
  const unsupported = await fixture(['--extensions', '--bad-extension']);
  try { expect(unsupported.initialized.capabilities.turn?.steer).toBe(false); expect(unsupported.initialized.capabilities.interactions).not.toContain('dynamicTool'); }
  finally { await unsupported.close(); }
  const f = await fixture(['--extensions', '--missing-steer']); try {
    const id = await f.start('wait');
    expect(await rejectionOf(f.session.steer({ requestId: 'missing-steer', sessionId: 's', expectedTurnId: id, input: [{ type: 'text', text: 'redirect' }] }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(f.session.capabilities.turn?.steer).toBe(false);
    await f.session.interrupt({ requestId: 'stop', sessionId: 's', turnId: id }); await f.finished(id);
  } finally { await f.close(); }
});

test('native authentication requirements remain diagnosable without propagating raw provider data', async () => {
  const runtime = createHarnessRuntime(createAcpAdapter({ command: process.execPath, args: [executable, '--auth-required'] }));
  try {
    await runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'test', version: '1' } });
    expect(await rejectionOf(runtime.openSession({ requestId: 'auth-open', mode: 'new', binding: { sessionId: 'auth', adapterId: 'acp', runtimeConfigId: 'fixture' }, cwd: process.cwd() }))).toMatchObject({ code: 'AUTH_REQUIRED', outcomeUnknown: false });
  } finally { await runtime.dispose(); }
});

test('outgoing JSONL frame limits fail explicitly rather than sending unbounded input', async () => {
  const f = await fixture([], { maxFrameBytes: 1024 });
  try {
    const events = await f.finished(await f.start('x'.repeat(2048)));
    expect(events.find((event) => event.type === 'turn/completed')?.payload).toMatchObject({ status: 'failed' });
  } finally { await f.close(); }
});


for (const loadOnly of [false, true]) {
  test(`restores ACP titles during ${loadOnly ? 'load' : 'resume'} without replaying metadata as history`, async () => {
    const snapshots: unknown[] = [];
    const f = await fixture(['--scenario', 'titles', ...(loadOnly ? ['--load-only'] : [])], { onLoadSnapshot: (_binding, updates) => snapshots.push(updates) });
    try {
      await f.resume();
      const title = `Restored via session/${loadOnly ? 'load' : 'resume'}`;
      await f.until(() => f.events.some(event => event.type === 'session/state' && event.payload.metadata?.title === title));
      expect(f.events.filter(event => event.type === 'session/metadata').map(event => event.payload)).toEqual([{ title }]);
      expect(f.events.some(event => event.type === 'item/started' || event.type === 'item/completed' || event.type === 'turn/started')).toBe(false);
      expect(JSON.stringify(snapshots)).not.toContain('session_info_update');
      expect(JSON.stringify(snapshots)).not.toContain(title);
      expect(snapshots).toHaveLength(loadOnly ? 1 : 0);
    } finally { await f.close(); }
  });
}
