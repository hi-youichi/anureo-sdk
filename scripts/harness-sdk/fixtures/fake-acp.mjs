// Vanilla ACP JSON-RPC wire fixture. No Anureo runtime, SDK patches or credentials.
import { createInterface } from 'node:readline';
const extensions = process.argv.includes('--extensions');
const badVersion = process.argv.includes('--bad-version');
const noResume = process.argv.includes('--load-only');
const missingSteer = process.argv.includes('--missing-steer');
const invalidExtension = process.argv.includes('--bad-extension');
const authRequired = process.argv.includes('--auth-required');
const scenario = process.argv[process.argv.indexOf('--scenario') + 1] && process.argv.includes('--scenario') ? process.argv[process.argv.indexOf('--scenario') + 1] : undefined;
const pending = new Map(); const prompts = new Map(); const sessions = new Map(); const configs = new Map(); let nextId = 0; let clientCapabilities = {};
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const request = (method, params) => new Promise((resolve, reject) => { const id = `agent:${++nextId}`; pending.set(id, { resolve, reject }); send({ id, method, params }); });
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const config = () => ({ modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' }] }, configOptions: [{ id: 'model-id', category: 'model', name: 'Model', type: 'select', currentValue: 'fake-model', options: [{ value: 'fake-model', name: 'Fake' }, { value: 'second-model', name: 'Second' }] }, { id: 'enabled', name: 'Enabled', type: 'boolean', currentValue: false }] });
const configFor = (id) => { if (!configs.has(id)) configs.set(id, config()); return configs.get(id); };
async function handle(frame) {
  if (!frame.method && pending.has(frame.id)) { const wait = pending.get(frame.id); pending.delete(frame.id); frame.error ? wait.reject(frame.error) : wait.resolve(frame.result); return; }
  const p = frame.params ?? {}; const respond = (result) => { if ('id' in frame) send({ id: frame.id, result }); };
  if (frame.method === 'initialize') {
    clientCapabilities = p.clientCapabilities ?? {};
    respond({ protocolVersion: badVersion ? 99 : 1, agentInfo: { name: 'vanilla-fake-acp', version: '1.0.0' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true }, sessionCapabilities: { ...(noResume ? {} : { resume: {} }), close: {} } }, ...(extensions ? { _meta: { ahp: { version: invalidExtension ? 2 : 1, methods: { fork: '_ahp/session/fork', revert: '_ahp/session/revert', steer: missingSteer ? '_ahp/missing/steer' : '_ahp/turn/steer', history: '_ahp/history/read', goalSet: '_ahp/goal/set', goalClear: '_ahp/goal/clear', compact: '_ahp/compact/start', review: '_ahp/review/start' }, fork: ['before', 'through'], revert: ['conversation', 'files', 'both'], subagents: true, clientRequests: { userInput: '_ahp/user_input', dynamicTool: '_ahp/dynamic_tool' } } } } : {}) }); return;
  }
  if (frame.method === 'session/new') { if (authRequired) { send({ id: frame.id, error: { code: -32000, message: 'Authentication required' } }); return; } const id = `native-${++nextId}`; sessions.set(id, []); respond({ sessionId: id, ...configFor(id) }); return; }
  if (frame.method === 'session/resume' || frame.method === 'session/load') {
    if (scenario === 'titles') {
      update(p.sessionId, { sessionUpdate: 'session_info_update', title: `Restored via ${frame.method}` });
      update(p.sessionId, { sessionUpdate: 'session_info_update', updatedAt: '2026-10-28T00:00:00Z' });
    }
    if (frame.method === 'session/load') update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'history-message', content: { type: 'text', text: 'loaded snapshot' } }); respond(configFor(p.sessionId)); return; }
  if (frame.method === 'session/close') { respond({}); return; }
  if (frame.method === 'session/set_mode') { configFor(p.sessionId).modes.currentModeId = p.modeId; update(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: p.modeId }); respond({}); return; }
  if (frame.method === 'session/set_config_option') { const data = configFor(p.sessionId); const option = data.configOptions.find((option) => option.id === p.configId); if (option) option.currentValue = p.value; respond({ configOptions: data.configOptions }); return; }
  if (frame.method === 'session/cancel') { const promptId = prompts.get(p.sessionId); if (promptId !== undefined) { send({ id: promptId, result: { stopReason: 'cancelled' } }); prompts.delete(p.sessionId); } return; }
  if (frame.method === 'session/prompt') {
    let command = p.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('');
    if (scenario) command = { approval: 'permission', userInput: 'userInput', dynamicTool: 'dynamicTool', elicitation: 'elicitation', interrupt: 'wait', steer: 'wait', disconnect: 'disconnect' }[scenario] ?? command;
    if (scenario === 'backpressure') { update(p.sessionId, { sessionUpdate: 'future_update', content: 'x'.repeat(4096) }); respond({ stopReason: 'end_turn' }); return; }
    if (command === 'disconnect') { process.exit(1); }
    if (command === 'wait') { prompts.set(p.sessionId, frame.id); return; }
    if (command === 'capabilities') {
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(clientCapabilities) } });
    } else if (command === 'permission') {
      const response = await request('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId: 'tool', title: 'Execute' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: response.outcome.outcome } });
    } else if (command === 'elicitation' || command === 'elicitation-url') {
      const response = await request('elicitation/create', command === 'elicitation' ? { sessionId: p.sessionId, mode: 'form', message: 'Name', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } : { sessionId: p.sessionId, mode: 'url', message: 'Authorize', url: 'https://auth.example.test/login?token=private-token', elicitationId: 'authorization-id' });
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: response.action } });
      if (command === 'elicitation-url') send({ method: 'elicitation/complete', params: { elicitationId: 'authorization-id' } });
    } else if (command === 'userInput' || command === 'dynamicTool') {
      await request(command === 'userInput' ? '_ahp/user_input' : '_ahp/dynamic_tool', { sessionId: p.sessionId, request: command === 'userInput' ? { questions: [{ id: 'q', prompt: 'Answer' }] } : { toolName: 'external', arguments: {} } });
    } else if (command === 'fs') {
      await request('fs/read_text_file', { sessionId: p.sessionId, path: '/injected-file' });
      await request('fs/write_text_file', { sessionId: p.sessionId, path: '/injected-file', content: 'write' });
    } else if (command === 'terminal') {
      const terminal = await request('terminal/create', { sessionId: p.sessionId, command: 'injected-command', args: [] });
      for (const method of ['terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release']) await request(method, { sessionId: p.sessionId, terminalId: terminal.terminalId });
    } else if (command === 'unknown-request') {
      try { await request('_future/unknown', { sessionId: p.sessionId }); throw Error('Unexpected approval'); } catch (error) { if (error.code !== -32601) throw error; }
    } else {
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'reused', content: { type: 'text', text: 'Hello ' } });
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'reused', content: { type: 'text', text: command } });
      update(p.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'summary' } });
      update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'input' } });
      update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Display only', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls', token: 'redact-me' } });
      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'done' });
      update(p.sessionId, { sessionUpdate: 'plan', entries: [{ content: 'one', priority: 'high', status: 'in_progress' }] });
      update(p.sessionId, { sessionUpdate: 'usage_update', used: 5, size: 100 });
      update(p.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'c', status: 'in_progress' });
      update(p.sessionId, { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c', content: { type: 'text', text: 'summary' } });
      update(p.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'c', status: 'completed', summary: [{ type: 'text', text: 'full summary' }] });
      update(p.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] });
      update(p.sessionId, { sessionUpdate: 'session_info_update', title: 'Title' });
      update(p.sessionId, { sessionUpdate: 'plan_update', plan: { planId: 'p', type: 'content', content: 'native plan' } });
      update(p.sessionId, { sessionUpdate: 'plan_removed', planId: 'p' });
      update(p.sessionId, { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Child', task: 'Task' });
      update(p.sessionId, { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' });
      update(p.sessionId, { sessionUpdate: 'future_update', safe: 'retained', token: 'redact-me' });
      if (scenario === 'unknown-item') update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'future-tool', title: 'Future', kind: 'future_kind', status: 'completed', rawInput: { safe: true } });
      const nativeTurnId = p._meta?.ahp?.turnId ?? `native-turn-${++nextId}`;
      sessions.get(p.sessionId)?.push({ turnId: nativeTurnId, item: { id: 'agent_message_chunk:reused', type: 'agentMessage', text: `Hello ${command}`, phase: 'final' } });
    }
    respond({ stopReason: 'end_turn' }); return;
  }
  if (extensions && frame.method.startsWith('_ahp/')) {
    if (frame.method === '_ahp/session/fork') { const sessionId = `fork-${++nextId}`; const source = sessions.get(p.sessionId) ?? []; const at = source.findIndex((item) => item.turnId === p.boundary.turnId); sessions.set(sessionId, source.slice(0, at < 0 ? 0 : p.boundary.relation === 'before' ? at : at + 1)); respond({ sessionId, ...config() }); return; }
    if (frame.method === '_ahp/turn/steer') { respond({ turnId: p.expectedTurnId, accepted: true }); return; }
    if (frame.method === '_ahp/session/revert') { const source = sessions.get(p.sessionId) ?? []; const at = source.findIndex((item) => item.turnId === p.boundary.turnId); if (at >= 0 && p.scope !== 'files') source.splice(p.boundary.relation === 'before' ? at : at + 1); respond({ appliedScope: p.scope, boundary: p.boundary }); return; }
    if (frame.method === '_ahp/history/read') { respond({ items: sessions.get(p.sessionId) ?? [], snapshotToken: 'native-snapshot', source: { provider: 'acp', value: p.sessionId } }); return; }
    if (frame.method === '_ahp/goal/set') { respond({ goal: p.goal, status: 'active' }); return; }
    if (frame.method === '_ahp/goal/clear') { respond({ goal: null, status: 'cleared' }); return; }
    if (frame.method === '_ahp/compact/start') { respond({ maintenanceId: 'compact', status: 'completed' }); return; }
    if (frame.method === '_ahp/review/start') { send({ method: '_ahp/event', params: { sessionId: p.sessionId, event: { type: 'turn/started', payload: { turnId: p.turnId } } } }); send({ method: '_ahp/event', params: { sessionId: p.sessionId, event: { type: 'turn/completed', payload: { turnId: p.turnId, status: 'completed' } } } }); respond({ turnId: p.turnId, accepted: true }); return; }
  }
  if ('id' in frame) send({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
}
const input = createInterface({ input: process.stdin });
input.on('line', (line) => { if (!line.trim()) return; void handle(JSON.parse(line)).catch((error) => { process.stderr.write(`fake ACP failed: ${error.code ?? 'local'}\n`); process.exit(2); }); });
input.on('close', () => process.exit(0));
