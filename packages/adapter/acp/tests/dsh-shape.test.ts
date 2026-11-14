import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { createClient } from '@anureo/sdk';
import type { AhpEvent, Capabilities } from '@anureo/protocol';
import { createAcpAdapter, createDshAcpAdapter, type AcpAdapterOptions } from '../src/index';
import { resolveConfigValue } from '../src/mapping';
import { rejectionOf } from './test-helpers';

const executable = resolve(import.meta.dirname, './fixtures/dsh-acp.mjs');
/** Prefer the envelope's turn ID, with a payload fallback for assertions on turn events. */
function turnIdOf(event: AhpEvent): string | undefined {
  if (event.turnId != null) return event.turnId;
  if ('turnId' in event.payload) return (event.payload as { turnId?: string }).turnId;
  return undefined;
}

/** Initialize the scripted peer with explicit interaction responses enabled. The caller owns client disposal. */
async function openFixtureClient(args: string[] = [], options: AcpAdapterOptions = {}) {
  const adapter = createAcpAdapter({ command: process.execPath, args: [executable, ...args], ...options });
  const runtime = await createClient({
    adapter,
    identity: { adapterId: 'dsh-acp', runtimeConfigId: 'fixture' },
    // The fallback approval test sends interaction/respond itself.
    interactions: { approval: undefined, userInput: undefined, elicitation: undefined, dynamicTool: undefined },
  });
  return { adapter, runtime };
}

/** Open a session and subscribe before submitting turns. Await close to dispose the client and join the event pump. */
async function fixture(args: string[] = [], options: AcpAdapterOptions = {}) {
  const { adapter, runtime } = await openFixtureClient(args, options);
  const session = await runtime.sessions.create({ cwd: process.cwd() });
  const events: AhpEvent[] = [];
  const pump = (async () => {
    try {
      for await (const event of session.events()) {
        events.push(event);
      }
    } catch {
      // The assertions use captured events. Missing events surface through the polling timeout.
    }
  })();
  /** Poll an observed event condition for up to roughly one second; timeout rejects the test. */
  const until = async (predicate: () => boolean) => {
    for (let index = 0; index < 500; index++) {
      if (predicate()) return;
      await new Promise((done) => setTimeout(done, 2));
    }
    throw new Error('Timed out awaiting the DSH fixture');
  };
  /** Wait for terminal event publication for the submitted turn, including failed outcomes. */
  const untilTurnCompletes = (id: string) =>
    until(() => events.some((event) => event.type === 'turn/completed' && turnIdOf(event) === id));
  return {
    adapter, session, events, until, untilTurnCompletes,
    /** Submit input and return that turn's captured events once its terminal event is published. */
    async turn(text: string) {
      const turn = await session.submit({ input: text });
      // These assertions observe terminal publication through the event stream.
      void turn.result().catch(() => {});
      await untilTurnCompletes(turn.id);
      return events.filter((event) => turnIdOf(event) === turn.id);
    },
    /** Dispose the client and join event collection after successful disposal. */
    async close() {
      await runtime.dispose();
      await pump;
    },
  };
}

const completed = (events: AhpEvent[]) => events.find((event) => event.type === 'turn/completed');

test('the DSH shape publishes the standard ACP baseline and nothing else', async () => {
  const f = await fixture();
  try {
    const capabilities = f.adapter.capabilities;
    expect(capabilities.session?.resume).toBe(true);
    expect(capabilities.session?.fork).toEqual([]);
    expect(capabilities.session?.revert).toEqual([]);
    expect(capabilities.session?.history).toBe(false);
    expect(capabilities.input?.steer).toBeUndefined();
    expect(capabilities.input?.interrupt).toEqual({ targets: ['session'], reportsPendingInputs: false });
    expect(capabilities.turn?.inputModalities).toEqual(['text']);
    expect(capabilities.mcp).toMatchObject({ stdio: true, http: true });
    expect(f.session.capabilities.config?.options.map((option) => option.id)).toEqual(['model', 'reasoning_effort']);
    expect(capabilities.extensions).toEqual([]);
    expect(capabilities.goal?.actions).toEqual([]);
    expect(capabilities.compact).toBe(false);
    expect(capabilities.review).toBe(false);
  } finally { await f.close(); }
});

