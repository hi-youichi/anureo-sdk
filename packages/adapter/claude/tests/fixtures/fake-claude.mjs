// Scripted Claude Agent SDK child for transport, catalog, and structured output tests.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const probeSessionId = '00000000-0000-4000-8000-000000000001';
const probeText = 'external executable probe passed';
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

await run();

/** Read either CLI spelling so structured output probes follow the SDK's fresh/resume identity. */
function nativeArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index >= 0) {
    return process.argv[index + 1];
  }
  return process.argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** Read native SDK JSONL until stdin closes. A catalog log enables revisioned model replies.
 * A schema probe or CLI-supplied answer module enables structured results. Invalid frames and
 * fixture I/O failures surface as child process errors. */
async function run() {
  const { FAKE_CATALOG_LOG: catalogLog, FAKE_SCHEMA_LOG: schemaLog, FAKE_STRUCTURED_ANSWER: answerPath } = process.env;
  const answer = answerPath ? (await import(pathToFileURL(answerPath).href)).answer : undefined;
  const schemaProbe = process.env.FAKE_SCHEMA_PROBE === '1' || !!answer;
  const sessionId = schemaProbe ? nativeArg('--session-id') ?? nativeArg('--resume') ?? probeSessionId : probeSessionId;
  const input = createInterface({ input: process.stdin });
  let catalogResponseRevision = 0;
  let outputSchema;
  for await (const line of input) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (catalogLog) appendFileSync(catalogLog, JSON.stringify({ type: frame.type }) + '\n');
    if (frame.type === 'control_request') {
      if (schemaProbe && frame.request.subtype === 'initialize') {
        outputSchema = frame.request.jsonSchema;
        if (schemaLog) appendFileSync(schemaLog, JSON.stringify({ sessionId, resume: nativeArg('--resume'), schema: outputSchema }) + '\n');
      }
      const models = catalogLog ? [{ value: `catalog-${++catalogResponseRevision}`, displayName: 'Fixture', description: '' }] : [];
      sendControlResponse(frame.request_id, models);
    } else if (frame.type === 'user') {
      const content = frame.message?.content;
      const prompt = typeof content === 'string' ? content : content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const structuredOutput = schemaProbe && outputSchema ? answer?.(prompt) ?? { answer: outputSchema.properties?.answer?.const ?? 42 } : undefined;
      sendTurn({ sessionId, userUuid: frame.uuid, structuredOutput });
    }
  }
}

/** Echo the request ID so the SDK can resolve initialization and catalog refresh independently. */
function sendControlResponse(requestId, models) {
  send({
    type: 'control_response',
    response: {
      subtype: 'success', request_id: requestId,
      response: { commands: [], models, output_style: 'default', available_output_styles: ['default'] },
    },
  });
}

/** Emit init, assistant, then result. Echo the input UUID on both execution frames so the
 * adapter can bind the submission and consume its terminal. Include structured output when set. */
function sendTurn({ sessionId, userUuid, structuredOutput }) {
  send({
    type: 'system', subtype: 'init', session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000002',
    cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fake-probe', permissionMode: 'default',
    slash_commands: [], output_style: 'default', apiKeySource: 'none', claude_code_version: 'fake-transport-probe',
  });
  send({
    type: 'assistant', user_message_uuid: userUuid, session_id: sessionId, uuid: '00000000-0000-4000-8000-000000000003',
    parent_tool_use_id: null,
    message: {
      id: 'probe-message', type: 'message', role: 'assistant', model: 'fake-probe',
      content: [{ type: 'text', text: probeText }], stop_reason: 'end_turn', stop_sequence: null, usage,
    },
  });
  send({
    type: 'result', user_message_uuid: userUuid, subtype: 'success', session_id: sessionId,
    uuid: '00000000-0000-4000-8000-000000000004', is_error: false, duration_ms: 1, duration_api_ms: 0,
    num_turns: 1, result: probeText, ...(structuredOutput ? { structured_output: structuredOutput } : {}),
    stop_reason: 'end_turn', usage, modelUsage: {}, permission_denials: [], total_cost_usd: 0,
  });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
