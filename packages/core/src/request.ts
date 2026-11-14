// Owns caller deadlines and cancellation for observing one operation.
import { HarnessSdkError } from './errors';
import type { RequestOptions } from './types';

/**
 * Package-internal validation of explicit Client and Session wait durations in milliseconds.
 * Return true for non-finite, non-positive or above 2_147_483_647. Omission and positive fractions
 * within the limit pass. Client.initialize and Client.validateOpen throw INVALID_PARAMS on
 * failure. Session.request, Session.submitExecution and Session.closeRequest return a rejection.
 */
export function invalidWait(wait?: RequestOptions): boolean {
  return wait?.timeoutMs !== undefined
    && (!Number.isFinite(wait.timeoutMs) || wait.timeoutMs <= 0 || wait.timeoutMs > 0x7fffffff);
}

/**
 * Await one operation with a caller-scoped deadline and optional abort signal.
 * A pre-aborted signal rejects with REQUEST_ABORTED before timeout validation or invocation.
 * A nullish timeout uses defaultTimeoutMs, which defaults to 30,000 ms. A non-finite or non-positive
 * effective timeout rejects with INVALID_PARAMS. Rounding and timer range follow the host timer.
 * The operation is invoked synchronously once. Its value or original failure, including a
 * synchronous throw, settles the wait if it wins the race. Abort or expiry after invocation
 * rejects with REQUEST_ABORTED or REQUEST_TIMEOUT and outcomeUnknown=true. Keep options.signal
 * stable until settlement so the wait can remove its listener. Settlement clears the timer and
 * the operation's rejection remains observed. Callers own any native cancellation, resource
 * release or decision to retry.
 *
 * Turn.result returns this wait for the shared terminal snapshot. Session.submitExecution
 * returns it for execution binding after dispatch, and Session.closeRequest uses it to
 * observe close and backend cleanup.
 * InteractionRegistry.deliverResponse and cancelPending await the supplied native responder and
 * translate failures into interaction outcomes. AcpAdapter.call returns the native result or
 * normalizes the rejection while preserving SDK errors.
 */
export function waitForRequest<T>(operation: () => Promise<T>, options: RequestOptions = {}, defaultTimeoutMs = 30_000): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new HarnessSdkError("REQUEST_ABORTED", "Request aborted before dispatch"));
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new HarnessSdkError("INVALID_PARAMS", "timeoutMs must be positive"));
  return observeRequest({ operation, options, timeoutMs });
}

/**
 * Dispatch the operation after waitForRequest validates admission. Own the timer and listener
 * for this promise and attach the operation's continuations even if invocation triggers abort.
 */
function observeRequest<T>({ operation, options, timeoutMs }: {
  operation: () => Promise<T>;
  options: RequestOptions;
  timeoutMs: number;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    /**
     * The operation continuations and abandon release wait resources before delivering the first
     * outcome. Later outcomes leave the original settlement intact.
     */
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    /**
     * The abort listener and deadline callback reject the same wait with an unknown outcome.
     * Build the error only if this callback wins settlement.
     */
    const abandon = (code: "REQUEST_ABORTED" | "REQUEST_TIMEOUT") => {
      finish(() => reject(new HarnessSdkError(code, "Request outcome is unknown after dispatch", false, true)));
    };
    /** The caller signal invokes this listener; finish removes this same reference on any settlement. */
    const abort = () => abandon("REQUEST_ABORTED");
    /** Forward invocation failures and promise rejections through the same cleanup. */
    const rejectOperation = (cause: unknown) => finish(() => reject(cause));

    const timer = setTimeout(() => abandon("REQUEST_TIMEOUT"), timeoutMs);
    // Install before invoking operation: it may synchronously trigger the caller's abort signal.
    options.signal?.addEventListener("abort", abort, { once: true });
    // Keep the rejection handler attached after abandonment so late failures stay observed.
    try {
      operation().then((value) => finish(() => resolve(value)), rejectOperation);
    } catch (cause) {
      rejectOperation(cause);
    }
  });
}
