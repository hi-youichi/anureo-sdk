import { expect, test } from 'bun:test';
import { AHP_PROTOCOL_VERSION, AHP_PROTOCOL_CONTRACT, isAhpMethod, negotiateVersion, validateEvent, validateDefinition, validateRequest, validateResult } from '../src';

const input = { requestId: 'r', sessionId: 's', submissionId: 'input', delivery: 'native', input: [{ type: 'text', text: 'x' }] };
test('revised v1 requires the lifecycle discriminator in both handshake directions', () => {
  expect(AHP_PROTOCOL_VERSION).toBe(1); expect(negotiateVersion([2, 1])).toBe(1);
  expect(() => negotiateVersion([2])).toThrow();
  const params = { protocolVersions: [1], clientInfo: { name: 'host', version: '1' } };
  const result = { protocolVersion: 1, runtime: { name: 'peer', version: '1', adapter: 'test' }, capabilities: {} };
  expect(validateRequest('initialize', params)).toBe(false);
  expect(validateResult('initialize', result)).toBe(false);
  expect(validateRequest('initialize', { ...params, protocolContract: AHP_PROTOCOL_CONTRACT })).toBe(true);
  expect(validateResult('initialize', { ...result, protocolContract: AHP_PROTOCOL_CONTRACT })).toBe(true);
  expect(validateRequest('initialize', { ...params, protocolContract: 'old' })).toBe(false);
  expect(validateResult('initialize', { ...result, protocolContract: 'old' })).toBe(false);
});
test('input submission does not allocate an execution', () => {
  expect(isAhpMethod('turn/start')).toBe(false);
  expect(validateRequest('input/submit', input)).toBe(true);
  expect(validateRequest('input/submit', { ...input, turnId: 'fake-execution' })).toBe(false);
});
test('session/close rejects a result containing only closed: true', () => {
  expect(validateResult('session/close', { closed: true })).toBe(false);
});
test.each([
  {
    name: 'dispatched without accepted or an execution identifier',
    result: { submissionId: 'input', disposition: 'dispatched' },
    expected: true,
  },
  {
    name: 'queued with a native receipt',
    result: { accepted: true, submissionId: 'input', disposition: 'queued', receipt: { nativeId: 'q' } },
    expected: true,
  },
  {
    name: 'queued without a receipt',
    result: { accepted: true, submissionId: 'input', disposition: 'queued' },
    expected: false,
  },
  {
    name: 'started without an execution identifier',
    result: { accepted: true, submissionId: 'input', disposition: 'started' },
    expected: false,
  },
  {
    name: 'joined with an execution identifier',
    result: { accepted: true, submissionId: 'input', disposition: 'joined', turnId: 'actual' },
    expected: true,
  },
])('input/submit result: $name', ({ result, expected }) => {
  expect(validateResult('input/submit', result)).toBe(expected);
});
test('submission notifications retain complete source envelopes and scoped items require executions', () => {
  const source = { sessionId: 's', streamId: 'stream', seq: 1, timestamp: new Date().toISOString() };
  for (const payload of [
    { type: 'submission/bound', payload: { submissionId: 'input', turnId: 'actual' } },
    { type: 'submission/status', payload: { submissionId: 'input', status: 'dispatched' } },
  ]) {
    const event = { ...source, ...payload };
    expect(validateEvent(event)).toBe(true);
    expect(validateDefinition('AhpRpcMessage', { jsonrpc: '2.0', method: payload.type, params: event })).toBe(true);
  }
  const item = { ...source, type: 'item/completed', payload: { item: { id: 'item', type: 'agentMessage', text: 'native' } } };
  expect(validateEvent(item)).toBe(false); expect(validateEvent({ ...item, turnId: 'actual' })).toBe(true);
});
