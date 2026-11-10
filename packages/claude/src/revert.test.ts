import { expect, test } from 'bun:test';
import { InMemorySessionStore, type SDKMessage, type SDKUserMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { BoundedEventQueue, createClient, HarnessSdkError } from '@anureo/sdk';
import { createClaudeAdapter, type ClaudeAdapterOptions, type ClaudeQuery } from './index';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const history: SessionMessage[] = [{ type: 'user', uuid: 'historical', session_id: 'native', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: 'old' } }];
async function fixture(getSessionMessages: NonNullable<ClaudeAdapterOptions['getSessionMessages']> = async () => history) {
  const queries: Array<{ output: BoundedEventQueue<SDKMessage>; input: AsyncIterator<SDKUserMessage>; closed: number }> = [];
  const client = await createClient({
    adapter: createClaudeAdapter({ sessionStore: new InMemorySessionStore(), getSessionMessages, queryFactory: ({ prompt }) => {
      if (typeof prompt === 'string') throw new Error('Expected streaming input');
      const q = { output: new BoundedEventQueue<SDKMessage>(), input: prompt[Symbol.asyncIterator](), closed: 0 };
      queries.push(q);
      const query: ClaudeQuery = {
        [Symbol.asyncIterator]: () => q.output[Symbol.asyncIterator](),
        close: () => { q.closed++; q.output.end(); }, interrupt: async () => undefined,
        setModel: async () => {}, setPermissionMode: async () => {}, setMaxThinkingTokens: async () => {}, applyFlagSettings: async () => {},
        supportedModels: async () => [], rewindFiles: async () => ({ canRewind: true }),
      };
      return query;
    } }),
    identity: { adapterId: 'claude', runtimeConfigId: 'revert' },
  });
  const session = await client.sessions.create({ cwd: process.cwd() });
  const send = (index: number, value: Record<string, unknown>) => queries[index]!.output.write(value as unknown as SDKMessage);
  return { client, session, queries,
    revert: (requestId: string) => session.request('session/revert', { sessionId: session.id, requestId, scope: 'conversation', boundary: { turnId: 'historical-turn', nativeTurnId: 'historical', relation: 'before' } }),
    async input(index: number) { const next = await queries[index]!.input.next(); if (next.done) throw new Error('Expected an input'); return next.value.uuid!; },
    assistant: (index: number, uuid: string) => send(index, { type: 'assistant', parent_tool_use_id: null, user_message_uuids: [uuid], message: { id: 'message', role: 'assistant', content: [{ type: 'text', text: 'working' }] } }),
    result: (index: number, uuid: string, text: string) => send(index, { type: 'result', subtype: 'success', is_error: false, num_turns: 1, user_message_uuids: [uuid], result: text, usage: {} }),
  };
}

test('Claude rejects revert for pending and active inputs, then creates a distinct execution after idle revert', async () => {
  let reads = 0;
  const f = await fixture(async () => { reads++; return history; });
  try {
    const pending = f.session.submit({ input: 'first' });
    const firstId = await f.input(0);
    await expect(f.revert('pending')).rejects.toMatchObject({ code: 'SESSION_BUSY', outcomeUnknown: false });
    await f.assistant(0, firstId);
    const first = await pending;
    await expect(f.revert('active')).rejects.toMatchObject({ code: 'SESSION_BUSY', outcomeUnknown: false });
    expect(reads).toBe(0);
    expect(f.queries[0]!.closed).toBe(0);
    await f.result(0, firstId, 'first final');
    expect((await first.result()).text).toBe('first final');
    await f.revert('idle');
    expect(f.queries).toHaveLength(2);
    expect(f.queries[0]!.closed).toBe(1);
    const next = f.session.submit({ input: 'second' });
    const secondId = await f.input(1);
    await f.result(1, secondId, 'second final');
    const second = await next;
    expect(second.id).not.toBe(first.id);
    expect((await second.result()).text).toBe('second final');
    expect((await first.result()).text).toBe('first final');
  } finally { await f.client.dispose(); }
});

test('Claude holds revert admission across awaits and rejects competing input, config and revert', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture(async () => { entered.resolve(); await release.promise; return history; });
  try {
    const reverting = f.revert('first');
    await entered.promise;
    await expect(f.session.submit({ input: 'racing input' })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await expect(f.revert('second')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await expect(f.session.request('session/config/set', { sessionId: f.session.id, requestId: 'config', patch: { model: 'new-model' } })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    release.resolve(); await reverting;
    const next = f.session.submit({ input: 'after revert' });
    const id = await f.input(1);
    await f.result(1, id, 'new execution');
    expect((await (await next).result()).text).toBe('new execution');
  } finally { release.resolve(); await f.client.dispose(); }
});

test('a failed Claude boundary lookup releases revert admission without replacing the query', async () => {
  const f = await fixture(async () => { throw new HarnessSdkError('TURN_NOT_FOUND'); });
  try {
    await expect(f.revert('missing')).rejects.toMatchObject({ code: 'TURN_NOT_FOUND' });
    expect(f.session.snapshot.status).toBe('ready');
    const pending = f.session.submit({ input: 'still usable' });
    const id = await f.input(0);
    await f.result(0, id, 'original query');
    expect((await (await pending).result()).text).toBe('original query');
    expect(f.queries).toHaveLength(1);
  } finally { await f.client.dispose(); }
});

test('disposing Claude during a boundary lookup cannot create a replacement query later', async () => {
  const entered = deferred(), release = deferred(), finished = deferred();
  const f = await fixture(async () => { entered.resolve(); await release.promise; finished.resolve(); return history; });
  try {
    const reverting = f.revert('closing');
    const rejected = reverting.catch(cause => cause as unknown);
    await entered.promise;
    await f.client.dispose();
    release.resolve(); await finished.promise;
    expect(await rejected).toMatchObject({ code: 'OBSERVATION_CLOSED' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]!.closed).toBe(1);
  } finally { release.resolve(); await f.client.dispose(); }
});
