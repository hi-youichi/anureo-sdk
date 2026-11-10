import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
let binding, seq = 0, active = false;
const capabilities = { input: { delivery: ['native'], interrupt: { targets: ['session'], reportsPendingInputs: false } } };
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const event = (type, payload) => send({ method: type, params: { sessionId: binding.sessionId, streamId: 'native-source', seq: ++seq, timestamp: new Date().toISOString(), ...(type.startsWith('item/') ? { turnId: 'actual-ahp' } : {}), type, payload } });
for await (const line of input) {
  const frame = JSON.parse(line), p = frame.params ?? {};
  if (frame.id === undefined) continue;
  let result = {};
  if (frame.method === 'initialize') result = { protocolVersion: 1, ...(process.argv.includes('--old-peer') ? {} : { protocolContract: 'native-lifecycle' }), runtime: { name: 'native-peer', version: '1', adapter: 'fixture' }, capabilities };
  if (frame.method === 'session/open') { binding = p.binding; result = { binding, streamId: 'native-source', capabilities, state: { binding, status: 'ready', activeTurnIds: [], config: {}, capabilities, capabilityRevision: 1 } }; }
  if (frame.method === 'input/submit') {
    const joined = active; if (!active) { active = true; event('turn/started', { turnId: 'actual-ahp' }); }
    event('submission/bound', { submissionId: p.submissionId, turnId: 'actual-ahp' });
    result = { accepted: true, submissionId: p.submissionId, disposition: joined ? 'joined' : 'started', turnId: 'actual-ahp' };
    if (joined) { event('item/completed', { item: { id: 'result', type: 'agentMessage', phase: 'final', text: 'peer result' } }); event('turn/completed', { turnId: 'actual-ahp', status: 'completed' }); }
  }
  if (frame.method === 'session/close') result = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' };
  send({ id: frame.id, result });
}
