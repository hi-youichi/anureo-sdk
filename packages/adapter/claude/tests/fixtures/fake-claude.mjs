// Minimal external process for the pinned Claude Agent SDK transport probe.
// It never opens a network connection and does not read credentials or project files.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const schemaProbe = process.env.FAKE_SCHEMA_PROBE === '1';
const hookProbe = process.env.FAKE_HOOK_PROBE === '1';
// Configuring a catalog log also enables dynamic catalog probe responses.
const catalogProbe = Boolean(process.env.FAKE_CATALOG_LOG);
const nativeArg = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index >= 0) {
    return process.argv[index + 1];
  }
  return process.argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
};
const sessionId = schemaProbe ? nativeArg('--session-id') ?? nativeArg('--resume') ?? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000001';
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const input = createInterface({ input: process.stdin });
let catalogResponseRevision = 0;
let outputSchema;
let nativeHooks;
let hookUser;
const hookRequest = (name, requestId, fields) => {
  const callbackId = nativeHooks?.[name]?.[0]?.hookCallbackIds?.[0];
  if (!callbackId) throw new Error(`Missing SDK hook registration for ${name}`);
  send({ type: 'control_request', request_id: requestId, request: {
    subtype: 'hook_callback', callback_id: callbackId, ...(fields.tool_use_id ? { tool_use_id: fields.tool_use_id } : {}),
    input: { hook_event_name: name, session_id: sessionId, cwd: process.cwd(), transcript_path: 'fixture', ...fields },
  } });
};
const complete = (frame, text) => {
  send({ type: 'result', user_message_uuid: frame.uuid, subtype: 'success', session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000004', is_error: false, duration_ms: 1, duration_api_ms: 0, num_turns: 1, result: text, ...(schemaProbe && outputSchema ? { structured_output: { answer: outputSchema.properties?.answer?.const ?? 42 } } : {}), stop_reason: 'end_turn', usage, modelUsage: {}, permission_denials: [], total_cost_usd: 0 });
};
for await (const line of input) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line);
  if (hookProbe && process.env.FAKE_HOOK_LOG && (frame.type === 'control_response' || frame.request?.subtype === 'initialize')) {
    appendFileSync(process.env.FAKE_HOOK_LOG, JSON.stringify(frame.response ?? frame.request.hooks) + '\n');
  }
  if (process.env.FAKE_CATALOG_LOG) appendFileSync(process.env.FAKE_CATALOG_LOG, JSON.stringify({ type: frame.type }) + '\n');
  if (frame.type === 'control_request') {
    if (hookProbe && frame.request.subtype === 'initialize') nativeHooks = frame.request.hooks;
    if (schemaProbe && frame.request.subtype === 'initialize') {
      outputSchema = frame.request.jsonSchema;
      if (process.env.FAKE_SCHEMA_LOG) appendFileSync(process.env.FAKE_SCHEMA_LOG, JSON.stringify({ sessionId, resume: nativeArg('--resume'), schema: outputSchema }) + '\n');
    }
    const models = catalogProbe ? [{ value: `catalog-${++catalogResponseRevision}`, displayName: 'Fixture', description: '' }] : [];
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {
      commands: [], models, output_style: 'default', available_output_styles: ['default'],
    } } });
  } else if (frame.type === 'control_response' && hookProbe) {
    const { request_id: id, response } = frame.response;
    if (id === 'probe-tool') {
      if (response?.hookSpecificOutput?.permissionDecision !== 'deny') throw new Error('Expected native tool denial');
      hookRequest('Stop', 'probe-stop', { stop_hook_active: false, last_assistant_message: 'initial answer' });
    } else if (id === 'probe-stop') {
      if (response?.decision !== 'block' || response.reason !== 'check once') throw new Error('Expected native stop continuation');
      hookRequest('Stop', 'probe-repeat-stop', { stop_hook_active: false });
    } else if (id === 'probe-repeat-stop') {
      if (response?.decision === 'block') throw new Error('Repeated Stop blockade');
      send({ type: 'assistant', user_message_uuid: hookUser.uuid, session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000005', parent_tool_use_id: null, message: {
        id: 'probe-final', type: 'message', role: 'assistant', model: 'fake-probe', content: [{ type: 'text', text: 'native hooks passed' }], stop_reason: 'end_turn', stop_sequence: null, usage,
      } });
      complete(hookUser, 'native hooks passed');
    }
  } else if (frame.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000002', cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fake-probe', permissionMode: 'default', slash_commands: [], output_style: 'default', apiKeySource: 'none', claude_code_version: 'fake-transport-probe' });
    send({ type: 'assistant', user_message_uuid: frame.uuid, session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000003', parent_tool_use_id: null, message: {
      id: 'probe-message', type: 'message', role: 'assistant', model: 'fake-probe', content: [{ type: 'text', text: 'external executable probe passed' }], stop_reason: 'end_turn', stop_sequence: null, usage,
    } });
    if (hookProbe) {
      hookUser = frame;
      hookRequest('PreToolUse', 'probe-tool', { tool_name: 'Read', tool_use_id: 'fixture-read', tool_input: { file_path: 'fixture.txt' } });
    } else complete(frame, 'external executable probe passed');
  }
}
