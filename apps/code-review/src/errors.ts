/** Diagnostic data carried by failed angle and fix outcomes and by progress observer errors.
 * Inspect the enclosing outcome for coverage. Fatal workflow errors can reject reviewCode. */
export interface ReviewFailure {
  /** The cause's Error.message or its string representation. */
  message: string
  /** String code from the cause, or null when none was supplied. */
  code: string | null
  /** True when the cause explicitly reports execution uncertainty. Use FixReport.changedFiles to
   * identify recorded edits in the original work tree. */
  outcomeUnknown: boolean
  /** Present when validation details contain usable path/code pairs. String paths pass through
   * unchanged. Copied array paths contain strings or nonnegative safe integers. */
  issues?: Array<{ path: string | Array<string | number>; code: string }>
}

/** Project a caught or synthesized cause into report data. reviewAngle and failedAngleReview
 * store it as missing coverage, applyFix returns it with the failed fix, and reviewCode collects
 * it when onProgress throws. formatFailure uses the same projection for CLI diagnostics.
 * Reading properties or converting the cause to a string can throw. */
export function reviewFailure(cause: unknown): ReviewFailure {
  const issues = failureIssues(cause)
  const metadata = cause && typeof cause === 'object' ? cause : undefined
  return {
    message: cause instanceof Error ? cause.message : String(cause),
    code: metadata && 'code' in metadata && typeof metadata.code === 'string' ? metadata.code : null,
    outcomeUnknown: metadata !== undefined && 'outcomeUnknown' in metadata && metadata.outcomeUnknown === true,
    ...(issues.length > 0 ? { issues } : {}),
  }
}

/** Return a CLI diagnostic with the message, any nonempty code, and an uncertainty notice when
 * flagged. runCli writes it to stderr for command failures. executeReviewCommand uses it for a
 * secondary cleanup failure. Both callers add the prefix and newline. Errors while projecting
 * the cause propagate to the caller. */
export function formatFailure(cause: unknown): string {
  const error = reviewFailure(cause)
  return `${error.message}${error.code ? ` [${error.code}]` : ''}${error.outcomeUnknown ? ' (execution outcome unknown)' : ''}`
}

/** Keep valid validation paths and codes in source order while omitting issue messages and details.
 * Copy array paths so the report does not retain the cause's path arrays. */
function failureIssues(cause: unknown): NonNullable<ReviewFailure['issues']> {
  const details = cause && typeof cause === 'object' && 'details' in cause ? cause.details : undefined
  if (!details || typeof details !== 'object' || !('issues' in details) || !Array.isArray(details.issues)) return []

  const candidates = details.issues
  const issues: NonNullable<ReviewFailure['issues']> = []
  for (const issue of candidates) {
    if (!issue || typeof issue !== 'object' || typeof issue.code !== 'string' || !issue.code) continue
    const path: unknown = issue.path
    if (!isValidationIssuePath(path)) continue
    issues.push({ path: typeof path === 'string' ? path : [...path], code: issue.code })
  }
  return issues
}

/** Accept SDK string paths and segmented paths with string keys or safe array indices. */
function isValidationIssuePath(path: unknown): path is string | Array<string | number> {
  return typeof path === 'string' || (Array.isArray(path) && path.every(part =>
    typeof part === 'string' || (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0)))
}
