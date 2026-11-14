import type { HarnessError } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'

/**
 * Internal policy for observeAgentTurn: confirmed failed API terminals, startup denial and explicit
 * interrupted skips may become agent's null result after cleanup. Unknown outcomes must still reject.
 * Do not apply this terminal-only classification to open, submit or observation exceptions.
 */
export function isDroppedOutcome(error: HarnessError, status: 'failed' | 'interrupted'): boolean {
  if (error.outcomeUnknown) return false
  if (status === 'interrupted') return error.details?.workflowDisposition === 'skipped'
  return isStartupBlocked(error) || terminalApiErrors.has(error.code)
}

/** Shared terminal/exception rule: require the dedicated startup code, adapter disposition and a known outcome. */
export function isStartupBlocked(error: Pick<HarnessSdkError, 'code' | 'outcomeUnknown' | 'details'>): boolean {
  return !error.outcomeUnknown && error.code === 'AGENT_STARTUP_BLOCKED' && error.details?.workflowDisposition === 'startup_blocked'
}

/** openAgentSession and observeAgentTurn use this internal guard; only a definite SDK startup denial qualifies. */
export function isStartupBlockException(cause: unknown): cause is HarnessSdkError {
  return cause instanceof HarnessSdkError && isStartupBlocked(cause)
}

// Only apply to native failed terminal results, never open/submit/observation failures.
const terminalApiErrors = new Set([
  'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'USAGE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'NATIVE_SERVICE_UNAVAILABLE',
])
