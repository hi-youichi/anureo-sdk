import { HarnessSdkError } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import type { HermesAdapterOptions } from './options'
import { array, GATEWAY_PROTOCOL, identity, object, protocolError } from './native'

/** Validated CLI evidence for one local WebSocket connection. */
export interface GatewayGrant {
  url: string
  /** Wire protocol followed by the credential subprotocol. Keep private and mint a fresh grant for each retry. */
  protocols: string[]
  profileId: string
  instanceId: string
  /** Owner code hash when supplied, otherwise the wire protocol version. */
  version: string
}
/** CLI owner policy. Attach uses an existing owner, start ensures one, and recover requests owner recovery. */
export type AttachMode = 'start' | 'attach' | 'recover'

/**
 * Mint a fresh local gateway ticket through the same-user CLI. HermesAdapter.probeRuntime and
 * HermesSession.connect await this before opening a socket; failures prevent that connection.
 * Resolve after stdout EOF, successful exit, grant validation, child disposal and stderr drain.
 * A pre-aborted signal prevents spawning. While awaiting the grant, abort rejects with
 * RUNTIME_DISPOSED and timeout rejects with retryable HARNESS_UNAVAILABLE. Both dispose the child.
 * Spawn or cleanup failures can propagate directly. Attach submits no work and the caller owns
 * the subsequent WebSocket.
 */
export async function attachGateway(options: HermesAdapterOptions, mode: AttachMode, signal?: AbortSignal): Promise<GatewayGrant> {
  if (signal?.aborted) throw new HarnessSdkError('RUNTIME_DISPOSED')
  const args = attachArguments(options, mode)
  const child = await (options.processFactory ?? spawnHarnessProcess)({
    command: options.command ?? 'hermes',
    args,
    env: options.env,
  })
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
  const data = object(value)
  const endpoint = object(data.endpoint)
  if (!['ready', 'draining'].includes(String(data.state)) || data.protocol !== GATEWAY_PROTOCOL) throw protocolError()
  if (typeof data.client_code_sha === 'string' && typeof endpoint.code_sha === 'string' && data.client_code_sha !== endpoint.code_sha) {
    throw new HarnessSdkError('HERMES_GATEWAY_CODE_MISMATCH', 'Hermes gateway must be updated or restarted by its owner')
  }
  const address = gatewayAddress(data.url)
  const protocols = array(data.protocols).map(identity)
  const ticket = identity(data.ticket)
  if (protocols.length !== 2 || protocols[0] !== data.protocol || protocols[1] !== `hermes-gateway-ticket.${ticket}`) throw protocolError()
  return {
    url: address.href,
    protocols,
    profileId: identity(endpoint.profile_id),
    instanceId: identity(endpoint.instance_id),
    version: typeof endpoint.code_sha === 'string' ? endpoint.code_sha : GATEWAY_PROTOCOL,
  }
}

/** Leave owner policy implicit for attach-only and round up for the CLI's whole-second timeout. */
function attachArguments(options: HermesAdapterOptions, mode: AttachMode): string[] {
  return [
    ...(options.args ?? []),
    ...(options.profile ? ['-p', options.profile] : []),
    'gateway', 'attach', '--json',
    ...(mode === 'attach' ? [] : [`--${mode}`]),
    '--timeout', String(Math.max(1, Math.ceil((options.timeoutMs ?? 30_000) / 1000))),
  ]
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
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HarnessSdkError('HARNESS_UNAVAILABLE', 'Hermes gateway attach timed out', true)), timeoutMs)
      }),
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

/** Read at most 64 KiB of strict UTF-8 through EOF before trusting a successful CLI exit and parsing its grant. */
async function readAttachGrant(child: HarnessProcess): Promise<GatewayGrant> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let output = ''
  let bytes = 0
  for await (const chunk of child.stdout) {
    bytes += chunk.byteLength
    if (bytes > 64 * 1024) throw new HarnessSdkError('FRAME_TOO_LARGE')
    output += decoder.decode(chunk, { stream: true })
  }
  output += decoder.decode()
  assertAttachExit(await child.exited)
  let result: unknown
  try { result = JSON.parse(output) } catch { throw protocolError() }
  return validateGrant(result)
}

/** Reject unsuccessful CLI exits using safe messages. Only exit 5 represents a retryable failure. */
function assertAttachExit({ code }: Awaited<HarnessProcess['exited']>): void {
  if (code === 0) return
  if (code === 2) throw new HarnessSdkError('HERMES_GATEWAY_UNSUPPORTED', 'Hermes gateway attach is required')
  const failure = code === 3 ? 'HERMES_GATEWAY_UNSUPPORTED' : code === 4 ? 'AUTHORIZATION_FAILED' : 'HARNESS_UNAVAILABLE'
  throw new HarnessSdkError(failure, 'Hermes gateway attach failed', code === 5)
}

/** Keep tickets on the loopback WebSocket path and out of URL credentials, query strings and fragments. */
function gatewayAddress(value: unknown): URL {
  let address: URL
  try { address = new URL(identity(value)) } catch { throw protocolError() }
  if (!['ws:', 'wss:'].includes(address.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname)
    || address.username || address.password || address.search || address.hash || address.pathname !== '/api/ws') throw protocolError()
  return address
}
