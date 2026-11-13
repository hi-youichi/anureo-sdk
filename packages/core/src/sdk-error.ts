// Defines privacy-safe SDK errors and normalization; must not schedule waits or perform cleanup.
/** Public SDK failure envelope; callers supply safe messages/details and use outcomeUnknown when native work may have been accepted. */
export class HarnessSdkError extends Error {
  /** Stable discriminator for consumers that cannot use instanceof across package boundaries. */
  readonly name = "HarnessSdkError";
  /** Construct a failure without retaining a raw native cause; performs no I/O. */
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
}

/** Normalize unknown failures for runtime/adapter callers; preserve SDK errors, otherwise retain only safe codes and flags, never raw messages or causes. Does not throw for ordinary error values or perform I/O. */
export function sdkError(cause: unknown, fallback = "HARNESS_ERROR", outcomeUnknown = false): HarnessSdkError {
  if (cause instanceof HarnessSdkError) return cause;
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(cause.code)) {
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
