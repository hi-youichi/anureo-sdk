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
  const wire = new AhpWire({
    messages: incoming,
    send: async () => {},
    close: async () => {
      closed++;
      incoming.end();
      throw new Error('private transport failure');
    },
  });
  wire.onClose = async () => {
    notified++;
    throw new Error('private close handler failure');
  };
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
  const closeHandler = Promise.withResolvers<void>();
  const wire = new AhpWire({ messages: incoming, send: async () => {}, close: async () => { closed++; incoming.end(); } });
  wire.onClose = () => {
    closeHandler.resolve();
    throw new Error('private callback failure');
  };
  incoming.push('invalid json');
  await closeHandler.promise;
  await expect(wire.close()).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_FAILED', details: { errors: [{ code: 'AHP_CLOSE_HANDLER_FAILED' }] } });
  expect(closed).toBe(1);
});

test('notification callbacks can await RPC replies without allowing later callbacks to overtake', async () => {
  const incoming = new BoundedEventQueue<string>();
  const outgoing = new BoundedEventQueue<string>();
  const wire = new AhpWire({
    messages: incoming,
    send: async frame => { outgoing.push(frame); },
    close: async () => { incoming.end(); outgoing.end(); },
  }, { timeoutMs: 1000 });
  const reader = outgoing[Symbol.asyncIterator]();
  const observed: string[] = [];
  const delivered = Promise.withResolvers<void>();
  wire.onNotification = async method => {
    observed.push(method);
    if (method === 'first') {
      observed.push(String(await wire.request('replay', {})));
    } else {
      delivered.resolve();
    }
  };
  try {
    incoming.push(JSON.stringify({ jsonrpc: '2.0', method: 'first' }));
    incoming.push(JSON.stringify({ jsonrpc: '2.0', method: 'second' }));
    const sent = await reader.next();
    if (sent.done) throw new Error('Missing replay request');
    const request = JSON.parse(sent.value) as { id: number; method: string };
    expect(request.method).toBe('replay');
    expect(observed).toEqual(['first']);
    incoming.push(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'replayed' }));
    await delivered.promise;
    expect(observed).toEqual(['first', 'replayed', 'second']);
  } finally {
    await reader.return?.();
    await wire.close();
  }
});

test('peer requests and unmatched replies do not disturb correlated response failures', async () => {
  const incoming = new BoundedEventQueue<string>();
  const sent: Array<Record<string, unknown>> = [];
  const wire = new AhpWire({
    messages: incoming,
    send: async frame => { sent.push(JSON.parse(frame) as Record<string, unknown>); },
    close: async () => { incoming.end(); },
  }, { timeoutMs: 1000 });
  try {
    const first = wire.request('first', {});
    const malformed = wire.request('malformed', {}).catch(cause => cause as unknown);
    const unsupported = wire.request('unsupported', {}).catch(cause => cause as unknown);
    const [firstFrame, malformedFrame, unsupportedFrame] = sent;
    if (!firstFrame || !malformedFrame || !unsupportedFrame) throw new Error('Missing outgoing requests');
    incoming.push(JSON.stringify({ jsonrpc: '2.0', id: 'peer-request', method: 'peer/call' }));
    incoming.push(JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'unmatched' }));
    incoming.push(JSON.stringify({ jsonrpc: '2.0', id: String(firstFrame.id), result: 'wrong ID type' }));
    incoming.push(JSON.stringify({ jsonrpc: '2.0', id: unsupportedFrame.id, error: { code: -32601, message: 'private peer error' } }));
    incoming.push(JSON.stringify({ jsonrpc: '2.0', id: malformedFrame.id }));
    incoming.push(JSON.stringify({ jsonrpc: '2.0', id: firstFrame.id, result: null }));
    expect(await first).toBeNull();
    expect(await malformed).toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(await unsupported).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', message: 'AHP_RPC_ERROR' });
    expect(sent[3]).toEqual({ jsonrpc: '2.0', id: 'peer-request', error: { code: -32601, message: 'Method not found' } });
    // A malformed correlated response fails its request rather than the whole connection.
    const next = wire.request('next', {});
    const nextFrame = sent[4];
    if (!nextFrame) throw new Error('Missing follow-up request');
    incoming.push(JSON.stringify({ jsonrpc: '2.0', id: nextFrame.id, result: 'still open' }));
    expect(await next).toBe('still open');
  } finally {
    await wire.close();
  }
});
