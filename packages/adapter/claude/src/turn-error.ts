import type { SDKAssistantMessageError, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { HarnessError } from '@anureo/protocol'

/** Native categories only: free-form result/errors text is never used for classification. */
export function claudeTurnError(result: SDKResultMessage, assistantError?: SDKAssistantMessageError): HarnessError | undefined {
  if (result.subtype === 'success' && !result.is_error) return undefined
  const failures: Record<string, string> = {
    error_max_structured_output_retries: 'CLAUDE_STRUCTURED_OUTPUT_RETRIES_EXCEEDED',
    error_max_turns: 'CLAUDE_MAX_TURNS_EXCEEDED',
    error_max_budget_usd: 'CLAUDE_MAX_BUDGET_EXCEEDED',
  }
  if (Object.hasOwn(failures, result.subtype)) return { code: failures[result.subtype]!, message: 'Claude execution limit reached', retryable: false, outcomeUnknown: false }
  const apiFailure = result.subtype === 'success' || result.terminal_reason === 'api_error'
  if (!apiFailure) return { code: 'CLAUDE_TURN_FAILED', message: 'Claude turn failed', retryable: false, outcomeUnknown: false }
  const categories: Partial<Record<SDKAssistantMessageError, string>> = {
    authentication_failed: 'AUTH_REQUIRED', oauth_org_not_allowed: 'AUTH_FORBIDDEN', account_on_hold: 'AUTH_FORBIDDEN',
    billing_error: 'USAGE_LIMIT_EXCEEDED', rate_limit: 'RATE_LIMITED', overloaded: 'NATIVE_SERVICE_UNAVAILABLE',
    server_error: 'NATIVE_SERVICE_UNAVAILABLE', invalid_request: 'NATIVE_REQUEST_INVALID',
    model_not_found: 'MODEL_NOT_FOUND', max_output_tokens: 'CLAUDE_MAX_OUTPUT_TOKENS',
  }
  const rawStatus = result.subtype === 'success' ? result.api_error_status : undefined
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined
  const nativeCategoryCode = assistantError && Object.hasOwn(categories, assistantError) && categories[assistantError]
  let code: string
  if (nativeCategoryCode) {
    code = nativeCategoryCode
  } else if (status === 401) {
    code = 'AUTH_REQUIRED'
  } else if (status === 403) {
    code = 'AUTH_FORBIDDEN'
  } else if (status === 429) {
    code = 'RATE_LIMITED'
  } else if (status !== undefined && status >= 500) {
    code = 'NATIVE_SERVICE_UNAVAILABLE'
  } else {
    code = 'CLAUDE_TURN_FAILED'
  }
  return { code, message: 'Claude model request failed', retryable: code === 'RATE_LIMITED' || code === 'NATIVE_SERVICE_UNAVAILABLE', outcomeUnknown: false,
    ...(status !== undefined ? { details: { httpStatusCode: status } } : {}) }
}
