import type { PiHostFactory } from './host'

/** Configure Pi host acquisition, persistence and history for createPiAdapter. */
export interface PiAdapterOptions {
  /** Trusted Pi SDK version. Omit to report `unknown` and use the baseline profile for any host. */
  version?: string
  /** Open an owned host for the adapter to dispose. Defaults to the in-process Pi host. */
  createHost?: PiHostFactory
  /** Override Pi's global configuration directory. Omit or pass an empty string to use the host default. */
  agentDir?: string
  /** Override the directory for persisted session files. Omitting it or passing an empty string leaves selection to the host. */
  sessionDir?: string
  /** Allow disk persistence when the version profile supports resume. Defaults to true. */
  persistSessions?: boolean
  /** Literal secrets to redact in mapped message and tool content and history. Empty strings are ignored. */
  secrets?: string[]
  /** Number of most recent history items retained per snapshot. Defaults to 5000. Zero retains all. */
  maxHistoryItems?: number
  /** Currently unused; the adapter does not invoke this callback. */
  diagnostic?: (code: string) => void
}
