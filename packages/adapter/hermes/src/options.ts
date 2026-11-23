import type { HarnessProcess, HarnessProcessOptions } from '@anureo/sdk/process'

export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Configure createHermesAdapter's local CLI attachment, gateway channel and session budgets.
 * Numeric values must be safe integers; limits and timeouts are positive except the explicitly
 * zero-enabled recovery settings below. Millisecond values must fit a signed 32-bit timer.
 */
export interface HermesAdapterOptions {
  /** Enable the optional SDK MCP output bridge on new sessions (default true).
   * Disable when persistent native sessions must outlive the observing client's bridge. */
  outputBridge?: boolean
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
  /** Defaults to start, which ensures a shared owner. attach uses an existing owner even during reconnects. */
  startup?: 'start' | 'attach'
  /** Separate deadline in ms for CLI response after spawn, WebSocket open and each RPC response. Defaults to 30,000. */
  timeoutMs?: number
  /** Maximum UTF-8 frame/queued-entry bytes; defaults to 8 MiB. CLI attach stdout has its own 64 KiB cap. */
  maxFrameBytes?: number
  /** Byte budget for socket backlog and, separately, incoming buffers, retained inputs and each turn's items; defaults to 16 MiB. */
  maxBufferedBytes?: number
  /** Separate count limit for the incoming queue and traffic held during setup or recovery. Defaults to 2048 each. */
  maxEvents?: number
  /** Maximum outstanding RPC requests per channel; defaults to 128. */
  maxPending?: number
  /** Maximum unresolved interactions per session; defaults to 32. Settled identities are retained separately. */
  maxInteractions?: number
  /** Maximum retained executions per session; defaults to 128. Eligible terminal executions are evicted first. */
  maxExecutions?: number
  /** Maximum retained submissions per session; defaults to 1024. Eligible acknowledged submissions are evicted first. */
  maxSubmissions?: number
  /** Attempts per session recovery cycle, including the first attach-only attempt. Defaults to 3. Zero disables automatic recovery. */
  reconnectAttempts?: number
  /** Base retry delay in ms, doubled after each delayed attempt; defaults to 100. First attempt is immediate; zero selects a zero-ms delay. */
  reconnectDelayMs?: number
  /** Owner recovery requests per session in a rolling minute; defaults to 2. Zero prohibits owner recovery. */
  maxOwnerRecoveriesPerMinute?: number
  /**
   * Replace CLI spawning for each ticket request. Resolve with usable pipes and exit observation
   * and release partial resources on rejection. The adapter takes ownership of the returned
   * handle and awaits its disposal, including when attachment fails.
   */
  processFactory?: (options: HarnessProcessOptions) => Promise<HarnessProcess>
  /**
   * Replace WebSocket construction for each ticket. Return a socket that implements the standard
   * WebSocket interface. Keep the credential subprotocol private. The adapter owns socket closure.
   */
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket
  /**
   * Receive fixed diagnostic codes synchronously when attach reports stderr or session detach
   * cannot be confirmed. Return normally so detach cleanup can proceed.
   */
  diagnostic?: (code: string) => void
}

/** Collect configuration issues without retaining option values. */
export function validateOptions(options: HermesAdapterOptions): string[] {
  if (options === null) return ['options must be an object']
  const issues: string[] = []
  if (options.outputBridge !== undefined && typeof options.outputBridge !== 'boolean') issues.push('outputBridge must be a boolean')
  for (const key of ['timeoutMs', 'maxFrameBytes', 'maxBufferedBytes', 'maxEvents', 'maxPending',
    'maxInteractions', 'maxExecutions', 'maxSubmissions', 'reconnectAttempts', 'reconnectDelayMs',
    'maxOwnerRecoveriesPerMinute'] as const) {
    const value = options[key]
    if (value === undefined) continue
    const allowsZero = key === 'reconnectAttempts' || key === 'reconnectDelayMs' || key === 'maxOwnerRecoveriesPerMinute'
    const isTimer = key === 'timeoutMs' || key === 'reconnectDelayMs'
    if (!Number.isSafeInteger(value) || value < (allowsZero ? 0 : 1) || (isTimer && value > 2_147_483_647)) {
      issues.push(`${key} must be a ${allowsZero ? 'nonnegative' : 'positive'} safe integer${isTimer ? ' at most 2147483647' : ''}`)
    }
  }
  if (options.toolsets !== undefined && (!Array.isArray(options.toolsets)
    || options.toolsets.some(value => typeof value !== 'string' || !value.trim() || value.includes('\0')))) {
    issues.push('toolsets must be an array of nonblank strings without NUL')
  }
  if (options.startup !== undefined && options.startup !== 'start' && options.startup !== 'attach') {
    issues.push('startup must be start or attach')
  }
  if (options.profile !== undefined && (typeof options.profile !== 'string' || !options.profile.trim() || options.profile.includes('\0'))) {
    issues.push('profile must be a nonblank string without NUL')
  }
  if (options.command !== undefined && (typeof options.command !== 'string' || !options.command || options.command.includes('\0'))) {
    issues.push('command must be a nonempty string without NUL')
  }
  if (options.args !== undefined && (!Array.isArray(options.args)
    || options.args.some(value => typeof value !== 'string' || value.includes('\0')))) {
    issues.push('args must be an array of strings without NUL')
  }
  return issues
}

/** Canonical Hermes reasoning requests; the native route determines its wire mapping. */
export const HERMES_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export function isHermesEffort(value: unknown): value is string {
  return typeof value === 'string' && (HERMES_EFFORTS as readonly string[]).includes(value)
}
