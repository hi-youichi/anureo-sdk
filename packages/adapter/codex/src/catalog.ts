/** Owns the shared connection for read-only Codex discovery. */
import { catalogPhase, type CatalogProbeOptions } from '@anureo/sdk/diagnostics'
import { HarnessSdkError } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import { CodexJsonlClient } from './jsonl'
import { readAccountStatus } from './account'
import { readCodexModels } from './models'
import type { CodexAdapterOptions } from './options'

/** Launch and transport settings for a catalog and its owned process handles. */
export type { CodexAdapterOptions } from './options'
/** Metadata returned by model discovery, including hidden entries. */
export type { CodexModel } from './models'

/**
 * Create a reusable catalog for model discovery and account readiness without starting a process.
 * Preparation and reads share a connection and never open a thread or start a turn. Aborting an
 * active operation requests shared cleanup, so concurrent operations can fail too. Await dispose
 * after use. The same catalog can reconnect after disposal or reader closure.
 */
export function createCodexCatalogSession(options: CodexAdapterOptions) {
  let client: CodexJsonlClient | undefined
  let preparationInFlight: Promise<void> | undefined
  let connectionCloseInFlight: Promise<void> | undefined
  let disposalInFlight: Promise<void> | undefined

  /**
   * Wait for any pending cleanup and share the next spawn and handshake with concurrent callers.
   * The caller that starts preparation supplies spawn and handshake diagnostics and the per-RPC
   * timeout for this connection (10,000 ms by default), excluding spawn.
   * Reject startup, cleanup or cancellation failures.
   */
  const prepare = (context: CatalogProbeOptions = {}): Promise<void> => {
    return withAbortCleanup(context, async () => {
      // Disposal's second close must finish before a replacement client can be published.
      await disposalInFlight
      await connectionCloseInFlight
      if (preparationInFlight) {
        await preparationInFlight
        return
      }
      if (client) return
      await (preparationInFlight ??= startConnection(context).finally(() => { preparationInFlight = undefined }))
    })
  }

  /**
   * Prepare or reuse the connection and return all model pages in native order, including hidden
   * entries. Report the models phase and reject preparation, query, decoding or cancellation
   * failures. The catalog retains the connection for later reads.
   */
  const listModels = (context: CatalogProbeOptions = {}) =>
    query(context, getClient => catalogPhase(context, 'models', () => readCodexModels(getClient())))

  /**
   * Prepare or reuse the connection and return account readiness without refreshing credentials.
   * Return unknown if the native method is unsupported. Preparation and other read failures
   * reject. The catalog retains the connection for later reads.
   */
  const readAuthStatus = (context: CatalogProbeOptions = {}) =>
    query(context, getClient => readAccountStatus(getClient()))

  /**
   * Release the shared connection and wait for any in-flight preparation to settle if the first
   * close succeeds. Concurrent disposal calls share completion and observe cleanup failures.
   * A preparation failure belongs to its caller. Dispose also closes a client published during
   * that preparation.
   */
  const dispose = (): Promise<void> => {
    return disposalInFlight ??= (async () => {
      await closeConnection()
      await preparationInFlight?.catch(() => {})
      await closeConnection()
    })().finally(() => { disposalInFlight = undefined })
  }

  return { prepare, listModels, readAuthStatus, dispose }

  /**
   * For explicit disposal and startup rollback, wait for the close already started by any
   * caller or start a new one. Return the close outcome without waiting for preparation.
   */
  function closeConnection(): Promise<void> {
    if (connectionCloseInFlight) return connectionCloseInFlight
    return releaseConnection(client)
  }

  /**
   * Detach the current client before disposing it so prepare cannot reuse it. Track the close
   * until it settles so racing prepare and dispose calls can await the same cleanup outcome.
   */
  function releaseConnection(current: CodexJsonlClient | undefined): Promise<void> {
    client = undefined
    connectionCloseInFlight = (current?.dispose() ?? Promise.resolve()).finally(() => {
      connectionCloseInFlight = undefined
    })
    return connectionCloseInFlight
  }

  /**
   * Keep cancellation active from preparation through the read. The models phase observer can
   * run before the read begins, so look up the shared client when invoking the read itself.
   */
  function query<T>(
    context: CatalogProbeOptions,
    work: (getClient: () => CodexJsonlClient) => Promise<T>,
  ): Promise<T> {
    return withAbortCleanup(context, async () => {
      await prepare(context)
      return await work(() => client!)
    })
  }

  /**
   * Reject pre-aborted calls with RPC_ABORTED and remove the abort listener when work settles.
   * During work the listener starts shared disposal without waiting for it. The operation
   * propagates its own result or failure, including transport failures caused by disposal.
   */
  async function withAbortCleanup<T>(context: CatalogProbeOptions, work: () => Promise<T>): Promise<T> {
    const abort = () => { void dispose().catch(() => {}) }
    if (context.signal?.aborted) throw new HarnessSdkError('RPC_ABORTED')
    context.signal?.addEventListener('abort', abort, { once: true })
    try {
      return await work()
    } finally {
      context.signal?.removeEventListener('abort', abort)
    }
  }

  /**
   * Expose the client to disposal before handshaking. When its JSONL reader finishes, close it
   * only if it is still the current client. The observer has no caller to receive cleanup errors.
   */
  function publishConnection(connected: CodexJsonlClient): void {
    client = connected
    void connected.finished.then(() => {
      if (client === connected) void releaseConnection(connected).catch(() => {})
    })
  }

  /**
   * Spawn and handshake for prepare. On failure, close the published client and release any
   * process acquired during spawn. A cleanup rejection takes precedence over the startup cause.
   */
  function startConnection(context: CatalogProbeOptions): Promise<void> {
    let spawned: HarnessProcess | undefined
    return (async () => {
      const child = await catalogPhase(context, 'spawn', async () => {
        // The phase can reject for cancellation after the launcher has returned a process.
        spawned = await (options.processFactory ?? spawnHarnessProcess)({
          command: options.command,
          args: options.args ?? ['app-server'],
          cwd: options.cwd,
          env: options.env,
        })
        return spawned
      })
      if (context.signal?.aborted) {
        // A success observer can abort after the spawn phase's own cancellation check.
        await child.dispose()
        throw new HarnessSdkError('RPC_ABORTED')
      }

      const connected = createCatalogClient(child, options, context)
      publishConnection(connected)
      await handshake(connected, context)
    })().catch(async cause => {
      await closeConnection()
      // A failed spawn phase may still have acquired a process before client publication.
      await spawned?.dispose()
      throw cause
    })
  }
}

/** Complete startup after the initialize reply and the initialized notification write. Report the handshake phase and propagate its failure to startup rollback. */
function handshake(client: CodexJsonlClient, context: CatalogProbeOptions): Promise<void> {
  return catalogPhase(context, 'handshake', async () => {
    await client.request('initialize', {
      clientInfo: { name: 'anureo-catalog', version: '1' },
      capabilities: { experimentalApi: true },
    })
    await client.notify('initialized')
  })
}

/**
 * Start JSONL readers for the launched child. Use the preparation context's per-RPC timeout in
 * place of the adapter timeout. The caller publishes the client so reader completion and
 * cancellation can release the process.
 */
function createCatalogClient(child: HarnessProcess, options: CodexAdapterOptions, context: CatalogProbeOptions): CodexJsonlClient {
  return new CodexJsonlClient(child, {
    // Catalog reads keep no notification state. The finished observer owns closure cleanup.
    notification: async () => {},
    /** When JSONL dispatches a native interaction, await the method-not-found reply write. */
    request: async (_request, _reply, reject) => { await reject(-32601, 'Catalog queries are non-interactive') },
    failure: async () => {},
    diagnostic: options.diagnostic,
  }, { ...options, timeoutMs: context.timeoutMs ?? 10_000 })
}
