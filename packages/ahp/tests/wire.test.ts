import { expect, test } from 'bun:test';
import { BoundedEventQueue } from '@anureo/sdk';
import { AhpWire } from '../src/wire';

test('throwing diagnostics cannot prevent AHP transport cleanup', async () => {
  const incoming = new BoundedEventQueue<string>();
  let closed = 0, notified = 0;
  const wire = new AhpWire({ messages: incoming, send: async () => {}, close: async () => { closed++; incoming.end(); } }, {
    diagnostic: () => { throw new Error('private diagnostic failure'); },
  });
  wire.onClose = () => { notified++; };
  await Promise.all([wire.close(), wire.close()]);
  await wire.close();
  expect([closed, notified]).toEqual([1, 1]);
});

test('concurrent AHP closes share cleanup and retain both release failures', async () => {
  const incoming = new BoundedEventQueue<string>();
  let closed = 0, notified = 0;
  const wire = new AhpWire({ messages: incoming, send: async () => {}, close: async () => { closed++; incoming.end(); throw new Error('private transport failure'); } });
  wire.onClose = async () => { notified++; throw new Error('private close handler failure'); };
  const pending = wire.request('test', {});
  const rejected = pending.catch(cause => cause as unknown);
  const first = wire.close(), second = wire.close();
  expect(first).toBe(second);
  const expected = { code: 'RESOURCE_RELEASE_FAILED', details: { errors: [{ code: 'AHP_CLOSE_HANDLER_FAILED' }, { code: 'AHP_TRANSPORT_CLOSE_FAILED' }] } };
  await expect(first).rejects.toMatchObject(expected);
  await expect(second).rejects.toMatchObject(expected);
  await expect(wire.close()).rejects.toMatchObject(expected);
  expect(await rejected).toMatchObject({ code: 'RPC_CONNECTION_CLOSED', outcomeUnknown: true });
  expect([closed, notified]).toEqual([1, 1]);
});

test('a background protocol failure still cleans up and exposes release errors on close', async () => {
  const incoming = new BoundedEventQueue<string>();
  let closed = 0;
  let notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  const wire = new AhpWire({ messages: incoming, send: async () => {}, close: async () => { closed++; incoming.end(); } });
  wire.onClose = () => { notify(); throw new Error('private callback failure'); };
  incoming.push('invalid json');
  await notified;
  await expect(wire.close()).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_FAILED', details: { errors: [{ code: 'AHP_CLOSE_HANDLER_FAILED' }] } });
  expect(closed).toBe(1);
});
