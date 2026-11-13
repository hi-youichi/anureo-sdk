/** Reads native account readiness for catalog and session callers; it must not authenticate or dispatch turns. */
import { HarnessSdkError } from '@anureo/sdk'
import { CodexRpcError, type CodexJsonlClient } from './jsonl'
import { record } from './native-values'

/** For adapter probes, catalog reads and session preflight on an initialized client, return readiness without refreshing credentials. Method-not-found means unknown; malformed replies and other failures reject, with SDK failures marked definite before dispatch. Caller retains client ownership. */
export async function readAccountStatus(client: CodexJsonlClient): Promise<'unknown'|'required'|'ready'> {
  try {
    const response = record(await client.request('account/read', { refreshToken: false }))
    // A native installation may explicitly disable OpenAI auth; an account is not required then.
    if (response.requiresOpenaiAuth === false) return 'ready'
    // A known account takes precedence over the generic auth requirement, even for future account types.
    if (typeof record(response.account).type === 'string' && String(record(response.account).type).trim()) return 'ready'
    if (response.account === null && response.requiresOpenaiAuth === true) return 'required'
    throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid native account status')
  } catch (cause) {
    if (cause instanceof CodexRpcError && cause.rpcCode === -32601) return 'unknown'
    // This read precedes turn dispatch; its failure cannot make the turn uncertain.
    if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false, cause.details)
    throw cause
  }
}
