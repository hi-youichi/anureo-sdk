// Owns caller wait deadlines and cancellation; must not cancel or retry native execution.
import { HarnessSdkError } from './sdk-error';

/** Return whether an explicit caller timeout exceeds the supported timer range; entry points check before dispatch. Does not start work or throw. */
export function invalidWait(wait?: RequestOptions): boolean { return wait?.timeoutMs !== undefined && (!Number.isFinite(wait.timeoutMs) || wait.timeoutMs <= 0 || wait.timeoutMs > 0x7fffffff); }

/** Controls only a caller’s observation wait; abort/deadline never interrupt an accepted native operation. */
export interface RequestOptions {
  /** Stops this caller waiting; does not interrupt accepted native execution. */
  signal?: AbortSignal;
  /** Positive observation deadline in milliseconds; omission uses the operation default. */
  timeoutMs?: number;
}

/** Run operation once unless already aborted; resolve its result or reject on failure, abort or deadline. Owns and releases its timer/listener; late outcomes remain observed and native work is never cancelled. */
export function waitForRequest<T>(operation: () => Promise<T>, options: RequestOptions = {}, defaultTimeoutMs = 30_000): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new HarnessSdkError("REQUEST_ABORTED", "Request aborted before dispatch"));
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new HarnessSdkError("INVALID_PARAMS", "timeoutMs must be positive"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    /** Settle exactly one outcome and remove owned timer/listener so late native completion cannot resettle the caller. */
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    /** Mark a dispatched operation's observation as abandoned without cancelling native work. */
    const abort = () => finish(() => reject(new HarnessSdkError("REQUEST_ABORTED", "Request outcome is unknown after dispatch", false, true)));
    const timer = setTimeout(() => finish(() => reject(new HarnessSdkError("REQUEST_TIMEOUT", "Request outcome is unknown after dispatch", false, true))), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    // A synchronous throw is captured too. Late results are observed and cannot cause unhandled rejections.
    try { operation().then((value) => finish(() => resolve(value)), (cause) => finish(() => reject(cause))); }
    catch (cause) { finish(() => reject(cause)); }
  });
}
