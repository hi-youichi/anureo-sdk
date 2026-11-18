import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const string = { type: 'string', minLength: 1, maxLength: 16000 } as const
function tool(name: string, description: string, properties: Record<string, object>, required: string[]): Tool {
  const mutates = ['bee_delegate', 'bee_assess', 'bee_cancel', 'bee_close'].includes(name)
  return { name, description, inputSchema: { type: 'object', properties: { ...properties, ...(mutates ? { operationKey: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional <operationScope>:<nonce> for safe retries; obtain operationScope from bee_create, bee_delegate or bee_status.' } } : {}) }, required, additionalProperties: false }, annotations: { readOnlyHint: ['bee_status', 'bee_wait', 'bee_receive', 'bee_result_read'].includes(name), destructiveHint: false, openWorldHint: false } }
}
export const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: 'bee_create',
    description: 'Create a read-only bee. Fixed: supply profileId and optional profileScope (user/project); explicit scope never falls back, omitted scope prefers project then user. Temporary: supply role/name, optional exact model and effort IDs for that role backend, and selectionReason explaining the choice or default fallback. Effort requires a backend effortConfigKey; supported model efforts are checked when known. A reason is required when that backend has visible model guidance. Omit model/effort for backend defaults. Fixed profiles cannot be overridden. Returns beeId, profile origin and requested execution settings; backend availability is checked on first delegation.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { profileId: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' }, profileScope: { type: 'string', enum: ['user', 'project'] }, role: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' }, name: string, model: { type: 'string', minLength: 1, maxLength: 512 }, effort: { type: 'string', minLength: 1, maxLength: 128 }, selectionReason: { type: 'string', minLength: 1, maxLength: 2000 }, operationKey: { type: 'string', minLength: 1, maxLength: 256 } },
      oneOf: [
        { required: ['profileId'], not: { anyOf: [{ required: ['role'] }, { required: ['name'] }, { required: ['model'] }, { required: ['effort'] }, { required: ['selectionReason'] }] } },
        { required: ['role', 'name'], not: { anyOf: [{ required: ['profileId'] }, { required: ['profileScope'] }] } },
      ],
    },
  },
  tool('bee_delegate', 'Start a task on an idle bee. Returns taskId immediately. Supply all necessary context.', { beeId: string, task: string, context: string, constraints: string, expectedOutput: string }, ['beeId', 'task', 'context', 'constraints', 'expectedOutput']),
  tool('bee_assess', 'Record main-agent acceptance of a terminal current-turn task. Unassessed is not accepted; acceptance is not validation of an improvement.', { taskId: string, verdict: { type: 'string', enum: ['accepted', 'needs_revision', 'rejected'] }, reason: string, evidence: { type: 'array', maxItems: 32, items: string } }, ['taskId', 'verdict', 'reason', 'evidence']),
  tool('bee_status', 'Inspect a task, or list current tasks and bees. Lists are paginated with nextCursor; history=true includes bounded retained history. Reports include messaging capability and operationScope for retry keys.', { taskId: string, history: { type: 'boolean' }, cursor: string, limit: { type: 'integer', minimum: 1, maximum: 32 } }, []),
  {
    ...tool('bee_wait', 'Wait for one task, or for any/all of several tasks. Pass exactly one argument shape: single {"taskId":"<id>"} (no mode, no taskIds) or batch {"taskIds":["<id>"],"mode":"any"|"all"} (mode required, no taskId). timeoutMs is optional in both shapes (0-30000, default 30000). A timeout leaves work running; call again to keep waiting. Batch returns tasks, remainingTaskIds and timedOut; single taskId preserves the task report.', {}, []),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        taskId: { ...string, description: 'Single-task form: a taskId returned by bee_delegate. taskIds and mode are forbidden beside it.' },
        taskIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: string, description: 'Batch form: 1-32 taskIds. Requires mode and forbids taskId.' },
        mode: { type: 'string', enum: ['any', 'all'], description: 'Batch form only: unblock when any or all listed tasks reach a terminal phase.' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, description: 'Optional wait budget in milliseconds for either form; defaults to 30000.' },
      },
      oneOf: [
        { description: 'Single-task form: taskId alone; taskIds and mode are forbidden.', required: ['taskId'], not: { anyOf: [{ required: ['taskIds'] }, { required: ['mode'] }] } },
        { description: 'Batch form: taskIds with a required mode; taskId is forbidden.', required: ['taskIds', 'mode'], not: { required: ['taskId'] } },
      ],
    },
  },
  tool('bee_receive', 'Read completion notices after a cursor. Repeated reads do not consume messages. Pass nextCursor as after; timeout leaves tasks running. A notice carries a resultRef, not necessarily the complete report.', { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 64 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 } }, []),
  tool('bee_result_read', 'Read full member report text by resultRef. Follow nextCursor until done. Cursors belong to one result and session; omitted or expired results fail explicitly.', { resultRef: string, cursor: string, maxBytes: { type: 'integer', minimum: 4, maximum: 32768 } }, ['resultRef']),
  tool('bee_send', 'Send supplemental information for a task. currentTurn requires atomic turn steering; nextAssignment queues for the next explicit delegation and never starts work. submitted means backend acceptance, not model comprehension. operationKey is required: <operationScope>:<nonce>. Retry the same key and arguments to read its receipt; never resend an unknown delivery with a fresh key.', { taskId: string, message: string, delivery: { type: 'string', enum: ['currentTurn', 'nextAssignment'] }, operationKey: { type: 'string', minLength: 1, maxLength: 256 } }, ['taskId', 'message', 'delivery', 'operationKey']),
  tool('bee_cancel', 'Cancel a task and wait for its stop outcome.', { taskId: string }, ['taskId']),
  tool('bee_close', 'Cancel work and release a bee session.', { beeId: string }, ['beeId']),
]
