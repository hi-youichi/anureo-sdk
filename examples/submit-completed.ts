import assert from 'node:assert/strict'
import type { Session, SubmitOptions } from '@anureo/sdk'

/**
 * Submit once and return a completed terminal snapshot. A submission can omit the schema for
 * plain text. The association and terminal waits each use their own deadline in milliseconds.
 * Request and wait errors propagate, and a failed or interrupted result rejects with an assertion.
 * A wait deadline only ends the caller's wait. The Pi and output-tool examples close the sessions
 * they opened after their checks settle.
 */
export async function submitCompleted(
  session: Session,
  submission: SubmitOptions,
  { associationMs, resultMs }: { associationMs: number; resultMs: number },
) {
  const turn = await session.submit(submission, { timeoutMs: associationMs })
  const result = await turn.result({ timeoutMs: resultMs })
  assert.equal(result.status, 'completed', result.status === 'failed' ? result.error.code : result.status)
  return result
}
