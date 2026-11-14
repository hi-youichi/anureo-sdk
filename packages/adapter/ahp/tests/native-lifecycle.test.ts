import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createClient } from '@anureo/sdk';
import { createAhpAdapter } from '../src';
const executable = resolve(import.meta.dir, './fixtures/fake-ahp-native.mjs');
test('external revised-v1 peer negotiates on the real wire and preserves overlapping execution identity', async () => {
  const client = await connectPeer('native');
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    const firstTurn = await session.submit({ input: 'first' });
    const joinedTurn = await session.submit({ input: 'join' });
    expect(firstTurn.id).toBe(joinedTurn.id);
    expect((await firstTurn.result()).text).toBe('peer result');
    expect((await joinedTurn.result()).text).toBe('peer result');
    expect(await session.close()).toMatchObject({ observationClosed: true });
  } finally { await client.dispose(); }
});
test('old v1 peer without the lifecycle marker is rejected during initialization', async () => {
  await expect(connectPeer('native', '--old-peer')).rejects.toThrow();
});
test('interrupted reason metadata survives the wire and privacy/result projection before the submit reply', async () => {
  const client = await connectPeer('reason', '--skip');
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    const turn = await session.submit({ input: 'skip' });
    expect(await turn.result()).toMatchObject({ status: 'interrupted', error: { code: 'USER_SKIPPED', outcomeUnknown: false, details: { workflowDisposition: 'skipped' } } });
    await session.close();
  } finally { await client.dispose(); }
});

/** Start a real stdio peer. createClient owns initialization-failure cleanup and tests dispose successful clients. */
function connectPeer(runtimeConfigId: string, mode?: '--old-peer' | '--skip') {
  return createClient({
    adapter: createAhpAdapter({
      command: process.execPath,
      args: mode ? [executable, mode] : [executable],
      timeoutMs: 1000,
    }),
    identity: { adapterId: 'ahp', runtimeConfigId },
  });
}
