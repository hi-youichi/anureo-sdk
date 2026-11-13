/** Projects native token counters into public usage; session retention and aggregation belong to callers. */
import type { Usage } from '@anureo/protocol'
import { record, type NativeRecord } from './native-values'

/** For live events and public callers, copy finite nonnegative counters with the requested scope (turn by default). Missing/invalid fields remain absent; no aggregation, mutation or I/O. */
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
