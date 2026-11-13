// Owns caller wait deadlines and cancellation; must not cancel or retry native execution.
import { HarnessSdkError } from './errors';
import type { RequestOptions } from './types';

/**
 * Client.initialize/validateOpen and Session.submitExecution/request/closeRequest use this result to
 * reject INVALID_PARAMS before dispatch. Return true for explicit non-finite, non-positive or
 * out-of-range timer durations; omitted timeouts use caller defaults and are not checked here.
 * Positive fractions remain valid. This predicate neither dispatches nor allocates wait resources.
 */
export function invalidWait(wait?: RequestOptions): boolean {
  return wait?.timeoutMs !== undefined
    && (!Number.isFinite(wait.timeoutMs) || wait.timeoutMs <= 0 || wait.timeoutMs > 0x7fffffff);
}

/**
 * Bound one observation for public SDK/adapter consumers. Reject a pre-aborted signal before checking
 * the effective timeout, then reject a non-finite/non-positive timeout before invoking operation.
 * Otherwise invoke operation synchronously once and forward its value or original failure, including
 * synchronous throws. Abort/deadline after admission rejects with outcomeUnknown=true. Remove the
 * owned timer/listener before settlement while continuing to observe late operation rejection.
 *
 * Called by:
 * - Client.initialize/open to await negotiation/attachment; open and the createClient factory own
 *   failure cleanup, while direct initialize callers retain disposal responsibility.
 * - Session.submitExecution to await binding, request to await receipts, and closeRequest to observe
 *   shared close/cleanup work. Those owners retain admitted work after the caller stops waiting.
 * - Turn.result to observe the shared terminal snapshot independently of sibling handles.
 * - InteractionRegistry.respond/cancel to bound the supplied native responder before publishing its
 *   settlement; those methods translate failures into interaction outcomes.
 * The caller owns native cancellation, retries and resource release; this helper performs none.
 */
export function waitForRequest<T>(operation: () => Promise<T>, options: RequestOptions = {}, defaultTimeoutMs = 30_000): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new HarnessSdkError("REQUEST_ABORTED", "Request aborted before dispatch"));
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new HarnessSdkError("INVALID_PARAMS", "timeoutMs must be positive"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    /**
     * The operation continuations and abandon call this with the caller's settlement callback.
     * Release wait resources before delivering the first outcome; ignore subsequent outcomes without
     * detaching the operation's rejection observer. Native work/resources remain caller-owned.
     */
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    /**
     * The abort listener and deadline callback use the same unknown-outcome policy. Reject only the
     * caller's observation through finish, which releases the timer/listener; never cancel operation.
     */
    const abandon = (code: "REQUEST_ABORTED" | "REQUEST_TIMEOUT") => {
      finish(() => reject(new HarnessSdkError(code, "Request outcome is unknown after dispatch", false, true)));
    };
    /** The caller signal invokes this listener; finish removes this same reference on any settlement. */
    const abort = () => abandon("REQUEST_ABORTED");
    const timer = setTimeout(() => abandon("REQUEST_TIMEOUT"), timeoutMs);
    // Install before invoking operation: it may synchronously trigger the caller's abort signal.
    options.signal?.addEventListener("abort", abort, { once: true });
    // Keep the rejection handler attached after abandonment so late failures stay observed.
    try {
      operation().then(
        (value) => finish(() => resolve(value)),
        (cause) => finish(() => reject(cause)),
      );
    } catch (cause) { finish(() => reject(cause)); }
  });
}
