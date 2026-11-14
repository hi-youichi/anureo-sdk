// Builds the CLI's Codex client with its auto-approval policy; it must not orchestrate runs or dispose clients.
import { createCodexAdapter } from '@anureo/adapter-codex'
import { approveWithNarrowestScope, createClient } from '@anureo/sdk'

/** Internal factory selected by runCli when no test client is supplied. Initialize a client for cwd
 * using a trimmed CODEX_BIN override or the codex executable; initialization probes its version.
 * Adapter setup may throw and initialization may reject after SDK-owned cleanup. runCli must await
 * disposal of the resolved client; library refactorCode callers instead supply their own client. */
export function createRefactorClient(cwd: string) {
  return createClient({
    adapter: createCodexAdapter({ command: process.env.CODEX_BIN?.trim() || 'codex', cwd }),
    identity: { adapterId: 'codex', runtimeConfigId: 'refactor' },
    interactions: {
      /** The SDK invokes this unattended policy for approval requests in later sessions: prefer
       * allow once, then session, then rule grants. A request with no supported allow option rejects
       * the handler, causing the SDK to cancel the interaction rather than wait for user input. */
      approval: approveWithNarrowestScope,
    },
  })
}
