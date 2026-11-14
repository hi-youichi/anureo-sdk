/** Projects native token counters into public usage; session retention and aggregation belong to callers. */
import type { Usage } from '@anureo/protocol'
import { record, type NativeRecord } from './native-values'

/**
 * Copy finite nonnegative native token counters into AHP usage with the requested scope (turn by
 * default). Zero and fractional counters survive; missing/invalid counters remain absent and
 * totals are never inferred. CodexBackendSession.notification retains the last-turn projection
 * for turn/completed and publishes the session projection as usage/updated. Callers own retention
 * and aggregation; this performs neither mutation of the input nor I/O.
 */
export function mapUsage(value: unknown, scope: 'turn' | 'session' = 'turn'): Usage {
  const raw = record(value)
  const usage: Usage = { provider: 'codex', scope, source: 'native' }
  for (const [source, target] of [
    ['inputTokens', 'input'],
    ['outputTokens', 'output'],
    ['cachedInputTokens', 'cacheRead'],
    ['cacheCreationInputTokens', 'cacheWrite'],
    ['totalTokens', 'total'],
  ] as const) {
    const counter = nativeCounter(raw, source)
    if (counter !== undefined) usage[target] = counter
  }
  return usage
}

/** Read one counter for mapUsage without coercion or mutation; invalid counters stay absent rather than becoming invented zero totals. */
function nativeCounter(raw: NativeRecord, field: string): number | undefined {
  return typeof raw[field] === 'number' && Number.isFinite(raw[field]) && (raw[field] as number) >= 0
    ? raw[field] as number
    : undefined
}
