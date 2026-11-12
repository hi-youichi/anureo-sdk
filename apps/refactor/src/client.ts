// Builds the CLI's Codex client with its refusal policy; it must not orchestrate runs or dispose clients.
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
      /** Answer SDK approval requests with the first deny option, falling back to cancel.
       * Reject if neither is offered; no request may widen the session's configured permissions.
       * Deny takes precedence regardless of option order so a cancellation cannot replace refusal. */
      approval: async request => {
        const deny = request.options.find(option => option.semantic === 'deny')
          ?? request.options.find(option => option.semantic === 'cancel')
        if (!deny) throw new Error('Refactor does not approve permission escalation')
        return { kind: 'approval', optionId: deny.id }
      },
    },
  })
}
