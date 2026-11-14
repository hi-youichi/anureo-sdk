import type { SDKAssistantMessageError, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { HarnessError } from '@anureo/protocol'

/** Return a safe terminal failure, or undefined for a successful non-error result.
 * ClaudeBackendSession.completeTurn supplies the latest main-assistant category and publishes the
 * returned error with turn completion (unless interrupted). Native limits take precedence over
 * API categories, which take precedence over valid HTTP statuses; free-form text is never exposed.
 * Retryability is advice to the consumer; this function neither throws native failures nor retries. */
export function claudeTurnError(result: SDKResultMessage, assistantError?: SDKAssistantMessageError): HarnessError | undefined {
  if (result.subtype === 'success' && !result.is_error) return undefined
  const limitCode = executionLimitCode(result.subtype)
  if (limitCode) return { code: limitCode, message: 'Claude execution limit reached', retryable: false, outcomeUnknown: false }
  const apiFailure = result.subtype === 'success' || result.terminal_reason === 'api_error'
  if (!apiFailure) return { code: 'CLAUDE_TURN_FAILED', message: 'Claude turn failed', retryable: false, outcomeUnknown: false }
  const rawStatus = result.subtype === 'success' ? result.api_error_status : undefined
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined
  const code = apiErrorCode(assistantError, status)
  return { code, message: 'Claude model request failed', retryable: code === 'RATE_LIMITED' || code === 'NATIVE_SERVICE_UNAVAILABLE', outcomeUnknown: false,
    ...(status !== undefined ? { details: { httpStatusCode: status } } : {}) }
}

/** Recognize execution limits before consulting potentially stale API failure evidence. */
function executionLimitCode(subtype: SDKResultMessage['subtype']): string | undefined {
  switch (subtype) {
    case 'error_max_structured_output_retries': return 'CLAUDE_STRUCTURED_OUTPUT_RETRIES_EXCEEDED'
    case 'error_max_turns': return 'CLAUDE_MAX_TURNS_EXCEEDED'
    case 'error_max_budget_usd': return 'CLAUDE_MAX_BUDGET_EXCEEDED'
    default: return undefined
  }
}

/** Prefer a recognized assistant category; use HTTP status only when that evidence is absent. */
function apiErrorCode(assistantError: SDKAssistantMessageError | undefined, status: number | undefined): string {
  const categories: Partial<Record<SDKAssistantMessageError, string>> = {
    authentication_failed: 'AUTH_REQUIRED', oauth_org_not_allowed: 'AUTH_FORBIDDEN', account_on_hold: 'AUTH_FORBIDDEN',
    billing_error: 'USAGE_LIMIT_EXCEEDED', rate_limit: 'RATE_LIMITED', overloaded: 'NATIVE_SERVICE_UNAVAILABLE',
    server_error: 'NATIVE_SERVICE_UNAVAILABLE', invalid_request: 'NATIVE_REQUEST_INVALID',
    model_not_found: 'MODEL_NOT_FOUND', max_output_tokens: 'CLAUDE_MAX_OUTPUT_TOKENS',
  }
  const nativeCategoryCode = assistantError && Object.hasOwn(categories, assistantError) && categories[assistantError]
  if (nativeCategoryCode) return nativeCategoryCode
  if (status === 401) return 'AUTH_REQUIRED'
  if (status === 403) return 'AUTH_FORBIDDEN'
  if (status === 429) return 'RATE_LIMITED'
  if (status !== undefined && status >= 500) return 'NATIVE_SERVICE_UNAVAILABLE'
  return 'CLAUDE_TURN_FAILED'
}
