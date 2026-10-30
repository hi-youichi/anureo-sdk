export class HarnessSdkError extends Error {
  readonly name = "HarnessSdkError";
  constructor(
    readonly code: string,
    message = code,
    readonly retryable = false,
    readonly outcomeUnknown = false,
    readonly details?: Record<string, unknown>,
  ) { super(message); }
}

export function sdkError(cause: unknown, fallback = "HARNESS_ERROR", outcomeUnknown = false): HarnessSdkError {
  if (cause instanceof HarnessSdkError) return cause;
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(cause.code)) {
    return new HarnessSdkError(cause.code, cause.code, "retryable" in cause && cause.retryable === true, "outcomeUnknown" in cause ? cause.outcomeUnknown === true : outcomeUnknown);
  }
  // Do not include raw backend errors: they may contain credentials or private answers.
  return new HarnessSdkError(fallback, fallback, false, outcomeUnknown);
}

export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }

/** Abort only stops waiting; it never resubmits or interrupts an accepted backend operation. */
export function waitForRequest<T>(operation: () => Promise<T>, options: RequestOptions = {}, defaultTimeoutMs = 30_000): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new HarnessSdkError("REQUEST_ABORTED", "Request aborted before dispatch"));
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new HarnessSdkError("INVALID_PARAMS", "timeoutMs must be positive"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new HarnessSdkError("REQUEST_ABORTED", "Request outcome is unknown after dispatch", false, true)));
    const timer = setTimeout(() => finish(() => reject(new HarnessSdkError("REQUEST_TIMEOUT", "Request outcome is unknown after dispatch", false, true))), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    // A synchronous throw is captured too. Late results are observed and cannot cause unhandled rejections.
    try { operation().then((value) => finish(() => resolve(value)), (cause) => finish(() => reject(cause))); }
    catch (cause) { finish(() => reject(cause)); }
  });
}
