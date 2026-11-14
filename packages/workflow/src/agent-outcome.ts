import type { HarnessError } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'

/**
 * Let classifyAgentFailure identify terminal candidates for agent's null result after cleanup.
 * Only known outcomes qualify. Interrupted terminals require an explicit skip, and failed
 * terminals require a startup denial or a code from the terminal API allowlist.
 */
export function isDroppedOutcome(error: HarnessError, status: 'failed' | 'interrupted'): boolean {
  if (error.outcomeUnknown) return false
  if (status === 'interrupted') return error.details?.workflowDisposition === 'skipped'
  return isStartupBlocked(error) || terminalApiErrors.has(error.code)
}

/** Check the dedicated code and adapter disposition required for a known startup denial. */
export function isStartupBlocked(error: Pick<HarnessSdkError, 'code' | 'outcomeUnknown' | 'details'>): boolean {
  return !error.outcomeUnknown && error.code === 'AGENT_STARTUP_BLOCKED' && error.details?.workflowDisposition === 'startup_blocked'
}

/**
 * Recognize a thrown SDK startup denial. openAgentSession returns null for a matching rejection
 * from session creation. observeAgentTurn records a drop candidate and leaves settlement to cleanup.
 */
export function isStartupBlockException(cause: unknown): cause is HarnessSdkError {
  return cause instanceof HarnessSdkError && isStartupBlocked(cause)
}

// Only apply to native failed terminal results, never open/submit/observation failures.
const terminalApiErrors = new Set([
  'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'USAGE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'NATIVE_SERVICE_UNAVAILABLE',
])
