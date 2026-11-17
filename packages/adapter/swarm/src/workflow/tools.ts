// MCP tool surface for swarm workflow execution; validation reuses the advertised schemas.
import { HarnessSdkError } from '@anureo/sdk'
import { validateJsonSchema, type JsonSchema } from '@anureo/protocol'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const string = { type: 'string', minLength: 1, maxLength: 16000 } as const
const slug = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' } as const
const runId = { type: 'string', minLength: 1, maxLength: 128 } as const
const timeout = { type: 'integer', minimum: 0, maximum: 30000, description: 'Optional bounded wait for a terminal status; 0 or omitted returns the current snapshot.' } as const

/** Main-agent workflow tools, served beside the bee_* tools on anureo-swarm. */
export const WORKFLOW_TOOLS: Tool[] = [
  {
    name: 'workflow_list',
    description: 'List registered workflows with id, description and revision. Use workflow_run with one of these ids.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workflow_run',
    description: 'Start a registered workflow with JSON args; returns runId immediately while steps run as bee tasks in the background. Watch progress with workflow_status, bee_status or bee_wait. Steps that finish before the turn ends stay journaled; resumeFrom reuses them in a later turn. Any bee can also start workflows with its own member tools.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        workflowId: slug,
        args: { type: 'object', description: 'JSON object passed to the workflow; validated against its declared args schema.' },
        resumeFrom: { type: 'string', minLength: 1, maxLength: 128, description: 'Prior runId whose completed steps should be reused from the journal.' },
      },
      required: ['workflowId'],
    },
  },
  {
    name: 'workflow_status',
    description: 'Read one run: status, step counts, taskIds and bounded result. Optional timeoutMs waits for a terminal status like bee_wait. Statuses: running, completed, incomplete, failed, interrupted.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { runId, timeoutMs: timeout }, required: ['runId'] },
  },
]

/** Member workflow tools, served per bee on anureo-swarm-member. */
export const MEMBER_WORKFLOW_TOOLS: Tool[] = [
  WORKFLOW_TOOLS[0],
  {
    ...WORKFLOW_TOOLS[1],
    description: 'Start a registered workflow with JSON args; returns runId immediately while steps run as bee tasks in the background. Watch progress with workflow_status. Steps that finish before your assignment ends stay journaled; resumeFrom reuses them later.',
  },
  WORKFLOW_TOOLS[2],
  {
    name: 'workflow_send',
    description: 'Send supplemental information to a step task of a run you started. currentTurn requires atomic steering; nextAssignment queues data for that bee\'s next assignment within the same run and is rejected when the run ends.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 16000 }, message: string, delivery: { type: 'string', enum: ['currentTurn', 'nextAssignment'] } },
      required: ['taskId', 'message', 'delivery'],
    },
  },
]
export const MEMBER_SERVER_NAME = 'anureo-swarm-member'

/** Validate tool arguments against the same immutable schema advertised to the model. */
export function workflowArguments(name: string, input: unknown, tools: readonly Tool[]): Record<string, unknown> {
  const schema = tools.find(tool => tool.name === name)?.inputSchema as unknown as JsonSchema | undefined
  if (!schema || !validateJsonSchema(schema, input ?? {})) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
  return (input ?? {}) as Record<string, unknown>
}
