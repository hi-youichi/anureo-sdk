// Defines privacy-safe SDK errors and normalization; must not schedule waits or perform cleanup.
/**
 * Public failure envelope for hosts and adapters. Session admission throws these errors and
 * sdkError preserves existing instances, including their details, for downstream failure handling.
 * Construction does not sanitize data: the producer must supply safe messages/details and mark
 * uncertain native outcomes so consumers can assess whether retrying might duplicate work.
 */
export class HarnessSdkError extends Error {
  /**
   * Hosts, adapters and SDK policy checks supply a code and optional safe diagnostics. Store them
   * without validation, cloning or I/O; creating an error neither retries work nor releases resources.
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
  /** Stable discriminator for consumers that cannot use instanceof across package boundaries. */
  readonly name = "HarnessSdkError";
}

/**
 * Normalize failures for SDK and adapter boundaries without I/O or cleanup. Return SDK errors by
 * identity, preserving their messages and metadata. For other objects, copy only a bounded uppercase
 * code and literal-true flags; discard messages/details and use the code as the message. Unrecognized
 * causes use fallback with retryable=false and the supplied outcomeUnknown default. An explicit
 * outcomeUnknown property overrides that default, even when its value is not true. Property
 * getters/proxy traps can throw to the caller.
 *
 * Called by:
 * - Session.onRequestFailed to choose recovery state and publish safe submission failure status.
 * - InteractionRegistry.deliverResponse to classify responder/publication failures before publishing an
 *   unknown outcome or rejecting waiters; the registry still owns publication and state transitions.
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
