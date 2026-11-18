// Projects AHP events and turn results onto the stdout contract; it owns no lifecycle and interprets nothing.
import type { AhpEvent } from '@anureo/protocol'
import type { TurnResult } from '@anureo/sdk'

/** One JSONL line per AHP envelope; stdout stays pure JSON. */
export function printEvent(event: AhpEvent, out: (text: string) => void): void {
  out(`${JSON.stringify(event)}\n`)
}

/** Single-object writer for --output result. */
export function printResult(result: TurnResult, binding: unknown, out: (text: string) => void): void {
  const { status, text, items, usage } = result
  const error = result.status !== 'completed' ? result.error : undefined
  out(`${JSON.stringify({
    binding,
    status,
    text,
    items,
    ...(usage && { usage }),
    ...(error && { error }),
  })}\n`)
}
