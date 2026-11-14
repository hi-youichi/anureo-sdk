import * as acp from '@agentclientprotocol/sdk';
import { HarnessSdkError } from '@anureo/sdk';

/** Convert a native failure into an SDK error for AcpAdapter.call to throw. Preserve existing SDK
 * errors. Use the fallback for unmapped JSON-RPC codes and omit the native message and data.
 * Other failures become ACP_CONNECTION_CLOSED with an unknown outcome. The backend also uses
 * this classification when reporting configuration, review and submission failures. */
export function errorFromNative(error: unknown, fallback = 'ACP_REQUEST_FAILED'): HarnessSdkError {
  if (error instanceof HarnessSdkError) return error;
  if (error instanceof acp.RequestError) {
    const code = nativeErrorCodes.get(error.code) ?? fallback;
    return new HarnessSdkError(code, code, false, false, { nativeCode: error.code });
  }
  return new HarnessSdkError('ACP_CONNECTION_CLOSED', 'ACP connection closed', false, true);
}

// Keep the private-method fallback separate from protocol codes with shared SDK meanings.
const nativeErrorCodes = new Map([
  [-32601, 'CAPABILITY_UNSUPPORTED'],
  [-32602, 'INVALID_PARAMS'],
  [-32000, 'AUTH_REQUIRED'],
  [-32002, 'RESOURCE_NOT_FOUND'],
]);
