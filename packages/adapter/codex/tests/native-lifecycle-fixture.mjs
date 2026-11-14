/** Scripts receipt and execution-evidence races over stdio for the Codex lifecycle tests. */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
const log = process.env.FAKE_LOG_FILE;
const mode = process.argv[2] ?? process.env.FAKE_SCENARIO;
let active = false;
let acceptedInputCount = 0;
let reviewAwaitingItemsList = false;
let inputAwaitingItemsList;
let pendingRead;
let pendingHistoryPage;
let reverted = false;
let historyPageCount = 0;
let turnPageCount = 0;
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
  if (text === 'reasoning first') {
    const item = { id: 'reasoning', type: 'reasoning', summary: ['summary'], content: [] };
    event('item/reasoning/summaryTextDelta', { turnId: 'actual', itemId: item.id, delta: 'summary' });
    event('item/started', { turnId: 'actual', item });
    event('item/completed', { turnId: 'actual', item });
    completeJoinedTurn();
  }
  if (text === 'join') completeJoinedTurn();
  return result;
}

for await (const line of lines) {
  if (log) appendFileSync(log, line + '\n');
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
    if (inputAwaitingItemsList) {
      acceptInput({ params: inputAwaitingItemsList, text: 'join' });
      inputAwaitingItemsList = undefined;
    }
    result = { data: [], nextCursor: null };
    if (mode === 'cursor-cycle' && ++historyPageCount <= 2) {
      result.nextCursor = 'repeat';
    }
    if (mode === 'history-overlaps-revert' && !reverted) {
      if (!p.cursor) {
        result = {
          data: [{ turnId: 'actual', item: { id: 'old', type: 'agentMessage', text: 'removed' } }],
          nextCursor: 'page-two',
        };
      } else {
        pendingHistoryPage = frame;
        event('fixture/history-page-pending', {});
        continue;
      }
    }
  }
  if (frame.method === 'thread/turns/list') {
    if (mode === 'cursor-cycle') result = { data: [], nextCursor: ++turnPageCount <= 2 ? 'repeat' : null };
    if (mode === 'turns-paged') {
      result = p.cursor
        ? { data: [{ id: 'next-turn' }], nextCursor: null }
        : { data: [{ id: 'actual' }], nextCursor: 'page-two' };
    }
  }
  if (frame.method === 'thread/read' && mode === 'rollback-overlap') {
    pendingRead = frame;
    event('fixture/turn-read-pending', {});
    continue;
  }
  if (frame.method === 'thread/read' && mode === 'revert-read-timeout') continue;
  if (frame.method === 'thread/compact/start') {
    if (pendingRead) {
      send({ id: pendingRead.id, result: { thread: { turns: [{ id: 'actual' }, { id: 'next-turn' }] } } });
      pendingRead = undefined;
    }
    if (pendingHistoryPage && reverted) {
      send({ id: pendingHistoryPage.id, result: { data: [], nextCursor: null } });
      pendingHistoryPage = undefined;
    }
  }
  if (frame.method === 'thread/revert' || frame.method === 'thread/rollback') {
    reverted = true;
    result = { thread: { id: 'thread' } };
  }
  if (frame.method === 'turn/start') {
    const text = p.input[0].text;
    if (text === 'reject') {
      send({ id: frame.id, error: { code: -32602, message: 'native rejection' } });
      continue;
    }
    if (text === 'malformed receipt') {
      inputAwaitingItemsList = p;
      result = null;
    } else {
      result = acceptInput({ params: p, text });
      if (mode === 'interaction-capacity') {
        for (const id of ['held', 'overflow']) {
          send({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'actual', itemId: id, command: 'echo test' } });
        }
      }
    }
  }
  if (frame.id === 'overflow' && !frame.method) {
    // Only the transport fallback has this error code and message.
    if (frame.error?.code === -32603 && frame.error.message === 'Interaction unavailable') completeJoinedTurn();
    continue;
  }
  if (frame.method === 'turn/interrupt') {
    send({ id: frame.id, result: {} });
    event('turn/completed', { turn: { id: p.turnId, status: 'interrupted' } });
    continue;
  }
  send({ id: frame.id, result });
}
