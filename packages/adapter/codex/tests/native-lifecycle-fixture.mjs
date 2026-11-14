/** Scripts receipt and execution-evidence races over stdio for the Codex lifecycle tests. */
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let active = false;
let acceptedInputCount = 0;
let reviewAwaitingItemsList = false;
/** Emit a JSONL frame for fixture responders, returning stdout backpressure without waiting for a drain; serialization/write errors escape the process loop. */
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
/** Scope a scripted notification to the fixture thread and return send's write result; call order is wire order and write errors propagate. */
const event = (method, params) => send({ method, params: { threadId: 'thread', ...params } });
/** Publish final output before terminal evidence for a joining input, then clear active state. */
function completeJoinedTurn() {
  event('item/completed', { turnId: 'actual', item: { id: 'answer', type: 'agentMessage', text: 'native result', phase: 'final' } });
  event('turn/completed', { turn: { id: 'actual', status: 'completed' } });
  active = false;
}

/**
 * Accept the next input and emit its execution evidence before returning the RPC receipt.
 * Only the first accepted input in the process receives the actual ID as its receipt.
 */
function acceptInput({ params, text }) {
  if (!active) {
    active = true;
    event('turn/started', { turn: { id: 'actual' } });
  }
  acceptedInputCount++;
  event('item/completed', {
    turnId: 'actual',
    item: { id: `input-${acceptedInputCount}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input },
  });
  const result = { turn: { id: acceptedInputCount === 1 ? 'actual' : params.clientUserMessageId } };
  if (text === 'join') completeJoinedTurn();
  return result;
}

for await (const line of lines) {
  const frame = JSON.parse(line);
  const p = frame.params ?? {};
  if (frame.id === undefined) continue;
  let result = {};
  if (frame.method === 'account/read') result = { account: null, requiresOpenaiAuth: false };
  if (frame.method === 'thread/start') result = { thread: { id: 'thread' } };
  if (frame.method === 'review/start') {
    reviewAwaitingItemsList = true;
    result = { turn: { id: 'actual-review' } };
  }
  if (frame.method === 'thread/items/list') {
    // Defer review events until the next items list request, before its response.
    if (reviewAwaitingItemsList) {
      reviewAwaitingItemsList = false;
      event('turn/started', { turn: { id: 'actual-review' } });
      event('turn/completed', { turn: { id: 'actual-review', status: 'interrupted' } });
    }
    result = { data: [], nextCursor: null };
  }
  if (frame.method === 'turn/start') {
    const text = p.input[0].text;
    if (text === 'reject') {
      send({ id: frame.id, error: { code: -32602, message: 'native rejection' } });
      continue;
    }
    result = acceptInput({ params: p, text });
  }
  if (frame.method === 'turn/interrupt') {
    send({ id: frame.id, result: {} });
    event('turn/completed', { turn: { id: p.turnId, status: 'interrupted' } });
    continue;
  }
  send({ id: frame.id, result });
}
