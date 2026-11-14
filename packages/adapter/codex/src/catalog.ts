/** Owns reusable read-only catalog connections and cancellation; it must not create threads or turns. */
import { catalogPhase, type CatalogProbeOptions } from '@anureo/sdk/diagnostics'
import { HarnessSdkError } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import { CodexJsonlClient } from './jsonl'
import { readAccountStatus } from './account'
import { readCodexModels } from './models'
import type { CodexAdapterOptions } from './options'
/** Public launch/transport options shared with adapters; the catalog owns every process it creates. */
export type { CodexAdapterOptions } from './options'
/** Public read-only model metadata; interpretation is shared with adapter probes. */
export type { CodexModel } from './models'

/**
 * Construct a reusable read-only catalog without I/O; the host must await dispose after use.
 * prepare/queries reject launch, handshake, query or abort failures. Aborting an active call requests
 * shared connection cleanup and can fail concurrent reads. dispose awaits cleanup and may reject;
 * later calls may prepare again. No thread or turn is created.
 */
export function createCodexCatalogSession(options: CodexAdapterOptions) {
  let client: CodexJsonlClient | undefined
  let preparationInFlight: Promise<void> | undefined
  let connectionCloseInFlight: Promise<void> | undefined
  let disposalInFlight: Promise<void> | undefined
  /** Share connection disposal across racing callers, detaching it before awaiting cleanup so it cannot be reused; return cleanup completion or rejection without waiting for preparation. */
  const closeConnection = (): Promise<void> => {
    if (connectionCloseInFlight) return connectionCloseInFlight
    const current = client
    client = undefined
    return connectionCloseInFlight = (current?.dispose() ?? Promise.resolve()).finally(() => { connectionCloseInFlight = undefined })
  }
  /** Release this preparation’s resources for explicit cleanup or cancellation. Close before and after awaiting preparation to catch clients created during the race; concurrent callers share completion and cleanup failures propagate. */
  const dispose = (): Promise<void> => disposalInFlight ??= (async () => {
    await closeConnection()
    await preparationInFlight?.catch(() => {})
    await closeConnection()
  })().finally(() => { disposalInFlight = undefined })
  /** Run a catalog operation with its caller’s abort listener; pre-aborted calls reject RPC_ABORTED and later abort requests shared cleanup, also affecting concurrent users. Always remove the listener and propagate work failures. */
  const guarded = async <T>(context: CatalogProbeOptions, work: () => Promise<T>): Promise<T> => {
    /** Abort listener requests shared disposal without throwing from event dispatch; guarded work observes resulting transport failure. */
    const abort = () => { void dispose().catch(() => {}) }
    if (context.signal?.aborted) throw new HarnessSdkError('RPC_ABORTED')
    context.signal?.addEventListener('abort', abort, { once: true })
    try { return await work() } finally { context.signal?.removeEventListener('abort', abort) }
  }
  /** Publish startConnection's client before handshake so cancellation can reach it. The registered finished callback detaches and disposes only this connection after reader completion; an old reader must never detach a replacement. Background cleanup failures are absorbed here but remain observable while cleanup is in flight. */
  const publishConnection = (connected: CodexJsonlClient): void => {
    client = connected
    void connected.finished.then(() => {
      if (client === connected) {
        client = undefined
        connectionCloseInFlight = connected.dispose().finally(() => { connectionCloseInFlight = undefined })
        void connectionCloseInFlight.catch(() => {})
      }
    })
  }
  /** For preparation only, spawn and publish one connection before handshaking so cancellation can close pending RPCs. Report phases and release partial resources on failure; cleanup rejection takes precedence over the startup cause. */
  const startConnection = (context: CatalogProbeOptions): Promise<void> => {
    let spawned: HarnessProcess | undefined
    return (async () => {
      const child = await catalogPhase(context, 'spawn', async () => {
        // Retain ownership before phase completion, which can reject for cancellation after spawning.
        spawned = await (options.processFactory ?? spawnHarnessProcess)({
          command: options.command,
          args: options.args ?? ['app-server'],
          cwd: options.cwd,
          env: options.env,
        })
        return spawned
      })
      if (context.signal?.aborted) { await child.dispose(); throw new HarnessSdkError('RPC_ABORTED') }
      const connected = createCatalogClient(child, options, context)
      publishConnection(connected)
      await catalogPhase(context, 'handshake', async () => {
        await connected.request('initialize', { clientInfo: { name: 'anureo-catalog', version: '1' }, capabilities: { experimentalApi: true } })
        await connected.notify('initialized')
      })
    })().catch(async cause => {
      await closeConnection()
      // Covers cancellation during spawn before a client took ownership of the process.
      await spawned?.dispose()
      throw cause
    })
  }
  /** Lazily share spawn/handshake after prior cleanup settles; reject abort/startup errors after releasing partial resources. The first preparation sets per-RPC timeoutMs (default 10,000ms) until reconnection; it does not bound spawning. Later calls reuse the connection or reconnect after disposal/EOF. */
  const prepare = (context: CatalogProbeOptions = {}): Promise<void> => guarded(context, async () => {
    // Disposal's second close must finish before a replacement client can be published.
    await disposalInFlight
    await connectionCloseInFlight
    if (preparationInFlight) { await preparationInFlight; return }
    if (client) return
    await (preparationInFlight ??= startConnection(context).finally(() => { preparationInFlight = undefined }))
  })
  return {
    prepare,
    /** Prepare/reuse a read-only connection and return ordered model metadata with phase diagnostics; propagate abort/query errors and leave connection ownership with this catalog. */
    listModels: (context: CatalogProbeOptions = {}) => guarded(context, async () => {
      await prepare(context)
      return await catalogPhase(context, 'models', () => readCodexModels(client!))
    }),
    /** Prepare/reuse a read-only connection and return ready/required without authenticating, or unknown when account/read is unsupported. Propagate abort/query errors and retain the connection until cleanup. */
    readAuthStatus: (context: CatalogProbeOptions = {}) => guarded(context, async () => {
      await prepare(context)
      return await readAccountStatus(client!)
    }),
    dispose,
  }
}

/** Start readers for startConnection's process without handshaking. JSONL invokes the non-interactive handlers; publishConnection observes reader completion and owns subsequent cleanup. The returned client retains the first preparation's request deadline, overriding options.timeoutMs. */
function createCatalogClient(child: HarnessProcess, options: CodexAdapterOptions, context: CatalogProbeOptions): CodexJsonlClient {
  return new CodexJsonlClient(child, {
    // Read-only queries have no session state to update; the finished observer owns closure cleanup.
    notification: async () => {},
    /** Reject every server interaction without consulting a user; transport write failures reach the JSONL handler's fallback. */
    request: async (_request, _reply, reject) => { await reject(-32601, 'Catalog queries are non-interactive') },
    failure: async () => {},
    diagnostic: options.diagnostic,
  }, { ...options, timeoutMs: context.timeoutMs ?? 10_000 })
}
