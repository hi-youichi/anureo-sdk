import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { BoundedEventQueue, HarnessSdkError } from '@anureo/sdk'
import { catalogPhase, type CatalogProbeOptions } from '@anureo/sdk/diagnostics'
import { createClaudeAdapter, type ClaudeAdapterOptions, type ClaudeQuery } from './index'

/** This query receives no prompt and owns no product session. */
export function createClaudeCatalogSession(options: ClaudeAdapterOptions) {
  const adapter = createClaudeAdapter(options)
  let stream: ClaudeQuery | undefined, input: BoundedEventQueue<SDKUserMessage> | undefined
  let initial: Awaited<ReturnType<Query['supportedModels']>> | undefined
  let preparing: Promise<void> | undefined, disposing: Promise<void> | undefined
  const closeConnection = async () => { const current = stream; stream = undefined; initial = undefined; input?.end(); input = undefined; current?.close(); await (current as (ClaudeQuery & Partial<Pick<Query, 'return'>>) | undefined)?.return?.() }
  const dispose = (): Promise<void> => disposing ??= (async () => {
    await closeConnection()
    await preparing?.catch(() => {})
    await closeConnection()
  })().finally(() => { disposing = undefined })
  const guarded = async <T>(context: CatalogProbeOptions, work: () => Promise<T>): Promise<T> => {
    const abort = () => { void dispose().catch(() => {}) }
    if (context.signal?.aborted) throw new HarnessSdkError('RPC_ABORTED')
    context.signal?.addEventListener('abort', abort, { once: true })
    try { return await work() } catch (cause) { await dispose(); throw cause } finally { context.signal?.removeEventListener('abort', abort) }
  }
  const prepare = (context: CatalogProbeOptions = {}): Promise<void> => guarded(context, async () => {
    await disposing
    if (preparing) { await preparing; return }
    if (stream) return
    await (preparing ??= (async () => {
      input = new BoundedEventQueue<SDKUserMessage>()
      await catalogPhase(context, 'spawn', async () => { stream = (options.queryFactory ?? query)({ prompt: input!, options: { ...adapter.queryOptions(process.cwd()), persistSession: false, sessionStore: undefined, enableFileCheckpointing: false, mcpServers: {}, settingSources: [] } }) })
      initial = await catalogPhase(context, 'handshake', () => stream!.supportedModels())
    })().catch(async cause => { await closeConnection(); throw cause }).finally(() => { preparing = undefined }))
  })
  return {
    prepare,
    async listModels(context: CatalogProbeOptions = {}) {
      return guarded(context, async () => {
        await prepare(context)
        return catalogPhase(context, 'models', async () => {
          if (initial) { const models = initial; initial = undefined; return models }
          const current = stream as ClaudeQuery & Partial<Pick<Query, 'reinitialize'>>
          if (current.reinitialize) return (await current.reinitialize()).models
          // Older SDKs/fixtures can only refresh by establishing a new directory Query.
          await dispose(); await prepare(context)
          const models = initial!; initial = undefined; return models
        })
      })
    },
    dispose,
  }
}
