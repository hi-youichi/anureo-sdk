/** Exercises SDK lifecycle behavior through a deterministic Codex JSONL process. */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createClient } from '@anureo/sdk';
import { createCodexAdapter } from '../src';
import { runNativeConformance } from '@anureo/conformance';
const executable = fileURLToPath(new URL('./native-lifecycle-fixture.mjs', import.meta.url));
const lifecycleProfiles = ['0.148.0', '0.164.0'];

/** Open a session on the scripted process (modern profile by default). Startup failures reject. The caller owns disposal of the returned client. */
async function fixture(version = '0.164.0') {
  const client = await createClient({
    adapter: createCodexAdapter({
      command: process.execPath,
      args: [executable],
      version,
      timeoutMs: 1000
    }),
    identity: {
      adapterId: 'codex',
      runtimeConfigId: 'native'
    }
  });
  const session = await client.sessions.create({ cwd: process.cwd() });
  return { client, session };
}
for (const version of lifecycleProfiles) {
  /** Keep the first execution active across a definite rejection and a join; both handles must resolve from client-ID evidence. The fixture client is always disposed. */
  test(`${version}: real JSONL process correlates joined submissions by clientId rather than response turn id`, async () => {
    const f = await fixture(version);
    try {
      const first = await f.session.submit({ input: 'first' });
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
    const pendingReview = f.session.review({ target: { type: 'uncommittedChanges' } });
    let reviewResolved = false;
    void pendingReview.then(() => { reviewResolved = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(reviewResolved).toBe(false);
    // The fixture emits the pending review's started/completed events before replying to thread/items/list.
    await f.session.request('history/read', { requestId: 'observe-review', sessionId: f.session.id });
    const reviewTurn = await pendingReview;
    expect(reviewTurn.id).toBe('actual-review');
    expect((await reviewTurn.result()).status).toBe('interrupted');
  } finally { await f.client.dispose(); }
});
