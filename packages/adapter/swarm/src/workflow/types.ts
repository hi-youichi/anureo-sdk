// Workflow registration and option contracts for the swarm adapter.
import { HarnessSdkError } from '@anureo/sdk'
import type { Client } from '@anureo/sdk'
import type { z } from 'zod'
import { isBeeId } from '../profiles'

/** Context handed to a registered workflow run; client maps agent()/beer() onto bees. */
export interface SwarmWorkflowRunContext {
  /** Swarm façade client. Pass it as AgentOptions.client so each agent()/beer() step runs as a bee. */
  readonly client: Client
  readonly cwd: string
  readonly runId: string
  /** Aborted when the outer turn ends; queued steps are cancelled, completed steps stay journaled. */
  readonly signal: AbortSignal
}

/** A workflow file registered with the adapter. */
export interface SwarmWorkflowRegistration<S extends z.ZodObject = z.ZodObject> {
  /** Lowercase slug identifying the workflow to workflow_list/workflow_run and run manifests. */
  id: string
  /** One-line description shown to agents choosing between workflows. */
  description: string
  /** Bump when step semantics change; participates in the run manifest and resume validation. */
  revision: string
  /** Optional zod object validating and typing args from workflow_run. */
  argsSchema?: S
  /** Execute the workflow. Return a JSON-serializable value for workflow_status and host callers. */
  run(args: z.output<S>, context: SwarmWorkflowRunContext): Promise<unknown>
}

/** Budgets for workflow execution; defaults in parseWorkflowOptions. */
export interface SwarmWorkflowLimits {
  /** Concurrent workflow steps across all runs in one session. Default 8. */
  maxConcurrentSteps?: number
  /** Steps of one run waiting for a slot or bee. Default 64. */
  maxQueueDepthPerRun?: number
  /** Total delegations one run may start. Default 128. */
  maxStepsPerRun?: number
  /** Maximum workflow nesting depth; 0 forbids member-triggered runs. Default 1. */
  maxDepth?: number
}

export interface SwarmWorkflowOptions extends SwarmWorkflowLimits {
  /** Nonempty; feature is disabled when omitted. */
  registrations: readonly SwarmWorkflowRegistration[]
  /** Journal directory for run manifests and step journals; omit for memory-only runs. */
  journalDirectory?: string
  /** Advertise turn.outputSchema to workflow steps. Optimistic default true. */
  outputSchema?: boolean
}

export interface ParsedSwarmWorkflowOptions {
  readonly registrations: readonly SwarmWorkflowRegistration[]
  readonly limits: Required<SwarmWorkflowLimits>
  readonly journalDirectory?: string
  readonly outputSchema: boolean
}

const DEFAULT_LIMITS: Required<SwarmWorkflowLimits> = { maxConcurrentSteps: 8, maxQueueDepthPerRun: 64, maxStepsPerRun: 128, maxDepth: 1 }

/** Validate one registration supplied by an embedding application or file loader. */
export function parseSwarmWorkflowRegistration(value: unknown): SwarmWorkflowRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'Expected a registration object')
  const entry = value as Record<string, unknown>
  if (!isBeeId(entry.id)) throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'Expected a lowercase registration id matching ^[a-z][a-z0-9-]{0,39}$')
  if (typeof entry.description !== 'string' || !entry.description.trim() || entry.description.length > 4000) throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'Expected a nonempty description of at most 4000 characters')
  if (typeof entry.revision !== 'string' || !entry.revision.trim() || entry.revision.length > 64) throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'Expected a nonempty revision of at most 64 characters')
  if (typeof entry.run !== 'function') throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'Expected a run function')
  if (entry.argsSchema !== undefined && (typeof entry.argsSchema !== 'object' || typeof (entry.argsSchema as { safeParse?: unknown }).safeParse !== 'function')) {
    throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'argsSchema must be a zod object')
  }
  for (const key of Object.keys(entry)) if (!['id', 'description', 'revision', 'argsSchema', 'run'].includes(key)) throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', `Unknown registration field "${key}"`)
  return { id: entry.id, description: entry.description, revision: entry.revision, ...(entry.argsSchema === undefined ? {} : { argsSchema: entry.argsSchema as SwarmWorkflowRegistration['argsSchema'] }), run: entry.run as SwarmWorkflowRegistration['run'] }
}

/** Validate and detach workflow options; undefined feature configuration returns undefined. */
export function parseSwarmWorkflowOptions(value: SwarmWorkflowOptions | undefined): ParsedSwarmWorkflowOptions | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || !Array.isArray(value.registrations) || value.registrations.length === 0) {
    throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'Expected a nonempty registrations array')
  }
  const registrations = value.registrations.map(parseSwarmWorkflowRegistration)
  const ids = new Set(registrations.map(registration => registration.id))
  if (ids.size !== registrations.length) throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'Duplicate workflow id')
  const limits: Required<SwarmWorkflowLimits> = {
    ...DEFAULT_LIMITS,
    ...(value.maxConcurrentSteps === undefined ? {} : { maxConcurrentSteps: value.maxConcurrentSteps }),
    ...(value.maxQueueDepthPerRun === undefined ? {} : { maxQueueDepthPerRun: value.maxQueueDepthPerRun }),
    ...(value.maxStepsPerRun === undefined ? {} : { maxStepsPerRun: value.maxStepsPerRun }),
    ...(value.maxDepth === undefined ? {} : { maxDepth: value.maxDepth }),
  }
  for (const [key, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < (key === 'maxDepth' ? 0 : 1)) throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', `Invalid ${key}`)
  }
  if (value.journalDirectory !== undefined && (typeof value.journalDirectory !== 'string' || !value.journalDirectory.trim())) {
    throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'Expected a nonempty journalDirectory')
  }
  if (value.outputSchema !== undefined && typeof value.outputSchema !== 'boolean') throw new HarnessSdkError('SWARM_INVALID_WORKFLOW', 'outputSchema must be boolean')
  return {
    registrations,
    limits,
    ...(value.journalDirectory === undefined ? {} : { journalDirectory: value.journalDirectory }),
    outputSchema: value.outputSchema ?? true,
  }
}
