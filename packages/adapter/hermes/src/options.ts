import type { HarnessProcess, HarnessProcessOptions } from '@anureo/sdk/process'

export interface HermesAdapterOptions {
  command?: string
  /** Arguments preceding Hermes CLI arguments, for a wrapper executable. */
  args?: string[]
  profile?: string
  /** Native toolset selection for new sessions; [] disables model tools. Omit to inherit the profile. */
  toolsets?: string[]
  /** Complete child environment; omitted means inherit. */
  env?: Record<string, string | undefined>
  startup?: 'start' | 'attach'
  timeoutMs?: number
  maxFrameBytes?: number
  maxBufferedBytes?: number
  maxEvents?: number
  maxPending?: number
  maxInteractions?: number
  maxExecutions?: number
  maxSubmissions?: number
  reconnectAttempts?: number
  reconnectDelayMs?: number
  maxOwnerRecoveriesPerMinute?: number
  processFactory?: (options: HarnessProcessOptions) => Promise<HarnessProcess>
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket
  /** Codes only; native stderr, tickets and RPC contents are never reported. */
  diagnostic?: (code: string) => void
}

export function validateOptions(options: HermesAdapterOptions): void {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    if (key.endsWith('Ms') || key.startsWith('max') || key === 'reconnectAttempts') {
      const minimum = ['reconnectAttempts', 'reconnectDelayMs', 'maxOwnerRecoveriesPerMinute'].includes(key) ? 0 : 1
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid Hermes option: ${key}`)
      if (key.endsWith('Ms') && value > 2_147_483_647) throw new Error(`Invalid Hermes option: ${key}`)
    }
  }
  if (options.toolsets !== undefined && (!Array.isArray(options.toolsets) || options.toolsets.some(value => typeof value !== 'string' || !value.trim() || value.includes('\0')))) throw new Error('Invalid Hermes toolsets')
  if (options.startup !== undefined && !['start', 'attach'].includes(options.startup)) throw new Error('Invalid Hermes startup mode')
  if (options.profile !== undefined && (!options.profile.trim() || options.profile.includes('\0'))) throw new Error('Invalid Hermes profile')
  if (options.command !== undefined && (typeof options.command !== 'string' || !options.command || options.command.includes('\0'))) throw new Error('Invalid Hermes command')
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.some(value => typeof value !== 'string' || value.includes('\0')))) throw new Error('Invalid Hermes arguments')
}
