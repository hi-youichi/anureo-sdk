/** Exercises SDK lifecycle behavior through a deterministic Codex JSONL process. */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createClient } from '@anureo/sdk';
import type { AhpEvent } from '@anureo/protocol';
import { createCodexAdapter } from '../src';
import { runNativeConformance } from '@anureo/conformance';
import { rejectionOf } from './test-helpers';
const executable = fileURLToPath(new URL('./native-lifecycle-fixture.mjs', import.meta.url));
const lifecycleProfiles = ['0.148.0', '0.164.0'];

/** Open a session on the scripted process (modern profile by default). Startup failures reject. The caller owns disposal of the returned client. */
async function fixture(version = '0.164.0', scenario = 'default') {
  const client = await createClient({
    adapter: createCodexAdapter({
      command: process.execPath,
      args: [executable, scenario],
      version,
      timeoutMs: 1000
    }),
    identity: {
      adapterId: 'codex',
      runtimeConfigId: 'native'
    },
    ...(scenario === 'interaction-capacity' ? {
      interactions: { approval: undefined },
      runtime: { maxPendingInteractions: 1 },
    } : {}),
  });
  const session = await client.sessions.create({ cwd: process.cwd() });
  return { client, session };
}
for (const version of lifecycleProfiles) {
  /** Keep the first execution active across a definite rejection and a join; both handles must resolve from client-ID evidence. The fixture client is always disposed. */
  test(`${version}: real JSONL process correlates joined submissions by clientId rather than response turn id`, async () => {
    const f = await fixture(version);
    const events = f.session.events({ signal: AbortSignal.timeout(2000) })[Symbol.asyncIterator]();
    try {
      const first = await f.session.submit({ input: 'first' });
      let firstBindings = 0;
      await waitForEvent(events, event => {
        if (event.type === 'submission/bound' && event.payload.turnId === first.id) firstBindings++;
        return event.type === 'submission/status' && event.payload.receipt?.nativeSubmissionId === 'actual';
      });
      await events.return?.();
      expect(firstBindings).toBe(1);
      await expect(f.session.submit({ input: 'reject' })).rejects.toMatchObject({ rpcCode: -32602 });
      const second = await f.session.submit({ input: 'join' });
      expect(first.id).toBe('actual');
      expect(second.id).toBe(first.id);
      expect((await first.result()).text).toBe('native result');
      expect((await second.result()).text).toBe('native result');
    } finally { await f.client.dispose(); }
  });
}
/** Close observation while native execution remains active; assert its result rejects instead of reporting interruption, and release the process in finally. */
test('native unsubscribe while active closes observation without inventing an interrupted result', async () => {
  const f = await fixture();
  try {
    const turn = await f.session.submit({ input: 'first' });
    expect(await f.session.close()).toMatchObject({ executionStopped: 'unconfirmed' });
    await expect(turn.result()).rejects.toMatchObject({ code: 'OBSERVATION_CLOSED' });
  } finally { await f.client.dispose(); }
});
for (const version of lifecycleProfiles) {
  /** Delegate lifecycle assertions and fixture disposal to shared conformance; a failed report must fail this test for each supported profile. */
  test(`${version}: Codex revised v1 passes shared native lifecycle conformance over actual stdio`, async () => {
    const report = await runNativeConformance(
      /** Supply a fresh session per case. The runner records setup failures and disposes each returned client. */
      async () => ({ ...await fixture(version), first: 'first', second: 'join', relation: 'same' }),
    );
    expect(report).toMatchObject({ passed: true });
  });
}
/** Hold review evidence behind an explicit history request so acknowledgement cannot resolve the execution handle; assert the later native outcome and always dispose the client. */
test('review acknowledgement alone never fabricates a started execution', async () => {
  const f = await fixture();
  try {
    const events = f.session.events({ signal: AbortSignal.timeout(2000) })[Symbol.asyncIterator]();
    const pendingReview = f.session.review({ target: { type: 'uncommittedChanges' } });
    let reviewResolved = false;
    void pendingReview.then(() => { reviewResolved = true; }, () => {});
    await waitForEvent(events, event => {
      expect(event.type).not.toBe('submission/bound');
      return event.type === 'submission/status'
        && event.payload.status === 'accepted' && event.payload.receipt?.nativeSubmissionId === 'actual-review';
    });
    await events.return?.();
    expect(reviewResolved).toBe(false);
    // The fixture emits the pending review's started/completed events before replying to thread/items/list.
    await f.session.request('history/read', { requestId: 'observe-review', sessionId: f.session.id });
    const reviewTurn = await pendingReview;
    expect(reviewTurn.id).toBe('actual-review');
    expect((await reviewTurn.result()).status).toBe('interrupted');
  } finally { await f.client.dispose(); }
});

test('a malformed input receipt keeps late client-ID evidence eligible to bind', async () => {
  const f = await fixture();
  try {
    const events = f.session.events({ signal: AbortSignal.timeout(2000) })[Symbol.asyncIterator]();
    const unknown = await rejectionOf(f.session.submit({ input: 'malformed receipt' }));
    expect(unknown).toMatchObject({ code: 'PROTOCOL_ERROR', outcomeUnknown: true });
    const status = await waitForEvent(events, event => event.type === 'submission/status' && event.payload.status === 'unknown');
    if (status.type !== 'submission/status') throw new Error('Expected unknown submission status');
    await f.session.request('history/read', { requestId: 'observe-input', sessionId: f.session.id });
    await waitForEvent(events, event => event.type === 'submission/bound'
      && event.payload.submissionId === status.payload.submissionId && event.payload.turnId === 'actual');
  } finally { await f.client.dispose(); }
});

