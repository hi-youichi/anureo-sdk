// Defines the shared MCP submission envelope and safe error-result formatting.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Internal reserved MCP identity for bridge configuration and fallback instructions.
 * OutputSession.prepareBridge rejects configurations that already claim this name before lease
 * allocation. OutputBridgeManager.create assigns it to the injected server configuration and
 * fallbackInput names it in the model's submission instructions.
 */
export const OUTPUT_SERVER_NAME = 'anureo_output'

/**
 * Wire contract exposed to MCP clients by the ListTools handler registered in createToolServer.
 * Pass the current submission's exact outputId and its candidate JSON value. OutputSession.submitValue
 * checks the envelope and ID before submitCandidate validates the value against the submission schema.
 * Acceptance is provisional until terminal publication rechecks the value and its privacy projection.
 */
export const OUTPUT_TOOL = {
  name: 'submit_result',
  description: 'Submit the final structured result for the current task. Use its outputId and satisfy its JSON Schema. After acceptance, end the task. On validation errors, correct the value and submit again.',
  inputSchema: {
    type: 'object' as const,
    properties: { outputId: { type: 'string', minLength: 1 }, value: {} },
    required: ['outputId', 'value'],
    additionalProperties: false,
  },
}

/**
 * Format a caller-supplied safe code, optional issues and recovery guidance as an MCP error result.
 * The CallTool handler registered in createToolServer returns this for expired leases or unknown
 * tools. OutputSession.submitValue returns it for envelope and candidate rejections. Supply safe,
 * JSON-serializable details because they go directly to the client. Serialization failures throw.
 * Falsy message and issues arguments are omitted from the JSON text.
 */
export function toolError(code: string, issues?: unknown, message?: string): CallToolResult {
  const text = JSON.stringify({ code, ...(message ? { message } : {}), ...(issues ? { issues } : {}) })
  return { isError: true, content: [{ type: 'text', text }] }
}
