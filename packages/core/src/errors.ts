/**
 * Inspect SDK or adapter failures by code and outcome. Producers must supply safe messages and
 * details. Check outcomeUnknown before retrying an operation that may already have taken effect.
 */
export class HarnessSdkError extends Error {
  /**
   * Create a failure with an already-sanitized code, message and diagnostics. The message defaults
   * to the code, both flags default to false, and details are retained by reference.
   */
  constructor(
    /** Safe machine-readable failure code selected by the owning subsystem. */
    readonly code: string,
    /** Caller-safe message; never populate this with an unfiltered native cause. */
    message = code,
    /** Whether the operation’s safe failure policy permits a caller retry. */
    readonly retryable = false,
    /** Native acceptance/completion could not be established; retry may duplicate work. */
    readonly outcomeUnknown = false,
    /** Already-sanitized structured diagnostics supplied by the owning subsystem. */
    readonly details?: Record<string, unknown>,
  ) { super(message); }
  /** Error name used in diagnostics. */
  readonly name = "HarnessSdkError";
}

/**
 * Normalize a failure for SDK or adapter callers. Return existing HarnessSdkError instances by
 * identity. For other objects with a code matching A-Z followed by up to 80 uppercase letters,
 * digits or underscores, use the code as the message and copy only literal-true flags. A present
 * outcomeUnknown property on such an object overrides the supplied default. Other causes use
 * fallback (HARNESS_ERROR by default) as both code and message, with retryable false and the
 * supplied outcomeUnknown default. Supply a safe fallback. Property access can throw if the
 * cause has throwing getters or proxy traps.
 *
 * Called by:
 * - Session.onRequestFailed to choose recovery state and publish safe submission failure status.
 * - InteractionRegistry.deliverResponse to classify responder or publication failures for the
 *   interaction waiter and, during delivery, for publication of an unknown outcome.
 * - checkRelease in structured-output/errors to throw safe failures after cleanup attempts settle.
 * Public consumers can apply the same normalization; callers own propagation, retries and cleanup.
 */
export function sdkError(cause: unknown, fallback = "HARNESS_ERROR", outcomeUnknown = false): HarnessSdkError {
  if (cause instanceof HarnessSdkError) return cause;
  if (cause && typeof cause === "object" && "code" in cause
    && typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(cause.code)) {
    const code = cause.code;
    const message = cause.code;
    const retryable = "retryable" in cause && cause.retryable === true;
    const resolvedOutcomeUnknown = "outcomeUnknown" in cause ? cause.outcomeUnknown === true : outcomeUnknown;
    return new HarnessSdkError(
      code,
      message,
      retryable,
      resolvedOutcomeUnknown,
    );
  }
  // Do not include raw backend errors: they may contain credentials or private answers.
  return new HarnessSdkError(fallback, fallback, false, outcomeUnknown);
}
