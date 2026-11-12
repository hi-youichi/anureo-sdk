import { createClaudeAdapter } from '@anureo/adapter-claude'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createHermesAdapter } from '@anureo/adapter-hermes'
import { createPiAdapter } from '@anureo/adapter-pi'
import { createClient, type Client, type HarnessAdapter } from '@anureo/sdk'

export const reviewHarnesses = ['codex', 'claude', 'hermes', 'pi'] as const
export type ReviewHarness = (typeof reviewHarnesses)[number]

function createAdapter(cwd: string, harness: ReviewHarness): HarnessAdapter {
  switch (harness) {
    case 'codex': return createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', cwd })
    case 'claude': return createClaudeAdapter({ defaultHome: true, env: process.env, ...(process.env.CLAUDE_BIN ? { command: process.env.CLAUDE_BIN } : {}) })
    case 'hermes': return createHermesAdapter(process.env.HERMES_BIN ? { command: process.env.HERMES_BIN } : {})
    case 'pi': return createPiAdapter()
  }
}

/** The CLI owns this client; library callers may supply any structured-output client. */
export async function createReviewClient(cwd: string, harness: ReviewHarness = 'codex', override?: HarnessAdapter): Promise<Client> {
  return createClient({
    adapter: override ?? createAdapter(cwd, harness),
    identity: { adapterId: harness, runtimeConfigId: 'code-review' },
    interactions: {
      approval: async request => {
        const deny = request.options.find(option => option.semantic === 'deny')
        if (!deny) throw new Error('Approval request has no deny option')
        return { kind: 'approval', optionId: deny.id }
      },
    },
  })
}

/** Session permission mode for the fix agent, which edits sources and runs project
 * checks directly. Hermes rejects the field outright; Pi already defaults to full access. */
export function fixPermissionMode(harness: ReviewHarness): string | undefined {
  switch (harness) {
    case 'codex': return 'agent'
    case 'claude': return 'bypassPermissions'
    default: return undefined
  }
}
