/** Scripted native-lifecycle peer for real-stdio tests, including old-contract and early-terminal modes. */
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
let binding, seq = 0, hasStartedTurn = false;
const capabilities = { input: { delivery: ['native'], interrupt: { targets: ['session'], reportsPendingInputs: false } } };
/** Write one newline-delimited RPC frame; stdout is reserved for protocol traffic. */
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
/** Publish with the fixture stream sequence; item events belong to its fixed native execution. */
const event = (type, payload) => {
  const params = {
    sessionId: binding.sessionId,
    streamId: 'native-source',
    seq: ++seq,
    timestamp: new Date().toISOString(),
    ...(type.startsWith('item/') ? { turnId: 'actual-ahp' } : {}),
    type,
    payload,
  };
  return send({ method: type, params });
};
for await (const line of input) {
  const frame = JSON.parse(line), p = frame.params ?? {};
  if (frame.id === undefined) continue;
  let result = {};
  if (frame.method === 'initialize') result = { protocolVersion: 1, ...(process.argv.includes('--old-peer') ? {} : { protocolContract: 'native-lifecycle' }), runtime: { name: 'native-peer', version: '1', adapter: 'fixture' }, capabilities };
  if (frame.method === 'session/open') { binding = p.binding; result = { binding, streamId: 'native-source', capabilities, state: { binding, status: 'ready', activeTurnIds: [], config: {}, capabilities, capabilityRevision: 1 } }; }
  if (frame.method === 'input/submit') {
    const joined = hasStartedTurn;
    if (!hasStartedTurn) {
      // Keep this flag after completion so later submissions still join the fixture's turn.
      hasStartedTurn = true;
      event('turn/started', { turnId: 'actual-ahp' });
    }
    event('submission/bound', { submissionId: p.submissionId, turnId: 'actual-ahp' });
    result = { accepted: true, submissionId: p.submissionId, disposition: joined ? 'joined' : 'started', turnId: 'actual-ahp' };
    if (process.argv.includes('--skip')) event('turn/completed', { turnId: 'actual-ahp', status: 'interrupted', error: { code: 'USER_SKIPPED', message: 'skipped', retryable: false, outcomeUnknown: false, details: { workflowDisposition: 'skipped' } } });
    if (joined) { event('item/completed', { item: { id: 'result', type: 'agentMessage', phase: 'final', text: 'peer result' } }); event('turn/completed', { turnId: 'actual-ahp', status: 'completed' }); }
  }
  if (frame.method === 'session/close') result = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' };
  send({ id: frame.id, result });
}
