// Defines the shared MCP submission envelope and safe error-result formatting.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Internal reserved MCP identity for bridge configuration and fallback instructions.
 * OutputSession.open rejects configurations that already claim this name when preparing a fallback bridge;
 * OutputBridgeManager.create assigns it to the injected server configuration.
 */
export const OUTPUT_SERVER_NAME = 'anureo_output'
/**
 * Wire contract exposed to MCP clients by OutputBridgeManager.dispatchRequest's ListTools handler.
 * This internal export defines the routing envelope: outputId must identify the current submission,
 * while value is unconstrained here and is checked against the prepared schema by OutputSession.
 * dispatchRequest's CallTool handler checks the name before invoking the session candidate handler.
 */
export const OUTPUT_TOOL = {
  name: 'submit_result',
  description: 'Submit the final structured result for the current task. Use its outputId and satisfy its JSON Schema. After acceptance, end the task. On validation errors, correct the value and submit again.',
  inputSchema: { type: 'object' as const, properties: { outputId: { type: 'string', minLength: 1 }, value: {} }, required: ['outputId', 'value'], additionalProperties: false },
}

/**
 * Format a caller-supplied safe code, optional issues and recovery guidance as an MCP error result.
 * dispatchRequest's CallTool callback uses this for expired/unknown tools; OutputSession.submitValue
 * returns it for candidate rejection so MCP clients can correct and retry. Callers must supply safe,
 * JSON-serializable details: this internal helper does no redaction and throws on serialization
 * failure. Falsy message/issues values are omitted from the JSON text content.
 */
export function toolError(code: string, issues?: unknown, message?: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, ...(message ? { message } : {}), ...(issues ? { issues } : {}) }) }] }
}
