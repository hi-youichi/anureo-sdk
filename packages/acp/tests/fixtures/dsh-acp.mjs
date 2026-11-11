// DSH-shaped ACP fixture: standard ACP v1 surface only, no `_meta.ahp` extension.
// Mirrors what `dsh --profile acp` advertises on initialize so the adapter's
// capability mapping and policy paths can be tested without a model account.
import { createInterface } from 'node:readline';

const flag = (name) => process.argv.includes(name);
const value = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);

const permission = flag('--permission');
const stopReason = value('--stop', 'end_turn');
const failStartup = flag('--fail-startup');
const unsupportedNode = flag('--unsupported-node');

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });

const promptResponseIdsBySession = new Map();
let nextId = 0;
const pendingAgentRequestsById = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = `agent:${++nextId}`;
  pendingAgentRequestsById.set(id, { resolve, reject });
  send({ id, method, params });
});

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

/** Write both diagnostics before exiting so the pipe is not truncated. */
if (failStartup) {
  process.stderr.write('fatal: gated startup\ncredential sk-live-abcdef123456 rejected\n', () => process.exit(1));
}
if (unsupportedNode) {
  process.stderr.write('error: Node.js >= 24.9 is required\n', () => process.exit(1));
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => { void handle(JSON.parse(line)); });

async function handle(frame) {
  if (!frame.method && pendingAgentRequestsById.has(frame.id)) {
    const wait = pendingAgentRequestsById.get(frame.id);
    pendingAgentRequestsById.delete(frame.id);
    frame.error ? wait.reject(frame.error) : wait.resolve(frame.result);
    return;
  }
  const params = frame.params ?? {};
  const respond = (result) => { if ('id' in frame) send({ id: frame.id, result }); };

  if (frame.method === 'initialize') {
    respond({
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
  }
  if (frame.method === 'authenticate') { respond({}); return; }
  if (frame.method === 'session/new' || frame.method === 'session/resume') {
    respond({ sessionId: params.sessionId ?? `dsh-${++nextId}`, configOptions: createDefaultConfigOptions() });
    return;
  }
  if (frame.method === 'session/list') { respond({ sessions: [] }); return; }
  if (frame.method === 'session/close') { respond({}); return; }
  if (frame.method === 'session/set_config_option') {
    const responseConfigOptions = createDefaultConfigOptions();
    const option = responseConfigOptions.find((entry) => entry.id === params.configId);
    if (option) {
      const accepted = option.options.flatMap((entry) => entry.options ?? [entry]).map((entry) => entry.value);
      if (params.configId === 'model' && !accepted.includes(params.value)) {
        send({ id: frame.id, error: { code: -32602, message: `unknown model ${String(params.value)}` } });
        return;
      }
      option.currentValue = params.value;
    }
    respond({ configOptions: responseConfigOptions });
    return;
  }
  if (frame.method === 'session/cancel') {
    const promptId = promptResponseIdsBySession.get(params.sessionId);
    if (promptId !== undefined) {
      // Only send the prompt's cancellation result; the permission request and
      // the prompt handler awaiting it remain active.
      promptResponseIdsBySession.delete(params.sessionId);
      send({ id: promptId, result: { stopReason: 'cancelled' } });
    }
    return;
  }
  if (frame.method === 'session/prompt') {
    if (params.prompt.some((block) => block.type === 'resource_link')) {
      // DSH advertises embeddedContext: false, so a resource link is not a supported prompt block.
      send({ id: frame.id, error: { code: -32602, message: 'resource_link is not supported' } });
      return;
    }
    update(params.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'pong' } });
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
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: ` ${response.outcome.outcome}` } });
    }
    respond({ stopReason });
    return;
  }
  if (frame.method === 'session/set_mode') { send({ id: frame.id, error: { code: -32601, message: 'Method not found' } }); return; }
}
