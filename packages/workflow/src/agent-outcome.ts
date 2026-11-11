import type { HarnessError } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'

// Only apply to native failed terminal results, never open/submit/observation failures.
const terminalApiErrors = new Set([
  'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'USAGE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'NATIVE_SERVICE_UNAVAILABLE',
])

export function isDroppedOutcome(error: HarnessError, status: 'failed' | 'interrupted'): boolean {
  if (error.outcomeUnknown) return false
  if (status === 'interrupted') return error.details?.workflowDisposition === 'skipped'
  return isStartupBlocked(error) || terminalApiErrors.has(error.code)
}

export function isStartupBlocked(error: Pick<HarnessSdkError, 'code' | 'outcomeUnknown' | 'details'>): boolean {
  return !error.outcomeUnknown && error.code === 'AGENT_STARTUP_BLOCKED' && error.details?.workflowDisposition === 'startup_blocked'
}

export function isStartupBlockException(cause: unknown): cause is HarnessSdkError {
  return cause instanceof HarnessSdkError && isStartupBlocked(cause)
}
