import { createCodexAdapter } from '@anureo/adapter-codex'
import { createClient } from '@anureo/sdk'

/** Codex-backed client owned by the CLI. `CODEX_BIN` overrides the executable (tests point it at
 * a scripted fixture). Library callers of `refactorCode` may pass any client instead. */
export function createRefactorClient(cwd: string) {
  return createClient({
    adapter: createCodexAdapter({ command: process.env.CODEX_BIN?.trim() || 'codex', cwd }),
    identity: { adapterId: 'codex', runtimeConfigId: 'refactor' },
    // Planning runs in a read-only session and design/module agents in a workspace-write one.
    // The task never needs more than those, so every escalation request is declined; the agent
    // then reports the blocked step in "deferred" instead of silently widening its own access.
    interactions: { approval: async request => {
      const deny = request.options.find(option => option.semantic === 'deny')
        ?? request.options.find(option => option.semantic === 'cancel')
      if (!deny) throw new Error('Refactor does not approve permission escalation')
      return { kind: 'approval', optionId: deny.id }
    } },
  })
}
