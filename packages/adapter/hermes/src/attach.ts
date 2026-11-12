import { HarnessSdkError } from '@anureo/sdk'
import { spawnHarnessProcess } from '@anureo/sdk/process'
import type { HermesAdapterOptions } from './options'
import { array, identity, object, protocolError } from './native'

export interface GatewayGrant { url: string; protocols: string[]; profileId: string; instanceId: string; version: string }
export type AttachMode = 'start' | 'attach' | 'recover'

/** The CLI is the cross-platform, same-user authority for minting a fresh ticket. */
export async function attachGateway(options: HermesAdapterOptions, mode: AttachMode, signal?: AbortSignal): Promise<GatewayGrant> {
  if (signal?.aborted) throw new HarnessSdkError('RUNTIME_DISPOSED')
  const args = [...(options.args ?? []), ...(options.profile ? ['-p', options.profile] : []), 'gateway', 'attach', '--json',
    ...(mode === 'attach' ? [] : [`--${mode}`]), '--timeout', String(Math.max(1, Math.ceil((options.timeoutMs ?? 30_000) / 1000)))]
  const child = await (options.processFactory ?? spawnHarnessProcess)({ command: options.command ?? 'hermes', args, env: options.env })
  const stderr = (async () => {
    try { for await (const chunk of child.stderr) if (chunk.byteLength) options.diagnostic?.('HERMES_ATTACH_STDERR') }
    catch { /* Protocol stdout and process exit determine the outcome. */ }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      (async () => {
        const decoder = new TextDecoder('utf-8', { fatal: true }); let output = '', bytes = 0
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
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HarnessSdkError('HARNESS_UNAVAILABLE', 'Hermes gateway attach timed out', true)), options.timeoutMs ?? 30_000) }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new HarnessSdkError('RUNTIME_DISPOSED'))
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      }),
    ])
  } catch (cause) {
    // Attach has not submitted any work, even when its read/validation fails.
    if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false)
    throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Hermes attach response')
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
    await child.dispose()
    await stderr
  }
}

export function validateGrant(value: unknown): GatewayGrant {
  const data = object(value), endpoint = object(data.endpoint)
  if (!['ready', 'draining'].includes(String(data.state)) || data.protocol !== 'hermes-gateway-v1') throw protocolError()
  if (typeof data.client_code_sha === 'string' && typeof endpoint.code_sha === 'string' && data.client_code_sha !== endpoint.code_sha) {
    throw new HarnessSdkError('HERMES_GATEWAY_CODE_MISMATCH', 'Hermes gateway must be updated or restarted by its owner')
  }
  let address: URL
  try { address = new URL(identity(data.url)) } catch { throw protocolError() }
  if (!['ws:', 'wss:'].includes(address.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname)
    || address.username || address.password || address.search || address.hash || address.pathname !== '/api/ws') throw protocolError()
  const protocols = array(data.protocols).map(identity), ticket = identity(data.ticket)
  if (protocols.length !== 2 || protocols[0] !== data.protocol || protocols[1] !== `hermes-gateway-ticket.${ticket}`) throw protocolError()
  return { url: address.href, protocols, profileId: identity(endpoint.profile_id), instanceId: identity(endpoint.instance_id),
    version: typeof endpoint.code_sha === 'string' ? endpoint.code_sha : 'hermes-gateway-v1' }
}
