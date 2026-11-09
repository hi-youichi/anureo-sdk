import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@anureo/sdk';
import { validateRequest } from '@anureo/protocol';
import { runNativeConformance } from '@anureo/conformance';

if (!validateRequest('input/submit', { sessionId: 's', requestId: 'r', submissionId: 'input', delivery: 'native', input: [{ type: 'text', text: 'x' }] })) throw new Error('native schema export');
if (typeof runNativeConformance !== 'function') throw new Error('native conformance export');
const root = await mkdtemp(join(tmpdir(), 'anureo-native-packed-'));
const file = name => fileURLToPath(new URL(name, import.meta.url));
const verified = [];
try {
  for (const backend of process.argv.slice(2)) {
    const module = await import(`@anureo/adapter-${backend}`);
    const create = module[`create${backend[0].toUpperCase()}${backend.slice(1)}Adapter`];
    const options = backend === 'claude'
      ? { command: file('fake-claude.mjs'), executableRuntime: 'node', stateDir: join(root, 'claude') }
      : { command: process.execPath, args: [file(backend === 'codex' ? 'fake-codex-native.mjs' : backend === 'acp' ? 'fake-acp.mjs' : 'fake-ahp-native.mjs'), ...(backend === 'acp' ? ['--native-lifecycle'] : [])], ...(backend === 'codex' ? { version: '0.164.0' } : {}), timeoutMs: 3000 };
    const client = await createClient({ adapter: create(options), identity: { adapterId: backend, runtimeConfigId: 'packed-native' } });
    try {
      const session = await client.sessions.create({ cwd: root });
      const first = session.submit({ input: 'first' }, { timeoutMs: 3000 }), second = session.submit({ input: 'join' }, { timeoutMs: 3000 });
      const [one, two] = await Promise.all([first, second]);
      const results = await Promise.all([one.result({ timeoutMs: 3000 }), two.result({ timeoutMs: 3000 })]);
      if (results.some(result => result.status !== 'completed')) throw new Error(`${backend}: native terminal`);
      if (backend !== 'claude' && one.id !== two.id) throw new Error(`${backend}: native association`);
      const closed = await session.close();
      if (!closed.observationClosed || closed.executionStopped !== 'unconfirmed') throw new Error(`${backend}: native close`);
      verified.push(backend);
    } finally { await client.dispose(); }
  }
  console.log(JSON.stringify({ version: 1, contract: 'native-lifecycle', adapters: verified, result: 'passed' }));
} finally { await rm(root, { recursive: true, force: true }); }
