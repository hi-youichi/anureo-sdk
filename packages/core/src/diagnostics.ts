// Observes catalog work while probe owners retain native resources and cleanup.
import { emitCatalogPhase, type CatalogProbeEvent, type CatalogProbeOptions } from './diagnostics/events'
import { readNativeRpcCode, safeCatalogErrorCode } from './diagnostics/errors'

export { emitCatalogPhase } from './diagnostics/events'
export type { CatalogProbeEvent, CatalogProbeOptions } from './diagnostics/events'
export { safeCatalogErrorCode } from './diagnostics/errors'

/**
 * Run one catalog phase and report its start and outcome. Deliver started before checking the
 * signal, then invoke work at most once. Check cancellation again after work fulfills. Cancellation
 * at either check rejects with RPC_ABORTED. While work is pending, the phase waits for it to settle.
 * Resolve with the work value after success delivery, or reject with the original synchronous throw
 * or promise rejection after failure delivery, including when that outcome is cancelled.
 *
 * The probe owner enforces deadlines, interrupts native work if needed, and releases resources
 * even when the phase discards a successful result. Logger and synchronous observer failures are
 * isolated. A cause or signal property that throws during failure reporting prevents terminal
 * delivery and becomes the rejection.
 *
 * The Codex and Claude catalog sessions await the spawn and handshake phases during preparation and
 * return the models phase value from listModels. Session users must await dispose after use.
 */
export async function catalogPhase<T>(options: CatalogProbeOptions, phase: CatalogProbeEvent['phase'], work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  emitCatalogPhase(options, { phase, outcome: 'started' })
  try {
    throwIfCatalogAborted(options.signal)
    const result = await work()
    throwIfCatalogAborted(options.signal)
    emitCatalogPhase(options, { phase, outcome: 'success', durationMs: performance.now() - started })
    return result
  } catch (cause) {
    reportCatalogFailure(options, phase, started, cause)
    throw cause
  }
}

/** Throw RPC_ABORTED at catalogPhase's pre/post-work checks so an aborted probe cannot publish success. */
function throwIfCatalogAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error('RPC_ABORTED'), { code: 'RPC_ABORTED' })
}

/**
 * Publish catalogPhase's failure report after classifying the cause, then let catalogPhase rethrow
 * that cause. Classify before sampling cancellation so the outcome reflects the signal at reporting
 * time. If classification or sampling throws, that failure escapes before a report is delivered.
 */
function reportCatalogFailure(
  options: CatalogProbeOptions,
  phase: CatalogProbeEvent['phase'],
  startedAt: number,
  cause: unknown,
): void {
  const errorCode = safeCatalogErrorCode(cause)
  const nativeRpcCode = readNativeRpcCode(cause)
  emitCatalogPhase(options, {
    phase,
    outcome: options.signal?.aborted ? 'cancelled' : 'error',
    durationMs: performance.now() - startedAt,
    errorCode,
    ...(nativeRpcCode === undefined ? {} : { nativeRpcCode }),
  })
}
