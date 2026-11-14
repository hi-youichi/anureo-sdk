/** Projects native token counters into public usage snapshots. */
import type { Usage } from '@anureo/protocol'
import { record, type NativeRecord } from './native-values'

/**
 * Copy finite, nonnegative token counters into AHP usage for the supplied scope, defaulting to
 * turn. Zero and fractions are valid. Missing or invalid counters stay absent, and the total
 * is copied only when supplied and valid. The scope labels the sample without aggregating it.
 * CodexBackendSession.notification retains last-turn usage for turn/completed when a turn is
 * in scope and publishes cumulative usage as usage/updated.
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

/** Accept a numeric counter only when finite and nonnegative so measured zero stays distinct from absent data. */
function nativeCounter(raw: NativeRecord, field: string): number | undefined {
  return typeof raw[field] === 'number' && Number.isFinite(raw[field]) && (raw[field] as number) >= 0
    ? raw[field] as number
    : undefined
}
