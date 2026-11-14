// Produces the public copies of protocol events, interactions and JSON values.
import type { AhpEvent, InteractionRequested, JsonValue } from './generated/types'

/**
 * Copy an event for public history with the same redactions as {@link publicValue}. Validate the
 * copy separately if it will be used as a protocol event.
 */
export function publicEvent<T extends AhpEvent>(event: T): T { return project(event) as T }
/**
 * Copy a request for public display with {@link publicValue}'s redactions. The private payload is
 * mapped to an availability marker. Session.requestInteraction emits the copy after the interaction
 * registry has stored a snapshot of the original request for native settlement.
 */
export function publicInteraction<T extends InteractionRequested>(request: T): T { return project(request) as T }
/**
 * Copy acyclic JSON without modifying the input. Map `privatePayload` entries to
 * `privatePayloadAvailable: true` in property order. Redact recognized sensitive keys and content
 * fields whose containing object has `secret: true`. The boolean marker survives. Strip queries
 * and fragments from URLs with a lowercase `http://` or `https://` prefix. Redaction can replace
 * structured fields with strings despite the retained `T` annotation. Callers still own removal
 * of secrets embedded in arbitrary text.
 */
export function publicValue<T extends JsonValue>(value: T): T { return project(value) as T }
const sensitiveKey = /^(?:password|secret|token|accessToken|refreshToken|apiKey|api_key|authorization|credentials?|headers|env)$/i
const secretContentKey = /^(?:value|answer|content|text|default)$/i

/** Strip query strings and fragments from URL matches while keeping surrounding text and URL paths. */
function stripUrlParameters(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/g, url => {
    const end = url.search(/[?#]/)
    return end === -1 ? url : url.slice(0, end)
  })
}
/** Rebuild JSON recursively, applying privacy rules before descending into potentially private fields. */
function project(value: unknown): unknown {
  if (typeof value === 'string') return stripUrlParameters(value)
  if (Array.isArray(value)) return value.map(entry => project(entry))
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === 'privatePayload') {
      output.privatePayloadAvailable = true
    } else if (key === 'secret' && typeof child === 'boolean') {
      output[key] = child
    } else if (sensitiveKey.test(key) || (record.secret === true && secretContentKey.test(key))) {
      output[key] = '[redacted]'
    } else {
      output[key] = project(child)
    }
  }
  return output
}