test('embeddedContext=false rejects file blocks before dispatch', async () => {
  const f = await fixture();
  try {
    expect(await rejectionOf(f.session.submit({ input: [{ type: 'file', uri: 'file:///tmp/notes.txt' }] }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  } finally { await f.close(); }
});

test('the permission policy answers without an AHP interaction and stays auditable', async () => {
  const f = await fixture(['--permission'], { autoRespondPermission: 'allow-once' });
  try {
    const events = await f.turn('permission');
    expect(events.some((event) => event.type === 'interaction/requested')).toBe(false);
    expect(events.some((event) => event.type === 'notice' && event.payload.code === 'ACP_PERMISSION_AUTO_ANSWERED')).toBe(true);
    const text = events
      .flatMap((event) => event.type === 'item/completed' && event.payload.item.type === 'agentMessage' ? [event.payload.item.text] : [])
      .join('');
    expect(text).toContain('selected');
    expect(completed(events)?.payload).toMatchObject({ status: 'completed' });
  } finally { await f.close(); }
});

test('a policy that declines to decide keeps the interactive approval path', async () => {
  const f = await fixture(['--permission'], { autoRespondPermission: () => undefined });
  try {
    const turn = await f.session.submit({ input: 'permission' });
    void turn.result().catch(() => {});
    await f.until(() => f.events.some((event) => event.type === 'interaction/requested'));
    expect(f.events.some((event) => event.type === 'notice' && event.payload.code === 'ACP_PERMISSION_AUTO_ANSWERED')).toBe(false);
    const request = f.events.find((event) => event.type === 'interaction/requested');
    if (request?.type === 'interaction/requested') {
      await f.session.request('interaction/respond', { requestId: 'answer', sessionId: f.session.binding.sessionId, interactionId: request.payload.interactionId, response: { kind: 'approval', optionId: 'reject-once' } });
    }
    await f.untilTurnCompletes(turn.id);
    expect(f.events.some((event) => event.type === 'interaction/resolved')).toBe(true);
  } finally { await f.close(); }
});

test('stop reasons never turn an unclassified stop into success', async () => {
  const truncated = await fixture(['--stop', 'max_tokens']);
  try {
    const events = await truncated.turn('hello');
    expect(completed(events)?.payload).toMatchObject({ status: 'completed' });
    expect(events.some((event) => event.type === 'notice' && event.payload.code === 'ACP_STOP_MAX_TOKENS')).toBe(true);
  } finally { await truncated.close(); }

  const refused = await fixture(['--stop', 'refusal']);
  try {
    expect(completed(await refused.turn('hello'))?.payload).toMatchObject({ status: 'failed' });
  } finally { await refused.close(); }

  const unknown = await fixture(['--stop', 'telemetry-void']);
  try {
    const events = await unknown.turn('hello');
    expect(completed(events)?.payload).toMatchObject({ status: 'failed' });
    expect(events.some((event) => event.type === 'notice' && event.payload.code === 'ACP_STOP_UNKNOWN')).toBe(true);
  } finally { await unknown.close(); }
});

test('model aliases resolve to the advertised wire value and unknown ones fail early', () => {
  const capabilities = { config: { options: [{ id: 'model', title: 'Model', scope: 'session', schema: { type: 'string', enum: ['deepseek-official/deepseek-v4-flash', 'deepseek-official/deepseek-v4-pro'] } }] } } as unknown as Capabilities;
  /** Return the synchronous failure for code assertions, or undefined if validation succeeds. */
  const capture = (run: () => unknown) => {
    try {
      run();
      return undefined;
    } catch (error) {
      return error;
    }
  };
  expect(resolveConfigValue(capabilities, 'model', 'deepseek-v4-flash')).toBe('deepseek-official/deepseek-v4-flash');
  expect(resolveConfigValue(capabilities, 'model', 'deepseek-official/deepseek-v4-pro')).toBe('deepseek-official/deepseek-v4-pro');
  expect(capture(() => resolveConfigValue(capabilities, 'model', 'gpt-9'))).toMatchObject({ code: 'INVALID_PARAMS' });
  expect(capture(() => resolveConfigValue({ config: { options: [] } } as unknown as Capabilities, 'model', 'x'))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
});

test('the open path resolves a bare model before it reaches the backend', async () => {
  const { runtime } = await openFixtureClient();
  try {
    const session = await runtime.sessions.create({ cwd: process.cwd(), model: 'deepseek-v4-flash' });
    expect(session.binding.adapterId).toBe('dsh-acp');
    await session.close();
    expect(await rejectionOf(runtime.sessions.create({ cwd: process.cwd(), model: 'gpt-9' }))).toMatchObject({ code: 'INVALID_PARAMS' });
  } finally { await runtime.dispose(); }
});

test('startup stderr is retained, redacted, and attached to the handshake failure', async () => {
  const adapter = createAcpAdapter({ command: process.execPath, args: [executable, '--fail-startup'], requestTimeoutMs: 1_500 });
  const error = await rejectionOf(createClient({ adapter, identity: { adapterId: 'dsh-acp', runtimeConfigId: 'broken' } }));
  const tail = (error as { details?: { diagnostics?: { stderrTail?: string } } }).details?.diagnostics?.stderrTail;
  expect(tail).toContain('fatal: gated startup');
  expect(tail).toContain('sk-[redacted]');
  expect(tail).not.toContain('sk-live-abcdef123456');
});

test('the DSH preset pins the profile, home, timeout, and unattended policy', () => {
  const adapter = createDshAcpAdapter({ command: 'dsh-next', dshHome: '/tmp/dsh-home', autoApprove: true });
  expect(adapter.options.args).toEqual(['--profile', 'acp']);
  expect(adapter.options.command).toBe('dsh-next');
  expect(adapter.options.env?.DSH_HOME).toBe('/tmp/dsh-home');
  expect(adapter.options.requestTimeoutMs).toBe(120_000);
  expect(adapter.options.stderrTailLines).toBe(200);
  expect(adapter.options.autoRespondPermission).toBe('allow-once');
  expect(createDshAcpAdapter().options.args).toEqual(['--profile', 'acp']);
});