test('an early reasoning delta can be followed by a reasoning snapshot', async () => {
  const f = await fixture();
  try {
    const events = f.session.events({ signal: AbortSignal.timeout(2000) })[Symbol.asyncIterator]();
    const turn = await f.session.submit({ input: 'reasoning first' });
    const started = await waitForEvent(events, event => event.type === 'item/started' && event.itemId === 'reasoning');
    expect(started.payload).toMatchObject({ item: { type: 'reasoning', summary: '' } });
    expect(await turn.result()).toMatchObject({ status: 'completed', items: expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', summary: 'summary' }),
    ]) });
  } finally { await f.client.dispose(); }
});

test('an interaction rejected by the SDK registry receives a native error', async () => {
  const f = await fixture('0.164.0', 'interaction-capacity');
  try {
    const turn = await f.session.submit({ input: 'first' });
    // The fixture completes only after receiving the fallback for its second approval.
    expect(await turn.result({ timeoutMs: 2000 })).toMatchObject({ status: 'completed' });
  } finally { await f.client.dispose(); }
});

const throughBoundary = { turnId: 'actual', nativeTurnId: 'actual', relation: 'through' } as const;

test('legacy revert rejects a second revert while its boundary read is pending', async () => {
  const f = await fixture('0.148.0', 'rollback-overlap');
  try {
    const sessionId = f.session.id;
    const events = f.session.events({ signal: AbortSignal.timeout(2000) })[Symbol.asyncIterator]();
    const params = { sessionId, boundary: throughBoundary, scope: 'conversation' } as const;
    const first = f.session.request('session/revert', { ...params, requestId: 'revert-first' });
    void first.catch(() => {});
    await waitForEvent(events, event => event.type === 'notice' && event.payload.message === 'fixture/turn-read-pending');
    const second = rejectionOf(f.session.request('session/revert', { ...params, requestId: 'revert-second' }, { timeoutMs: 500 }));
    await expect(second).resolves.toMatchObject({ code: 'SESSION_BUSY' });
    await f.session.request('compact/start', { sessionId, requestId: 'release-read' });
    expect(await first).toMatchObject({ boundary: throughBoundary });
  } finally { await f.client.dispose(); }
});

test('a legacy revert preparation timeout leaves a session callable', async () => {
  const f = await fixture('0.148.0', 'revert-read-timeout');
  try {
    const sessionId = f.session.id;
    const cause = await rejectionOf(f.session.request('session/revert', {
      sessionId, requestId: 'revert', boundary: throughBoundary, scope: 'conversation',
    }));
    expect(cause).toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: false });
    expect(await f.session.request('compact/start', { sessionId, requestId: 'compact' })).toMatchObject({ status: 'accepted' });
  } finally { await f.client.dispose(); }
});

test('repeated native cursors reject both item history and through-boundary reverts', async () => {
  const f = await fixture('0.164.0', 'cursor-cycle');
  try {
    const sessionId = f.session.id;
    expect(await rejectionOf(f.session.request('history/read', { sessionId, requestId: 'history' })))
      .toMatchObject({ code: 'PROTOCOL_ERROR', message: 'Repeated native history cursor' });
    expect(await rejectionOf(f.session.request('session/revert', {
      sessionId, requestId: 'revert', boundary: throughBoundary, scope: 'conversation',
    }))).toMatchObject({ code: 'PROTOCOL_ERROR', message: 'Repeated native turn cursor' });
  } finally { await f.client.dispose(); }
});

test('a history snapshot still loading when a revert succeeds expires', async () => {
  const f = await fixture('0.164.0', 'history-overlaps-revert');
  try {
    const sessionId = f.session.id;
    const events = f.session.events({ signal: AbortSignal.timeout(2000) })[Symbol.asyncIterator]();
    const history = rejectionOf(f.session.request('history/read', { sessionId, requestId: 'history' }));
    void history.catch(() => {});
    await waitForEvent(events, event => event.type === 'notice' && event.payload.message === 'fixture/history-page-pending');
    await f.session.request('session/revert', {
      sessionId, requestId: 'revert', boundary: { ...throughBoundary, relation: 'before' }, scope: 'conversation',
    });
    await f.session.request('compact/start', { sessionId, requestId: 'release-history-page' });
    expect(await history).toMatchObject({ code: 'CURSOR_EXPIRED' });
    expect(await f.session.request('history/read', { sessionId, requestId: 'fresh-history' })).toMatchObject({ items: [] });
  } finally { await f.client.dispose(); }
});

/** Wait on a subscription with a deadline set by the caller. */
async function waitForEvent(events: AsyncIterator<AhpEvent>, matches: (event: AhpEvent) => boolean): Promise<AhpEvent> {
  for (let next = await events.next(); !next.done; next = await events.next()) {
    if (matches(next.value)) return next.value;
  }
  throw new Error('Expected session event was not received');
}
