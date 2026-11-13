// Publishes catalog observations through host-configured logging and synchronous callbacks.
import { getLogger } from '@logtape/logtape'

/**
 * Phase timing report delivered to host observers and LogTape by emitCatalogPhase. catalogPhase
 * supplies safe classifications; hosts emitting their own reports must keep all fields safe.
 */
export interface CatalogProbeEvent {
  phase: 'spawn' | 'handshake' | 'models' | 'dispose'
  outcome: 'started' | 'success' | 'error' | 'cancelled'
  /** Elapsed milliseconds including started notification time; absent on started, rounded only in logs. */
  durationMs?: number
  /** Safe allowlisted classification, never raw native error text. */
  errorCode?: string
  /** Numeric native RPC classification when present on the original failure. */
  nativeRpcCode?: number
}
/**
 * Observation settings supplied by an adapter or host running catalog probes. catalogPhase observes
 * cancellation; both diagnostics helpers leave timeout enforcement and native cleanup to the owner.
 */
export interface CatalogProbeOptions {
  /** Probe-owner cancellation signal; checked immediately before and after work. */
  signal?: AbortSignal
  /** Optional timeout budget in milliseconds for the probe owner; ignored by diagnostics helpers. */
  timeoutMs?: number
  /** Called synchronously after logging each event; throws are ignored and promises are not awaited. */
  onPhase?: (event: CatalogProbeEvent) => void
}
/**
 * Publish an already-safe catalog report: synchronously log its known fields, then pass the original
 * event to the supplied onPhase observer. Logger failures do not prevent the callback, and callback
 * throws are suppressed. Codes are not sanitized here; direct callers must supply safe fields.
 * catalogPhase uses this for started and terminal notifications. Hosts own LogTape sink configuration
 * and disposal; this function neither configures logging nor waits for sinks or async observers.
 */
export function emitCatalogPhase(options: CatalogProbeOptions, event: CatalogProbeEvent): void {
  logCatalogPhase(event)
  try { options.onPhase?.(event) } catch { /* Diagnostics never own execution. */ }
}

/** Logger used by logCatalogPhase; host configuration owns sinks and their lifetime. */
const catalogLogger = getLogger(['anureo', 'catalog'])

/**
 * emitCatalogPhase calls this before its observer so callback mutation cannot change logged fields.
 * Copy known fields, round milliseconds, and use error/warning/debug for error/cancelled/other
 * outcomes. Caller-supplied codes are trusted; suppress logging failures so observation can continue.
 */
function logCatalogPhase(event: CatalogProbeEvent): void {
  try {
    const properties = {
      phase: event.phase,
      outcome: event.outcome,
      ...(event.durationMs === undefined ? {} : { durationMs: Math.round(event.durationMs) }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      ...(event.nativeRpcCode === undefined ? {} : { nativeRpcCode: event.nativeRpcCode }),
    }
    if (event.outcome === 'error') catalogLogger.error('catalog {phase} {outcome}', properties)
    else if (event.outcome === 'cancelled') catalogLogger.warn('catalog {phase} {outcome}', properties)
    else catalogLogger.debug('catalog {phase} {outcome}', properties)
  } catch { /* Logging never owns execution either. */ }
}
