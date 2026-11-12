// Builds the CLI's Codex client with its auto-approval policy; it must not orchestrate runs or dispose clients.
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createClient } from '@anureo/sdk'

/** Build runCli's client for cwd using a trimmed CODEX_BIN override or the codex executable.
 * Adapter setup may throw and SDK initialization may reject. The caller must dispose the resolved
 * client; later sessions own backend execution. Library refactorCode callers supply their own client. */
export function createRefactorClient(cwd: string) {
  return createClient({
    adapter: createCodexAdapter({ command: process.env.CODEX_BIN?.trim() || 'codex', cwd }),
    identity: { adapterId: 'codex', runtimeConfigId: 'refactor' },
    interactions: {
      /** Approve every SDK approval request automatically, preferring the narrowest grant:
       * allow once, then allow for the session, then allow with a rule. Reject if the request offers
       * none of these. Edit sessions already run with full access, so approvals add no new power;
       * the host's safety net is the Git diff, the writer lock and the validation commands. */
      approval: async request => {
        const allow = request.options.find(option => option.semantic === 'allowOnce')
          ?? request.options.find(option => option.semantic === 'allowSession')
          ?? request.options.find(option => option.semantic === 'allowWithRule')
        if (!allow) throw new Error('Approval request has no allow option')
        return { kind: 'approval', optionId: allow.id }
      },
    },
  })
}
