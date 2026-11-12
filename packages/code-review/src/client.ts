import { createCodexAdapter } from '@anureo/adapter-codex'
import { createClient, type Client, type HarnessAdapter } from '@anureo/sdk'

/** The CLI owns this client; library callers may supply any structured-output client. */
export async function createReviewClient(cwd: string): Promise<Client> {
  const codex = createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', cwd })
  // workflow.agent intentionally has no permission option. Apply CLI policy at the adapter boundary.
  const adapter: HarnessAdapter = {
    initialize: params => codex.initialize(params),
    openSession: (params, sink) => codex.openSession({ ...params, config: { ...params.config, permissionMode: 'read-only' } }, sink),
    dispose: () => codex.dispose(),
  }
  return createClient({
    adapter, identity: { adapterId: 'codex', runtimeConfigId: 'code-review' },
    interactions: {
      approval: async request => {
        const deny = request.options.find(option => option.semantic === 'deny')
        if (!deny) throw new Error('Approval request has no deny option')
        return { kind: 'approval', optionId: deny.id }
      },
    },
  })
}
