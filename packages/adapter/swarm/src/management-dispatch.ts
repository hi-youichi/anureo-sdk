import { HarnessSdkError } from '@anureo/sdk'
import { validateJsonSchema, type JsonSchema } from '@anureo/protocol'
import { MANAGEMENT_TOOLS } from './management-tools'

const schemas = new Map(MANAGEMENT_TOOLS.map(tool => [tool.name, tool.inputSchema as JsonSchema]))

/** Validate the same immutable schema advertised to the model, before any command is admitted. */
export function managementArguments(name: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
  const schema = schemas.get(name)
  const args = input as Record<string, unknown>
  if (!schema || !validateJsonSchema(schema, input)) {
    // Preserve the established error for attempts to override a configured fixed profile.
    if (name === 'bee_create' && args.profileId !== undefined && (args.role !== undefined || args.name !== undefined || args.model !== undefined)) throw new HarnessSdkError('SWARM_INVALID_PROFILE')
    throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
  }
  return args
}
