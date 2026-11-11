import type { ReviewContext } from './context'
import { errorText } from './io'
import type { Evidence } from './schema'

export type ValidationIssue = { path: string; message: string }
export class ResponseValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) { super(issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')) }
}

/** Inspect every citation before asking for a replacement response. */
export function checkEvidence(context: ReviewContext, allowed: Set<string>, groups: Array<{ path: string; evidence: Evidence[] }>) {
  const issues: ValidationIssue[] = []
  for (const group of groups) group.evidence.forEach((evidence, index) => {
    try { context.validateEvidence([evidence], allowed) }
    catch (error) { issues.push({ path: `${group.path}[${index}]`, message: errorText(error) }) }
  })
  if (issues.length) throw new ResponseValidationError(issues)
}

/** Correct only returned responses; invocation and persistence failures propagate unchanged. */
export async function validatedResponse<T extends object>(options: {
  stage: string; input: object; corrections: number
  invoke: (stage: string, input: object, onCallId: (id: string) => void) => Promise<T>
  validate: (value: T) => void
  record: (attempt: { callId: string; stage: string; correction: number; outcome: 'accepted' | 'invalid'; issues: ValidationIssue[] }) => Promise<void>
}): Promise<T> {
  let previousResponse: T | null = null
  let validationFeedback: ValidationIssue[] = []
  for (let correction = 0; correction <= options.corrections; correction++) {
    const stage = correction ? `${options.stage}-correction-${correction}` : options.stage
    let callId = ''
    const value = await options.invoke(stage, correction ? { ...options.input, previousResponse, validationFeedback, correction } : options.input,
      id => { callId = id })
    let failure: unknown
    let invalid = false
    try { options.validate(value) }
    catch (error) {
      invalid = true
      failure = error
      validationFeedback = error instanceof ResponseValidationError ? error.issues : [{ path: 'response', message: errorText(error) }]
    }
    await options.record({ callId, stage, correction, outcome: invalid ? 'invalid' : 'accepted', issues: invalid ? validationFeedback : [] })
    if (!invalid) return value
    if (correction === options.corrections || (value as { status?: string }).status === 'incomplete') throw failure
    previousResponse = value
  }
  throw new Error('Response correction budget exhausted')
}
