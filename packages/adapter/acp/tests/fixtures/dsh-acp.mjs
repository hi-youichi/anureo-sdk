// DSH-shaped ACP fixture: standard ACP v1 surface only, no `_meta.ahp` extension.
// Mirrors what `dsh --profile acp` advertises on initialize so the adapter's
// capability mapping and policy paths can be tested without a model account.
import { createInterface } from 'node:readline';
import { createRequester } from './jsonrpc.mjs';

const flag = (name) => process.argv.includes(name);
/** Use the fallback only for an absent flag. A trailing flag has an undefined value. */
function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const permission = flag('--permission');
const stopReason = flagValue('--stop', 'end_turn');
const failStartup = flag('--fail-startup');
const unsupportedNode = flag('--unsupported-node');

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);

const promptResponseIdsBySession = new Map();
let nextId = 0;
const pendingAgentRequestsById = new Map();
const request = createRequester(send, pendingAgentRequestsById, () => ++nextId);

/** Give each open or configuration reply fresh options so one request's changes stay local. */
const createDefaultConfigOptions = () => [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select',
    currentValue: 'deepseek-official/deepseek-v4-flash',
    options: [{
      group: 'deepseek-official', name: 'deepseek-official',
      options: [{ value: 'deepseek-official/deepseek-v4-flash', name: 'deepseek-v4-flash' }],
    }],
  },
  {
    id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
    currentValue: 'provider-default',
    options: [{ value: 'provider-default', name: 'Provider default' }],
  },
];

// Wait for the stderr write before exiting so the startup test can read both lines.
if (failStartup) {
  process.stderr.write('fatal: gated startup\ncredential sk-live-abcdef123456 rejected\n', () => process.exit(1));
}
if (unsupportedNode) {
  process.stderr.write('error: Node.js >= 24.9 is required\n', () => process.exit(1));
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => { void handle(JSON.parse(line)); });

/**
 * Dispatch each parsed stdin frame. Replies release pending permission waits.
 * The line listener does not await prompt handling, so permission replies and cancels can arrive while it waits.
 */
async function handle(frame) {
  if (settleAgentReply(frame)) return;
  const params = frame.params ?? {};

  switch (frame.method) {
    case 'initialize':
      respond(frame, {
        protocolVersion: 1,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      });
      return;
    case 'authenticate':
    case 'session/close':
      respond(frame, {});
      return;
    case 'session/new':
    case 'session/resume':
      respond(frame, { sessionId: params.sessionId ?? `dsh-${++nextId}`, configOptions: createDefaultConfigOptions() });
      return;
    case 'session/list':
      respond(frame, { sessions: [] });
      return;
    case 'session/set_config_option':
      setConfigOption(frame, params);
      return;
    case 'session/cancel':
      cancelPrompt(params.sessionId);
      return;
    case 'session/prompt':
      await prompt(frame, params);
      return;
    case 'session/set_mode':
      send({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
      return;
  }
}

/** Consume an agent-request reply by removing its slot and settling the matching createRequester promise. */
function settleAgentReply(frame) {
  if (frame.method) return false;
  const wait = pendingAgentRequestsById.get(frame.id);
  if (wait === undefined) return false;
  pendingAgentRequestsById.delete(frame.id);
  if (frame.error) wait.reject(frame.error);
  else wait.resolve(frame.result);
  return true;
}

/** Write a successful reply only to a frame that supplied an ID. */
function respond(frame, result) {
  if ('id' in frame) send({ id: frame.id, result });
}

/** Echo a fresh configuration snapshot, rejecting a model outside the advertised values. */
function setConfigOption(frame, { configId, value }) {
  const configOptions = createDefaultConfigOptions();
  const option = configOptions.find((entry) => entry.id === configId);
  if (option) {
    const choices = option.options.flatMap((entry) => entry.options ?? [entry]);
    if (configId === 'model' && !choices.some((entry) => entry.value === value)) {
      send({ id: frame.id, error: { code: -32602, message: `unknown model ${String(value)}` } });
      return;
    }
    option.currentValue = value;
  }
  respond(frame, { configOptions });
}

/** Send a cancelled result for the held prompt. The pending permission request can still settle later. */
function cancelPrompt(sessionId) {
  const promptId = promptResponseIdsBySession.get(sessionId);
  if (promptId === undefined) return;
  promptResponseIdsBySession.delete(sessionId);
  send({ id: promptId, result: { stopReason: 'cancelled' } });
}

/**
 * Emit the scripted answer and stop reason, or send invalid params for an unadvertised resource
 * link. With --permission, wait for the host's reply before emitting the outcome and stop reason.
 * A permission reply error rejects this handler.
 */
async function prompt(frame, params) {
  if (params.prompt.some((block) => block.type === 'resource_link')) {
    send({ id: frame.id, error: { code: -32602, message: 'resource_link is not supported' } });
    return;
  }
  answerChunk(params.sessionId, 'pong');
  if (permission) {
    promptResponseIdsBySession.set(params.sessionId, frame.id);
    const response = await request('session/request_permission', {
      sessionId: params.sessionId,
      toolCall: { toolCallId: 'call-1', title: 'Run tests', kind: 'execute', rawInput: { command: 'bun test' } },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    promptResponseIdsBySession.delete(params.sessionId);
    answerChunk(params.sessionId, ` ${response.outcome.outcome}`);
  }
  respond(frame, { stopReason });
}

/** Use the same message ID so the permission outcome appends to the prompt's answer. */
function answerChunk(sessionId, text) {
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text } },
    },
  });
}
