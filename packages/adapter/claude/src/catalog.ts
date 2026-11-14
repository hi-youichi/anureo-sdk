// Owns the resident Claude query for prompt-free model discovery.
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { BoundedEventQueue, HarnessSdkError } from '@anureo/sdk'
import { catalogPhase, type CatalogProbeOptions } from '@anureo/sdk/diagnostics'
import { createClaudeAdapter } from './adapter'
import type { ClaudeAdapterOptions, ClaudeQuery } from './options'

/** Create a reusable catalog for discovering Claude models without submitting prompts.
 * Construction retains the adapter launch configuration. When a probe opens a query, it uses
 * the current working directory and disables session persistence and file checkpoints.
 * Await dispose when finished with the catalog. Aborting an active probe requests disposal of
 * the shared connection and can affect concurrent callers. Pass a signal to request cancellation.
 * Deadline enforcement belongs to the caller even when timeoutMs is supplied.
 *
 * @example
 * ```ts
 * import { createClaudeCatalogSession } from '@anureo/adapter-claude/catalog'
 *
 * const catalog = createClaudeCatalogSession({ defaultHome: true })
 * try {
 *   console.log(await catalog.listModels())
 * } finally {
 *   await catalog.dispose()
 * }
 * ```
 */
export function createClaudeCatalogSession(options: ClaudeAdapterOptions) {
  const adapter = createClaudeAdapter(options)
  let stream: DirectoryQuery | undefined
  let input: BoundedEventQueue<SDKUserMessage> | undefined
  let pendingHandshakeModels: Awaited<ReturnType<Query['supportedModels']>> | undefined
  let preparing: Promise<void> | undefined
  let disposing: Promise<void> | undefined

  return { prepare, listModels, dispose }

  /** Warm up the catalog by awaiting launch and initial model discovery.
   * Wait for ongoing disposal before reusing a prepared query or starting a new one. Concurrent
   * callers share preparation, and the caller that starts it supplies the spawn and handshake
   * observers. An already-aborted signal rejects with RPC_ABORTED before touching the connection.
   * Startup failures reject after cleanup, with any cleanup failure taking precedence.
   */
  function prepare(context: CatalogProbeOptions = {}): Promise<void> {
    return withProbeCleanup(context, async () => {
      await disposing
      if (preparing) {
        await preparing
        return
      }
      if (stream) return
      preparing = openConnection(context)
        .catch(async cause => {
          // Shared disposal can be waiting for this preparation to settle.
          await closeConnection()
          throw cause
        })
        .finally(() => { preparing = undefined })
      await preparing
    })
  }

  /** Return native model metadata, preparing the catalog if needed.
   * Use each query's initial discovery once. Later reads refresh via native reinitialization or
   * replace the query when it lacks that capability. The supplied observer receives the spawn
   * and handshake phases this call starts, and model reads are reported after initial preparation.
   * Success leaves the connection open for reuse. An already-aborted signal rejects with
   * RPC_ABORTED before work. Probe failures await shared cleanup before rejecting, with any
   * cleanup failure taking precedence.
   */
  async function listModels(context: CatalogProbeOptions = {}) {
    return withProbeCleanup(context, async () => {
      await prepare(context)
      return catalogPhase(context, 'models', () => readModels(context))
    })
  }

  /** Release the directory connection and allow a later probe to reopen it.
   * End input, close the query and await its optional native return(). Then wait for pending
   * preparation to settle and close any query it established in the meantime. Concurrent callers
   * share the cleanup promise. A cleanup failure rejects that promise and skips remaining steps.
   */
  function dispose(): Promise<void> {
    return disposing ??= (async () => {
      await closeConnection()
      await preparing?.catch(() => {})
      // Preparation may establish a connection while dispose waits for it to finish.
      await closeConnection()
    })().finally(() => { disposing = undefined })
  }

  /** Run spawn and handshake in order for prepare, caching initial models for listModels.
   * Retain the input queue before launch so prepare's rollback or dispose can end it after failure.
   */
  async function openConnection(context: CatalogProbeOptions): Promise<void> {
    input = new BoundedEventQueue<SDKUserMessage>()
    await catalogPhase(context, 'spawn', launchDirectoryQuery)
    pendingHandshakeModels = await catalogPhase(context, 'handshake', () => stream!.supportedModels())
  }

  /** Launch the query for openConnection's spawn phase. Publish it to shared state as soon as
   * the factory returns so cleanup can reach it. A launch failure rejects the phase.
   */
  async function launchDirectoryQuery(): Promise<void> {
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
  }

  /** Supply listModels with cached discovery or refreshed models during its models phase.
   * A query without reinitialize needs a replacement to obtain fresh metadata. Await disposal
   * before reopening so a failed close rejects the read before a replacement starts.
   */
  async function readModels(context: CatalogProbeOptions) {
    if (pendingHandshakeModels) return takeHandshakeModels()
    const current = stream!
    if (current.reinitialize) return (await current.reinitialize()).models
    await dispose()
    await prepare(context)
    return takeHandshakeModels()
  }

  /** Transfer the handshake result to readModels and clear the cache so the next read refreshes. */
  function takeHandshakeModels() {
    const models = pendingHandshakeModels!
    pendingHandshakeModels = undefined
    return models
  }

  /** Scope a cancellation listener to each prepare or listModels call. The signal invokes it to
   * request shared disposal so native closure can settle pending work. Reject pre-aborted probes
   * before registration. If work rejects, await disposal and propagate the cleanup failure if any,
   * otherwise propagate the work failure.
   */
  async function withProbeCleanup<T>(context: CatalogProbeOptions, work: () => Promise<T>): Promise<T> {
    const disposeOnAbort = () => {
      // The abort event has no caller awaiting this cleanup promise.
      void dispose().catch(() => {})
    }
    if (context.signal?.aborted) {
      throw new HarnessSdkError('RPC_ABORTED')
    }
    context.signal?.addEventListener('abort', disposeOnAbort, { once: true })
    try {
      return await work()
    } catch (cause) {
      await dispose()
      throw cause
    } finally {
      context.signal?.removeEventListener('abort', disposeOnAbort)
    }
  }

  /** Release the current input and query for prepare's startup rollback or either disposal pass.
   * Clear shared query state before calling native cleanup so overlapping calls cannot close the
   * same query twice. End input before closing, then await native return when supplied. Native
   * cleanup failures reject the caller's cleanup path.
   */
  async function closeConnection(): Promise<void> {
    const current = stream
    stream = undefined
    pendingHandshakeModels = undefined
    input?.end()
    input = undefined
    current?.close()
    await current?.return?.()
  }
}

/** Directory queries can also provide in-place refresh and awaitable native cleanup. */
type DirectoryQuery = ClaudeQuery & Partial<Pick<Query, 'reinitialize' | 'return'>>
