import { expect, test } from 'bun:test'
import type { SDKAssistantMessageError, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeTurnError } from './turn-error'

const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: true, result: 'private response', ...extra }) as SDKResultMessage

test.each([
  ['authentication_failed', 'AUTH_REQUIRED'], ['oauth_org_not_allowed', 'AUTH_FORBIDDEN'], ['account_on_hold', 'AUTH_FORBIDDEN'],
  ['billing_error', 'USAGE_LIMIT_EXCEEDED'], ['rate_limit', 'RATE_LIMITED'], ['overloaded', 'NATIVE_SERVICE_UNAVAILABLE'],
  ['server_error', 'NATIVE_SERVICE_UNAVAILABLE'], ['invalid_request', 'NATIVE_REQUEST_INVALID'], ['model_not_found', 'MODEL_NOT_FOUND'],
  ['max_output_tokens', 'CLAUDE_MAX_OUTPUT_TOKENS'], ['unknown', 'CLAUDE_TURN_FAILED'],
] as const)('maps typed assistant API category %s to %s', (category, code) => {
  const error = claudeTurnError(result(), category)
  expect(error).toMatchObject({ code, outcomeUnknown: false })
  expect(JSON.stringify(error)).not.toContain('private')
})

test.each([[401, 'AUTH_REQUIRED'], [403, 'AUTH_FORBIDDEN'], [429, 'RATE_LIMITED'], [503, 'NATIVE_SERVICE_UNAVAILABLE'], [400, 'CLAUDE_TURN_FAILED'], [999, 'CLAUDE_TURN_FAILED']] as const)('maps authoritative HTTP status %i', (status, code) => {
  expect(claudeTurnError(result({ api_error_status: status }))).toMatchObject({ code })
})

test('execution limits and generic runtime failures cannot be reclassified by an earlier API error', () => {
  for (const [subtype, code] of Object.entries({
    error_max_turns: 'CLAUDE_MAX_TURNS_EXCEEDED', error_max_budget_usd: 'CLAUDE_MAX_BUDGET_EXCEEDED',
    error_max_structured_output_retries: 'CLAUDE_STRUCTURED_OUTPUT_RETRIES_EXCEEDED', error_during_execution: 'CLAUDE_TURN_FAILED',
  })) expect(claudeTurnError(result({ subtype }), 'rate_limit')).toMatchObject({ code, outcomeUnknown: false })
  expect(claudeTurnError(result({ is_error: false }), 'rate_limit')).toBeUndefined()
  expect(claudeTurnError(result({ subtype: 'error_during_execution', terminal_reason: 'api_error' }), 'rate_limit')).toMatchObject({ code: 'RATE_LIMITED' })
  expect(claudeTurnError(result(), 'future_category' as SDKAssistantMessageError)).toMatchObject({ code: 'CLAUDE_TURN_FAILED' })
  expect(claudeTurnError(result(), 'constructor' as SDKAssistantMessageError)).toMatchObject({ code: 'CLAUDE_TURN_FAILED' })
  expect(claudeTurnError(result({ subtype: '__proto__' }))).toMatchObject({ code: 'CLAUDE_TURN_FAILED' })
})
