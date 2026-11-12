export interface ReviewFailure {
  message: string
  code: string | null
  outcomeUnknown: boolean
  issues?: Array<{ path: string | Array<string | number>; code: string }>
}

/** Normalize any thrown value into a ReviewFailure, extracting structured-output
 * validation issues (Zod-style details.issues with path/code) when present. */
export function reviewFailure(cause: unknown): ReviewFailure {
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
  return {
    message: cause instanceof Error ? cause.message : String(cause),
    code: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : null,
    outcomeUnknown: !!cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true,
    ...(issues.length > 0 ? { issues } : {}),
  }
}

export function formatFailure(cause: unknown): string {
  const error = reviewFailure(cause)
  return `${error.message}${error.code ? ` [${error.code}]` : ''}${error.outcomeUnknown ? ' (execution outcome unknown)' : ''}`
}
