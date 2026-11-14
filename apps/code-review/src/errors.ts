/** Failure data retained in angle, fix and progress outcomes; these records are returned in the
 * report rather than thrown. Fatal workflow errors can still reject reviewCode instead. */
export interface ReviewFailure {
  message: string
  /** String code from the cause, or null when none was supplied. */
  code: string | null
  /** True only when the cause explicitly reports an unknown execution outcome; false is not a rollback guarantee. */
  outcomeUnknown: boolean
  /** Valid path/code pairs from validation details, without issue messages or other private details.
   * String paths pass through unchanged; array paths are copied and allow strings/nonnegative safe integers. */
  issues?: Array<{ path: string | Array<string | number>; code: string }>
}

/** Internal normalization used by reviewAngle, reviewCode's progress observer and recoverFixFailure
 * to retain failures in reports. CLI formatFailure also uses it for thrown errors. Keeps the cause's
 * message/string representation and string code, while filtering validation details to path/code pairs. */
export function reviewFailure(cause: unknown): ReviewFailure {
  const issues = failureIssues(cause)
  return {
    message: cause instanceof Error ? cause.message : String(cause),
    code: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : null,
    outcomeUnknown: !!cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true,
    ...(issues.length > 0 ? { issues } : {}),
  }
}

/** Internal CLI diagnostic for runCli and executeReviewCommand: message, optional code and outcome
 * uncertainty, without a trailing newline. Callers write it to stderr; validation issues stay in reports. */
export function formatFailure(cause: unknown): string {
  const error = reviewFailure(cause)
  return `${error.message}${error.code ? ` [${error.code}]` : ''}${error.outcomeUnknown ? ' (execution outcome unknown)' : ''}`
}

/** Retain only validation paths/codes so reports omit private issue messages and extra details.
 * String paths from SDK validators pass through unchanged; array paths require safe components. */
function failureIssues(cause: unknown): NonNullable<ReviewFailure['issues']> {
  const details = cause && typeof cause === 'object' && 'details' in cause ? cause.details : undefined
  const candidates = details && typeof details === 'object' && 'issues' in details && Array.isArray(details.issues) ? details.issues : []
  const issues: NonNullable<ReviewFailure['issues']> = []
  for (const issue of candidates) {
    if (!issue || typeof issue !== 'object' || typeof issue.code !== 'string' || !issue.code) continue
    const path: unknown = issue.path
    if (typeof path === 'string') issues.push({ path, code: issue.code })
    else if (Array.isArray(path) && path.every((part): part is string | number => typeof part === 'string'
      || (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0))) {
      issues.push({ path: [...path], code: issue.code })
    }
  }
  return issues
}
