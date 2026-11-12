import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createClient } from '@anureo/sdk';
import { createAcpAdapter } from '../src';
const executable = resolve(import.meta.dir, './fixtures/fake-acp.mjs');
test('official ACP transport preserves explicit native turn correlation and early result snapshots', async () => {
  const client = await createClient({ adapter: createAcpAdapter({ command: process.execPath, args: [executable, '--native-lifecycle'] }), identity: { adapterId: 'acp', runtimeConfigId: 'native' } });
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    const holdSubmission = session.submit({ input: 'hold' });
    const joinSubmission = session.submit({ input: 'join' });
    const [holdTurn, joinTurn] = await Promise.all([holdSubmission, joinSubmission]);
    expect(holdTurn.id).toBe('actual-acp');
    expect(joinTurn.id).toBe(holdTurn.id);
    expect((await holdTurn.result()).text).toBe('correlated ACP result');
    expect((await joinTurn.result()).text).toBe('correlated ACP result');
    expect(await session.close()).toMatchObject({ executionStopped: 'unconfirmed' });
  } finally { await client.dispose(); }
});
test('standard ACP keeps serial execution and session-scoped cancellation without claiming exact steer', async () => {
  const client = await createClient({ adapter: createAcpAdapter({ command: process.execPath, args: [executable] }), identity: { adapterId: 'acp', runtimeConfigId: 'standard' } });
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    expect(session.capabilities.input?.interrupt?.targets).toEqual(['session']);
    expect(session.capabilities.input?.steer).toBeUndefined();
    const turn = await session.submit({ input: 'conformance' });
    expect((await turn.result()).text).toBe('Hello conformance');
    await expect(turn.interrupt()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await session.close();
  } finally { await client.dispose(); }
});
