// Host-owned workflow turns: submit a /workflow directive and parse its result payload.
import { HarnessSdkError, type Session } from '@anureo/sdk'

function payloadOf(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

async function directiveTurn(session: Session, input: string): Promise<Record<string, unknown>> {
  const turn = await session.submit({ input })
  const result = await turn.result({ timeoutMs: null })
  const payload = payloadOf(result.text)
  if (result.status === 'failed') {
    const error = result.error
    throw new HarnessSdkError(error?.code ?? 'SWARM_WORKFLOW_FAILED', error?.message ?? 'The workflow run failed', false, error?.outcomeUnknown, payload as never)
  }
  return payload ?? { status: result.status }
}

/** Run a registered workflow as one host-owned turn; the directive bypasses the main agent. */
export async function runSwarmWorkflow(session: Session, workflowId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return directiveTurn(session, `/workflow run ${workflowId}${args !== undefined ? ` ${JSON.stringify(args)}` : ''}`)
}

/** Resume an interrupted run; completed steps replay from the journal, only the remainder executes. */
export async function resumeSwarmWorkflow(session: Session, workflowId: string, runId: string): Promise<Record<string, unknown>> {
  return directiveTurn(session, `/workflow resume ${workflowId} ${runId}`)
}

/** List registered workflows through one host-owned turn. */
export async function listSwarmWorkflows(session: Session): Promise<Record<string, unknown>> {
  return directiveTurn(session, '/workflow list')
}
