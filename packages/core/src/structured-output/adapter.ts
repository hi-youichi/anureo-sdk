// Owns adapter-wide structured-output resources.
import { HarnessSdkError, sdkError } from '../errors'
import type { HarnessAdapter } from '../ports'
import { OutputBridgeManager } from './bridge'
import { checkRelease } from './errors'
import type { OutputLimits } from './limits'
import { OutputSession } from './session'

/**
 * Client's constructor installs this package-internal adapter wrapper without native I/O.
 * The wrapper owns the native adapter, tracked output sessions and one lazy bridge manager.
 * Client initializes before opening and awaits wrapper disposal after its Session cleanup.
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
    /**
     * Client.attachSession awaits the opened wrapper before attaching it. Track the session
     * before native open so adapter disposal can see it during setup. If setup fails, await
     * session cleanup before rejecting with the setup cause or a safe release failure.
     */
    async openSession(params, sink) {
      const session = new OutputSession({ params, sink, manager, limits, forget: () => sessions.delete(session) })
      sessions.add(session)
      try {
        return await session.open({ adapter, nativeOutput })
      } catch (cause) {
        try { await session.dispose() }
        catch {
          throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Structured output setup cleanup failed', false, sdkError(cause).outcomeUnknown)
        }
        throw cause
      }
    },
    /**
     * Client.dispose awaits this after attempting Session cleanup. Settle tracked output session
     * disposals before starting bridge manager and native adapter disposal. Classify rejected
     * release promises after those stages settle.
     */
    async dispose() {
      const results = await Promise.allSettled([...sessions].map(session => session.dispose()))
      results.push(...await Promise.allSettled([manager.dispose(), adapter.dispose()]))
      checkRelease(results)
    },
  }
}
