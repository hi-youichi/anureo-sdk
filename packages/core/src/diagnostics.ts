// Observes catalog work while probe owners retain native resources and cleanup.
import { emitCatalogPhase, type CatalogProbeEvent, type CatalogProbeOptions } from './diagnostics/events'
import { readNativeRpcCode, safeCatalogErrorCode } from './diagnostics/errors'

export { emitCatalogPhase } from './diagnostics/events'
export type { CatalogProbeEvent, CatalogProbeOptions } from './diagnostics/events'
export { safeCatalogErrorCode } from './diagnostics/errors'

/**
 * Observe an adapter's catalog probe and resolve with its value after reporting success, or reject
 * with its original failure after reporting it. Emit started before checking cancellation, await work,
 * then check cancellation again before reporting success. An aborted signal skips work or discards
 * its successful result with an RPC_ABORTED rejection; cancellation never interrupts pending work.
 * A failed work promise retains its cause even when the signal is aborted (the report is cancelled).
 *
 * The probe owner must enforce deadlines and release native resources, including when cancellation
 * discards a result. Logger and synchronous observer failures are isolated. Failures reading cause
 * or signal properties can replace the rejection and prevent a terminal report.
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
    const code = safeCatalogErrorCode(cause)
    const nativeRpcCode = readNativeRpcCode(cause)
    emitCatalogPhase(options, {
      phase,
      outcome: options.signal?.aborted ? 'cancelled' : 'error',
      durationMs: performance.now() - started,
      errorCode: code,
      ...(nativeRpcCode === undefined ? {} : { nativeRpcCode }),
    })
    throw cause
  }
}

/** Throw RPC_ABORTED at catalogPhase's pre/post-work checks so an aborted probe cannot publish success. */
function throwIfCatalogAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error('RPC_ABORTED'), { code: 'RPC_ABORTED' })
}
