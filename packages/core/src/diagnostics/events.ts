// Publishes catalog observations through host-configured logging and synchronous callbacks.
import { getLogger } from '@logtape/logtape'

/**
 * Observe a catalog operation's progress in LogTape or an onPhase callback. catalogPhase supplies
 * error classifications. Hosts publishing their own events are responsible for safe field values.
 */
export interface CatalogProbeEvent {
  /** Operation being observed; diagnostics do not enforce an order between phases. */
  phase: 'spawn' | 'handshake' | 'models' | 'dispose'
  /** catalogPhase reports cancelled when its signal is aborted at failure reporting, regardless of cause. */
  outcome: 'started' | 'success' | 'error' | 'cancelled'
  /**
   * Elapsed milliseconds. catalogPhase includes synchronous started delivery and measures before
   * delivering the terminal event. Started reports omit this field. LogTape receives rounded values.
   */
  durationMs?: number
  /** Safe allowlisted classification, never raw native error text. */
  errorCode?: string
  /** Native RPC classification. catalogPhase includes this when the failure supplies a numeric rpcCode. */
  nativeRpcCode?: number
}
/**
 * Configure observation and cancellation for a catalog probe. Codex and Claude catalog sessions
 * accept these options on prepare and listModels and retain responsibility for native cleanup.
 */
export interface CatalogProbeOptions {
  /** catalogPhase checks this before work, after fulfillment, and when choosing a failure outcome. */
  signal?: AbortSignal
  /**
   * Optional budget in milliseconds for the probe owner. In Codex, the options that start a
   * connection set its per-RPC timeout, defaulting to 10,000 ms. Hosts set their own deadlines
   * for Claude probes. The diagnostics helpers leave timeout enforcement to the probe owner.
   */
  timeoutMs?: number
  /**
   * Register an observer for this probe. emitCatalogPhase invokes it synchronously with the original
   * event after attempting to log. Synchronous throws are ignored and the host handles any
   * rejections from asynchronous callbacks.
   */
  onPhase?: (event: CatalogProbeEvent) => void
}
/**
 * Publish a catalog report whose fields are safe to disclose. Attempt to log the known fields, then
 * pass the original event to onPhase even if logging throws. Suppress synchronous observer throws.
 * Return after the synchronous calls, leaving any asynchronous work to sinks and observers.
 * catalogPhase calls this for its start and outcome reports. Hosts configure and dispose LogTape sinks.
 */
export function emitCatalogPhase(options: CatalogProbeOptions, event: CatalogProbeEvent): void {
  logCatalogPhase(event)
  try { options.onPhase?.(event) } catch { /* An observer failure must leave the probe outcome intact. */ }
}

const catalogLogger = getLogger(['anureo', 'catalog'])

/**
 * emitCatalogPhase calls this before its observer so callback mutation cannot change logged fields.
 * Route errors to error, cancellations to warning, and other outcomes to debug. Suppress projection
 * and logging failures so emitCatalogPhase can still invoke the observer.
 */
function logCatalogPhase(event: CatalogProbeEvent): void {
  try {
    const properties = catalogLogProperties(event)
    const message = 'catalog {phase} {outcome}'
    if (event.outcome === 'error') catalogLogger.error(message, properties)
    else if (event.outcome === 'cancelled') catalogLogger.warn(message, properties)
    else catalogLogger.debug(message, properties)
  } catch { /* Deliver the event to the observer even when logging fails. */ }
}

/**
 * Give logCatalogPhase only the fields intended for logging. Round duration on the copy so
 * observers still receive the original value. Reading the event can throw before logging.
 */
function catalogLogProperties(event: CatalogProbeEvent) {
  return {
    phase: event.phase,
    outcome: event.outcome,
    ...(event.durationMs === undefined ? {} : { durationMs: Math.round(event.durationMs) }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    ...(event.nativeRpcCode === undefined ? {} : { nativeRpcCode: event.nativeRpcCode }),
  }
}
