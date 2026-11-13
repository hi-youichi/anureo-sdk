// Defines the MCP output-tool wire contract and error formatting; must not own listeners or submission state.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Reserved MCP server identity used by bridge configuration and adapter-injected output instructions. */
export const OUTPUT_SERVER_NAME = 'anureo_output'
/** Public MCP tool definition; session validation binds outputId to a submission and validates value separately against its prepared schema. */
export const OUTPUT_TOOL = {
  name: 'submit_result',
  description: 'Submit the final structured result for the current task. Use its outputId and satisfy its JSON Schema. After acceptance, end the task. On validation errors, correct the value and submit again.',
  inputSchema: { type: 'object' as const, properties: { outputId: { type: 'string', minLength: 1 }, value: {} }, required: ['outputId', 'value'], additionalProperties: false },
}

/** Format a caller-supplied safe code, optional issues and recovery guidance as an MCP error result; performs no submission validation or I/O. Serialization errors propagate. */
export function toolError(code: string, issues?: unknown, message?: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, ...(message ? { message } : {}), ...(issues ? { issues } : {}) }) }] }
}
