import { HarnessSdkError } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import type { HermesAdapterOptions } from './options'
import { array, identity, object, protocolError } from './native'

/** Internal attach result: protocols contains a credential and must not be logged or reused for retries. */
export interface GatewayGrant { url: string; protocols: string[]; profileId: string; instanceId: string; version: string }
/** CLI owner policy: attach never starts an owner; start ensures one and recover requests owner recovery. */
export type AttachMode = 'start' | 'attach' | 'recover'

/**
 * Mint a fresh local gateway ticket through the same-user CLI. HermesAdapter.initialize and
 * HermesSession.connect await this before opening a socket; failures prevent that connection.
 * Resolve only after stdout EOF, successful exit, grant validation and child disposal. Abort or
 * timeout rejects and still disposes the child; cleanup failure can replace the result or error.
 * No work has been submitted by attach. The caller owns the subsequent WebSocket, not the CLI child.
 */
export async function attachGateway(options: HermesAdapterOptions, mode: AttachMode, signal?: AbortSignal): Promise<GatewayGrant> {
  if (signal?.aborted) throw new HarnessSdkError('RUNTIME_DISPOSED')
  const args = [...(options.args ?? []), ...(options.profile ? ['-p', options.profile] : []), 'gateway', 'attach', '--json',
    ...(mode === 'attach' ? [] : [`--${mode}`]), '--timeout', String(Math.max(1, Math.ceil((options.timeoutMs ?? 30_000) / 1000)))]
  const child = await (options.processFactory ?? spawnHarnessProcess)({ command: options.command ?? 'hermes', args, env: options.env })
  const stderr = drainAttachStderr(child.stderr, options)
  try {
    return await waitForGrant(child, options.timeoutMs ?? 30_000, signal)
  } catch (cause) {
    // Attach has not submitted any work, even when its read/validation fails.
    if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false)
    throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Hermes attach response')
  } finally {
    await child.dispose()
    await stderr
  }
}

/**
 * Validate the CLI's canonical local endpoint, owner identity and matching ticket subprotocols.
 * attachGateway returns this grant for connection; malformed data throws PROTOCOL_ERROR and
 * differing client/owner code hashes throw HERMES_GATEWAY_CODE_MISMATCH without exposing tickets.
 */
export function validateGrant(value: unknown): GatewayGrant {
  const data = object(value), endpoint = object(data.endpoint)
  if (!['ready', 'draining'].includes(String(data.state)) || data.protocol !== 'hermes-gateway-v1') throw protocolError()
  if (typeof data.client_code_sha === 'string' && typeof endpoint.code_sha === 'string' && data.client_code_sha !== endpoint.code_sha) {
    throw new HarnessSdkError('HERMES_GATEWAY_CODE_MISMATCH', 'Hermes gateway must be updated or restarted by its owner')
  }
  const address = gatewayAddress(data.url)
  const protocols = array(data.protocols).map(identity), ticket = identity(data.ticket)
  if (protocols.length !== 2 || protocols[0] !== data.protocol || protocols[1] !== `hermes-gateway-ticket.${ticket}`) throw protocolError()
  return { url: address.href, protocols, profileId: identity(endpoint.profile_id), instanceId: identity(endpoint.instance_id),
    version: typeof endpoint.code_sha === 'string' ? endpoint.code_sha : 'hermes-gateway-v1' }
}

/** Drain stderr concurrently so the CLI cannot block on its pipe; report only a fixed code and ignore drain failures. */
async function drainAttachStderr(stderr: AsyncIterable<Uint8Array>, options: HermesAdapterOptions): Promise<void> {
  try { for await (const chunk of stderr) if (chunk.byteLength) options.diagnostic?.('HERMES_ATTACH_STDERR') }
  catch { /* Protocol stdout and process exit determine the outcome. */ }
}

/** Race the response against attach cancellation, removing the timer/listener before the caller disposes the child. */
async function waitForGrant(child: HarnessProcess, timeoutMs: number, signal?: AbortSignal): Promise<GatewayGrant> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      readAttachGrant(child),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HarnessSdkError('HARNESS_UNAVAILABLE', 'Hermes gateway attach timed out', true)), timeoutMs) }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new HarnessSdkError('RUNTIME_DISPOSED'))
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

/** Read at most 64 KiB of strict UTF-8, then require successful CLI exit before trusting its JSON grant. */
async function readAttachGrant(child: HarnessProcess): Promise<GatewayGrant> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let output = '', bytes = 0
  for await (const chunk of child.stdout) {
    bytes += chunk.byteLength
    if (bytes > 64 * 1024) throw new HarnessSdkError('FRAME_TOO_LARGE')
    output += decoder.decode(chunk, { stream: true })
  }
  output += decoder.decode()
  const exit = await child.exited
  if (exit.code === 2) throw new HarnessSdkError('HERMES_GATEWAY_UNSUPPORTED', 'Hermes gateway attach is required')
  if (exit.code !== 0) throw new HarnessSdkError(exit.code === 3 ? 'HERMES_GATEWAY_UNSUPPORTED' : exit.code === 4 ? 'AUTHORIZATION_FAILED' : 'HARNESS_UNAVAILABLE', 'Hermes gateway attach failed', exit.code === 5)
  let result: unknown
  try { result = JSON.parse(output) } catch { throw protocolError() }
  return validateGrant(result)
}

/** Keep tickets on the loopback WebSocket path and out of URL credentials, query strings and fragments. */
function gatewayAddress(value: unknown): URL {
  let address: URL
  try { address = new URL(identity(value)) } catch { throw protocolError() }
  if (!['ws:', 'wss:'].includes(address.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname)
    || address.username || address.password || address.search || address.hash || address.pathname !== '/api/ws') throw protocolError()
  return address
}
