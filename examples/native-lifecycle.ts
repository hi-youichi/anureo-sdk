import { createClient, type HarnessAdapter } from '@anureo/sdk';
import { AHP_PROTOCOL_CONTRACT, type AhpRequestMap, type AhpResultMap } from '@anureo/protocol';

// Scripted native facts: submit starts work; steer finishes that same execution.
// Real adapters obtain these facts from their backend, not from host requests.
const capabilities = {
  input: { delivery: ['native' as const], steer: { target: 'turn' as const, atomicMatch: true as const } },
};
const adapter: HarnessAdapter = {
  async initialize() {
    return {
      protocolVersion: 1,
      protocolContract: AHP_PROTOCOL_CONTRACT,
      runtime: { name: 'example', version: '1', adapter: 'scripted' },
      capabilities,
    };
  },
  async openSession(params, sink) {
    const turnId = 'actual-native-execution';
    let active = false;
    return {
      binding: params.binding,
      capabilities,
      async execute(method, value) {
        if (method === 'session/close') {
          return { closed: true, observationClosed: true, executionStopped: 'unconfirmed' } as AhpResultMap[typeof method];
        }
        if (method === 'input/submit') {
          const submitted = value as AhpRequestMap['input/submit'];
          active = true;
          await sink.emit({ type: 'turn/started', payload: { turnId } });
          await sink.bindSubmission(submitted.submissionId, turnId);
          // No independent native acceptance receipt is needed to return a Turn.
          return { submissionId: submitted.submissionId, disposition: 'dispatched' } as AhpResultMap[typeof method];
        }
        if (method === 'turn/steer') {
          const steered = value as AhpRequestMap['turn/steer'];
          if (!active || steered.expectedTurnId !== turnId) throw new Error('Stale execution target');
          await sink.emit({
            type: 'item/completed',
            payload: { item: { id: 'answer', type: 'agentMessage', phase: 'final', text: 'Steered the same execution' } },
          }, { turnId });
          active = false;
          await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } });
          return { submissionId: steered.submissionId, turnId, accepted: true } as AhpResultMap[typeof method];
        }
        throw new Error(`Unsupported example operation: ${method}`);
      },
      async dispose() {},
    };
  },
  async dispose() {},
};

const client = await createClient({ adapter, identity: { adapterId: 'example', runtimeConfigId: 'local' } });
try {
  const session = await client.sessions.create({ cwd: process.cwd() });
  const turn = await session.submit({ input: 'Investigate the login tests.', delivery: 'native' });
  await turn.steer({ input: 'Keep the fix inside the authentication module.' });
  const result = await turn.result();
  console.log(`Execution: ${turn.id}`);
  console.log(`${result.status}: ${result.text}`);
  console.log(`Execution stopped: ${(await session.close()).executionStopped}`);
} finally {
  await client.dispose();
}
