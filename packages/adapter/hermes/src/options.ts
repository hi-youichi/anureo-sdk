import type { HarnessProcess, HarnessProcessOptions } from '@anureo/sdk/process'

/**
 * Configure createHermesAdapter's local CLI attachment, gateway channel and session budgets.
 * Numeric values must be safe integers; limits and timeouts are positive except the explicitly
 * zero-enabled recovery settings below. Millisecond values must fit a signed 32-bit timer.
 */
export interface HermesAdapterOptions {
  /** Hermes executable or wrapper; defaults to 'hermes'. Must be nonempty and contain no NUL. */
  command?: string
  /** Arguments preceding Hermes CLI arguments, for a wrapper executable; entries must contain no NUL. */
  args?: string[]
  /** CLI profile selection; omit to use the CLI default. Must contain non-whitespace text and no NUL. */
  profile?: string
  /** Native toolsets for new sessions; [] disables model tools. Omit to inherit the profile. Names must be nonblank and contain no NUL. */
  toolsets?: string[]
  /** Complete child environment; omitted means inherit. */
  env?: Record<string, string | undefined>
  /** Defaults to start, which ensures a shared owner. attach only connects and disables owner recovery. */
  startup?: 'start' | 'attach'
  /** Separate deadline for each CLI attach, WebSocket open and RPC response; defaults to 30,000 ms. */
  timeoutMs?: number
  /** Maximum UTF-8 frame/queued-entry bytes; defaults to 8 MiB. CLI attach stdout has its own 64 KiB cap. */
  maxFrameBytes?: number
  /** Byte budget for socket backlog and, separately, incoming buffers, retained inputs and each turn's items; defaults to 16 MiB. */
  maxBufferedBytes?: number
  /** Maximum buffered incoming events/requests, including those held for replay; defaults to 2048. */
  maxEvents?: number
  /** Maximum outstanding RPC requests per channel; defaults to 128. */
  maxPending?: number
  /** Maximum unresolved interactions per session; defaults to 32. Settled identities are retained separately. */
  maxInteractions?: number
  /** Maximum retained executions per session; defaults to 128. Eligible terminal executions are evicted first. */
  maxExecutions?: number
  /** Maximum retained submissions per session; defaults to 1024. Eligible acknowledged submissions are evicted first. */
  maxSubmissions?: number
  /** Attempts per session recovery cycle; defaults to 3. Zero disables automatic recovery. */
  reconnectAttempts?: number
  /** Base retry delay in ms, doubled after each delayed attempt; defaults to 100. First attempt is immediate; zero selects a zero-ms delay. */
  reconnectDelayMs?: number
  /** Owner recovery requests per session in a rolling minute; defaults to 2. Zero prohibits owner recovery. */
  maxOwnerRecoveriesPerMinute?: number
  /** Replace CLI spawning; resolve with usable pipes/exit observation. Attach drains output and awaits the handle's disposal on every outcome. */
  processFactory?: (options: HarnessProcessOptions) => Promise<HarnessProcess>
  /** Replace WebSocket construction; return a standard event-capable socket. The adapter owns closure; protocols includes a private ticket. */
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket
  /** Synchronous diagnostic sink; should not throw. Receives codes only, never native stderr, tickets or RPC contents. */
  diagnostic?: (code: string) => void
}

/** Validate configuration synchronously; HermesAdapter's constructor converts failures to INVALID_PARAMS before starting resources. */
export function validateOptions(options: HermesAdapterOptions): void {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    if (key.endsWith('Ms') || key.startsWith('max') || key === 'reconnectAttempts') {
      validateNumericOption(key, value)
    }
  }
  if (options.toolsets !== undefined && (!Array.isArray(options.toolsets) || options.toolsets.some(value => typeof value !== 'string' || !value.trim() || value.includes('\0')))) throw new Error('Invalid Hermes toolsets')
  if (options.startup !== undefined && !['start', 'attach'].includes(options.startup)) throw new Error('Invalid Hermes startup mode')
  if (options.profile !== undefined && (!options.profile.trim() || options.profile.includes('\0'))) throw new Error('Invalid Hermes profile')
  if (options.command !== undefined && (typeof options.command !== 'string' || !options.command || options.command.includes('\0'))) throw new Error('Invalid Hermes command')
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.some(value => typeof value !== 'string' || value.includes('\0')))) throw new Error('Invalid Hermes arguments')
}

/** Allow zero only for recovery controls; keep configured millisecond values within the native timer range. */
function validateNumericOption(key: string, value: unknown): void {
  const minimum = ['reconnectAttempts', 'reconnectDelayMs', 'maxOwnerRecoveriesPerMinute'].includes(key) ? 0 : 1
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid Hermes option: ${key}`)
  if (key.endsWith('Ms') && value > 2_147_483_647) throw new Error(`Invalid Hermes option: ${key}`)
}
