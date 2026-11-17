import { HarnessSdkError } from '@anureo/sdk'
import { validateJsonSchema, type JsonSchema } from '@anureo/protocol'
import { MANAGEMENT_TOOLS } from './management-tools'

const schemas = new Map(MANAGEMENT_TOOLS.map(tool => [tool.name, tool.inputSchema as JsonSchema]))

/** One-line remediation hints for tools whose schema admits several strict shapes; appended to schema-mismatch errors so the caller can self-correct. */
const ARGUMENT_HINTS: Record<string, string> = {
  bee_create: 'pass either {"profileId":"<id>"} or {"role":"<slug>","name":"<name>"}; profileId excludes role, name, model, effort and selectionReason',
  bee_wait: 'pass either {"taskId":"<id>"} or {"taskIds":[...],"mode":"any"|"all"}; never combine taskId with taskIds or mode',
}

/** Validate the same immutable schema advertised to the model, before any command is admitted. */
export function managementArguments(name: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', `${name}: arguments must be a JSON object`)
  const schema = schemas.get(name)
  const args = input as Record<string, unknown>
  if (!schema || !validateJsonSchema(schema, input)) {
    // Preserve the established error for attempts to override a configured fixed profile.
    if (name === 'bee_create' && args.profileId !== undefined && (args.role !== undefined || args.name !== undefined || args.model !== undefined)) throw new HarnessSdkError('SWARM_INVALID_PROFILE')
    const hint = ARGUMENT_HINTS[name]
    throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', hint ? `${name}: arguments do not match the declared schema; ${hint}` : `${name}: arguments do not match the declared tool schema`)
  }
  return args
}
