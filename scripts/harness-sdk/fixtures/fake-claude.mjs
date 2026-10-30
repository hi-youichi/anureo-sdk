// Minimal external process for the pinned Claude Agent SDK transport probe.
// It never opens a network connection and does not read credentials or project files.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sessionId = '00000000-0000-4000-8000-000000000001';
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const input = createInterface({ input: process.stdin });
let catalogRevision = 0;
for await (const line of input) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line);
  if (process.env.FAKE_CATALOG_LOG) appendFileSync(process.env.FAKE_CATALOG_LOG, JSON.stringify({ type: frame.type }) + '\n');
  if (frame.type === 'control_request') {
    const models = process.env.FAKE_CATALOG_LOG ? [{ value: `catalog-${++catalogRevision}`, displayName: 'Fixture', description: '' }] : [];
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {
      commands: [], models, output_style: 'default', available_output_styles: ['default'],
    } } });
  } else if (frame.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000002', cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fake-probe', permissionMode: 'default', slash_commands: [], output_style: 'default', apiKeySource: 'none', claude_code_version: 'fake-transport-probe' });
    send({ type: 'assistant', session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000003', parent_tool_use_id: null, message: {
      id: 'probe-message', type: 'message', role: 'assistant', model: 'fake-probe', content: [{ type: 'text', text: 'external executable probe passed' }], stop_reason: 'end_turn', stop_sequence: null, usage,
    } });
    send({ type: 'result', subtype: 'success', session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000004', is_error: false, duration_ms: 1, duration_api_ms: 0, num_turns: 1, result: 'external executable probe passed', stop_reason: 'end_turn', usage, modelUsage: {}, permission_denials: [], total_cost_usd: 0 });
  }
}
