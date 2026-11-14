// Owns the resident, prompt-less directory Query and its discovery/cleanup lifecycle.
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { BoundedEventQueue, HarnessSdkError } from '@anureo/sdk'
import { catalogPhase, type CatalogProbeOptions } from '@anureo/sdk/diagnostics'
import { createClaudeAdapter } from './adapter'
import type { ClaudeAdapterOptions, ClaudeQuery } from './options'

/** Create a reusable model catalog without launching Claude or submitting prompts.
 * Directory consumers call prepare/listModels to launch and discover models, then await dispose
 * when finished. Active probe cancellation requests shared connection disposal and can affect
 * concurrent users. Failures during work await cleanup, whose failure takes precedence over
 * the original cause. Probe options report phases and observe cancellation; callers enforce
 * deadlines themselves because timeoutMs is not enforced here. */
export function createClaudeCatalogSession(options: ClaudeAdapterOptions) {
  const adapter = createClaudeAdapter(options)
  let stream: ClaudeQuery | undefined
  let input: BoundedEventQueue<SDKUserMessage> | undefined
  let pendingHandshakeModels: Awaited<ReturnType<Query['supportedModels']>> | undefined
  let preparing: Promise<void> | undefined
  let disposing: Promise<void> | undefined

  return { prepare, listModels, dispose }

  /** Await launch and initial model discovery, sharing any preparation already in flight.
   * Wait for ongoing disposal before reusing or opening a connection. The caller that starts
   * preparation supplies its spawn/handshake observers; other callers await that same work.
   * Startup failures reject after cleanup. Already-aborted signals reject RPC_ABORTED before work. */
  function prepare(context: CatalogProbeOptions = {}): Promise<void> {
    return withProbeCleanup(context, async () => {
      await disposing
      if (preparing) { await preparing; return }
      if (stream) return
      await (preparing ??= openConnection(context)
        .catch(async cause => { await closeConnection(); throw cause })
        .finally(() => { preparing = undefined }))
    })
  }

  /** Return initial discovery once, then refresh through native reinitialization when available.
   * Older queries are closed and replaced for refresh. Failures await shared cleanup before
   * rejecting; successful calls leave the connection resident for the caller to dispose. */
  async function listModels(context: CatalogProbeOptions = {}) {
    return withProbeCleanup(context, async () => {
      await prepare(context)
      return catalogPhase(context, 'models', () => readModels(context))
    })
  }

  /** End input, close the query and await its optional native return(), including any query
   * established by pending preparation. Concurrent calls share cleanup; cleanup failures reject.
   * This releases current resources without retiring the catalog: a later probe can open it again. */
  function dispose(): Promise<void> {
    return disposing ??= (async () => {
      await closeConnection()
      await preparing?.catch(() => {})
      // Preparation may establish a connection while dispose waits for it to finish.
      await closeConnection()
    })().finally(() => { disposing = undefined })
  }

  /** prepare tracks this launch/handshake as one shared operation. Retain the empty input queue
   * before launching so disposal can end it even if creation or discovery fails. */
  async function openConnection(context: CatalogProbeOptions): Promise<void> {
    input = new BoundedEventQueue<SDKUserMessage>()
    await catalogPhase(context, 'spawn', async () => {
      stream = (options.queryFactory ?? query)({
        prompt: input!,
        options: {
          ...adapter.queryOptions(process.cwd()),
          persistSession: false,
          sessionStore: undefined,
          enableFileCheckpointing: false,
          mcpServers: {},
          settingSources: [],
        },
      })
    })
    pendingHandshakeModels = await catalogPhase(context, 'handshake', () => stream!.supportedModels())
  }

  /** listModels observes this read as its models phase. Consume discovery before requesting a
   * refresh; queries without reinitialize need a replacement connection to obtain fresh metadata. */
  async function readModels(context: CatalogProbeOptions) {
    if (pendingHandshakeModels) return takeHandshakeModels()
    const current = stream as ClaudeQuery & Partial<Pick<Query, 'reinitialize'>>
    if (current.reinitialize) return (await current.reinitialize()).models
    await dispose()
    await prepare(context)
    return takeHandshakeModels()
  }

  /** Consume the cached result once; readModels calls only with a cache or after preparation. */
  function takeHandshakeModels() {
    const models = pendingHandshakeModels!
    pendingHandshakeModels = undefined
    return models
  }

  /** prepare/listModels register cancellation while work runs and await disposal on failure.
   * Already-aborted calls reject before work or cleanup; abort listeners suppress cleanup failures
   * because an event listener cannot return a cleanup rejection to the caller. */
  async function withProbeCleanup<T>(context: CatalogProbeOptions, work: () => Promise<T>): Promise<T> {
    const disposeOnAbort = () => {
      // Cancellation reaches in-flight work by disposing its resources; cleanup errors are ignored here.
      void dispose().catch(() => {})
    }
    if (context.signal?.aborted) {
      throw new HarnessSdkError('RPC_ABORTED')
    }
    context.signal?.addEventListener('abort', disposeOnAbort, { once: true })
    try {
      return await work()
    } catch (cause) {
      // Await cleanup before rethrowing; a disposal failure takes precedence over cause.
      await dispose()
      throw cause
    } finally {
      context.signal?.removeEventListener('abort', disposeOnAbort)
    }
  }

  /** Detach shared state before native cleanup so concurrent disposal cannot close it twice.
   * prepare uses this for failed startup; dispose also calls it after waiting for preparation.
   * End the prompt stream before closing, then await return when supplied; failures propagate. */
  async function closeConnection(): Promise<void> {
    const current = stream
    stream = undefined
    pendingHandshakeModels = undefined
    input?.end()
    input = undefined
    current?.close()
    await (current as (ClaudeQuery & Partial<Pick<Query, 'return'>>) | undefined)?.return?.()
  }
}
