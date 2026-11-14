import type { SDKAssistantMessageError, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { HarnessError } from '@anureo/protocol'

/**
 * Classify a native terminal result, returning undefined for a successful non-error result.
 * Execution limits take precedence. For API failures, a recognized assistant category takes
 * precedence over a valid HTTP status. Returned errors use fixed messages and omit native prose.
 * ClaudeBackendSession.completeTurn supplies the latest main-assistant category and emits the
 * returned error with turn/completed unless interrupted. The caller receives it in the failed
 * result from Turn.result(). Retryability is advice for the consumer.
 */
export function claudeTurnError(result: SDKResultMessage, assistantError?: SDKAssistantMessageError): HarnessError | undefined {
  if (result.subtype === 'success' && !result.is_error) return undefined
  const limitCode = executionLimitCode(result.subtype)
  if (limitCode) return { code: limitCode, message: 'Claude execution limit reached', retryable: false, outcomeUnknown: false }
  if (result.subtype !== 'success' && result.terminal_reason !== 'api_error') {
    return { code: 'CLAUDE_TURN_FAILED', message: 'Claude turn failed', retryable: false, outcomeUnknown: false }
  }
  const status = apiErrorStatus(result)
  const code = apiErrorCode(assistantError, status)
  return {
    code,
    message: 'Claude model request failed',
    retryable: code === 'RATE_LIMITED' || code === 'NATIVE_SERVICE_UNAVAILABLE',
    outcomeUnknown: false,
    ...(status !== undefined ? { details: { httpStatusCode: status } } : {}),
  }
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

/** Accept HTTP status integers from 100 through 599 on the success variant for classification and public details. */
function apiErrorStatus(result: SDKResultMessage): number | undefined {
  if (result.subtype !== 'success') return undefined
  const status = result.api_error_status
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status
  return undefined
}

const assistantErrorCodes: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: 'AUTH_REQUIRED',
  oauth_org_not_allowed: 'AUTH_FORBIDDEN',
  account_on_hold: 'AUTH_FORBIDDEN',
  billing_error: 'USAGE_LIMIT_EXCEEDED',
  rate_limit: 'RATE_LIMITED',
  overloaded: 'NATIVE_SERVICE_UNAVAILABLE',
  server_error: 'NATIVE_SERVICE_UNAVAILABLE',
  invalid_request: 'NATIVE_REQUEST_INVALID',
  model_not_found: 'MODEL_NOT_FOUND',
  max_output_tokens: 'CLAUDE_MAX_OUTPUT_TOKENS',
}

/** Use a recognized assistant category first, then fall back to HTTP status. */
function apiErrorCode(assistantError: SDKAssistantMessageError | undefined, status: number | undefined): string {
  if (assistantError && Object.hasOwn(assistantErrorCodes, assistantError)) {
    const code = assistantErrorCodes[assistantError]
    if (code) return code
  }
  if (status === 401) return 'AUTH_REQUIRED'
  if (status === 403) return 'AUTH_FORBIDDEN'
  if (status === 429) return 'RATE_LIMITED'
  if (status !== undefined && status >= 500) return 'NATIVE_SERVICE_UNAVAILABLE'
  return 'CLAUDE_TURN_FAILED'
}
