// Owns adapter-wide structured-output resources. Per-session policy and bridge transport belong to their dedicated modules.
import { HarnessSdkError, sdkError } from '../errors'
import type { HarnessAdapter } from '../ports'
import { OutputBridgeManager } from './bridge'
import { checkRelease } from './errors'
import type { OutputLimits } from './limits'
import { OutputSession } from './session'

/**
 * Client's constructor installs this internal adapter wrapper without native I/O. Return a port
 * owning the native adapter, tracked output sessions and one lazy bridge manager. Client initializes
 * before opening and awaits disposal after its Session cleanup. Open failures attempt partial-session
 * cleanup before rejection, and disposal attempts every resource stage before classifying failures.
 */
export function withStructuredOutput(adapter: HarnessAdapter, limits: OutputLimits = {}): HarnessAdapter {
  const manager = new OutputBridgeManager(limits.queue?.maxFrameBytes)
  const sessions = new Set<OutputSession>()
  let nativeOutput = false
  return {
    /** Client.initialize awaits native negotiation through this port and validates its result. Remember native schema support for later opens and propagate negotiation failures. */
    async initialize(params) {
      const result = await adapter.initialize(params)
      nativeOutput = result.capabilities.turn?.outputSchema === true
      return result
    },
    /** Client.attachSession awaits this port, then attaches its result. Track the wrapper before opening so setup failures attempt all session cleanup before rejecting. */
    async openSession(params, sink) {
      const session = new OutputSession({ params, sink, manager, limits, forget: () => sessions.delete(session) })
      sessions.add(session)
      try { return await session.open(adapter, nativeOutput) }
      catch (cause) {
        try { await session.dispose() }
        catch { throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Structured output setup cleanup failed', false, sdkError(cause).outcomeUnknown) }
        throw cause
      }
    },
    /** Client.dispose awaits this port after its Session attempts. Attempt all tracked session cleanup before concurrently releasing the manager/adapter, then reject classified release failures. */
    async dispose() {
      const results = await Promise.allSettled([...sessions].map(session => session.dispose()))
      results.push(...await Promise.allSettled([manager.dispose(), adapter.dispose()]))
      checkRelease(results)
    },
  }
}
