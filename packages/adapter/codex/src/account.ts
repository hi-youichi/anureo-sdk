import { HarnessSdkError } from '@anureo/sdk'
import { CodexRpcError, type CodexJsonlClient } from './jsonl'
import { record, type NativeRecord } from './native-values'

/**
 * Read account readiness on an initialized client without refreshing credentials. The catalog
 * and CodexNativeAdapter.readAuthStatus return the status to hosts. CodexBackendSession.startInput
 * rejects with AUTH_REQUIRED on required before sending turn/start.
 *
 * Return unknown for method-not-found. Malformed replies and other failures reject. SDK errors
 * have outcomeUnknown set to false because the check precedes dispatch. The caller owns the client.
 */
export async function readAccountStatus(client: CodexJsonlClient): Promise<'unknown' | 'required' | 'ready'> {
  try {
    return decodeAccountStatus(record(await client.request('account/read', { refreshToken: false })))
  } catch (cause) {
    if (cause instanceof CodexRpcError && cause.rpcCode === -32601) return 'unknown'
    if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false, cause.details)
    throw cause
  }
}

/**
 * Interpret a native account/read reply. An installation that disables OpenAI auth is ready
 * without an account, and any nonblank account type satisfies the auth requirement. Only an
 * explicit null account with auth required returns required. Other combinations throw PROTOCOL_ERROR.
 */
function decodeAccountStatus(response: NativeRecord): 'required' | 'ready' {
  if (response.requiresOpenaiAuth === false) return 'ready'
  const accountType = record(response.account).type
  if (typeof accountType === 'string' && accountType.trim()) return 'ready'
  if (response.account === null && response.requiresOpenaiAuth === true) return 'required'
  throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid native account status')
}
