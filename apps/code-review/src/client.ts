// CLI-owned backend construction and fix-session permission policy.
import { createClaudeAdapter } from '@anureo/adapter-claude'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createHermesAdapter } from '@anureo/adapter-hermes'
import { createPiAdapter } from '@anureo/adapter-pi'
import { approveWithNarrowestScope, createClient, type Client, type HarnessAdapter } from '@anureo/sdk'

/** Internal backend IDs accepted by the CLI, in help and unknown-harness diagnostic order. */
export const reviewHarnesses = ['codex', 'claude', 'hermes', 'pi'] as const
/** CLI backend selection shared by client construction and fix-session permissions. */
export type ReviewHarness = (typeof reviewHarnesses)[number]

/** Initialize the CLI client. executeReviewCommand awaits it before running the review and owns
 * disposal. Direct source callers must also await disposal. Adapter construction and initialization
 * failures reject.
 *
 * Defaults to Codex, which uses cwd for its initial process launch. An override replaces the
 * built-in adapter. Keep harness aligned with that adapter because the SDK uses it in session bindings.
 * The SDK handles approval requests using the narrowest advertised allow option and attempts
 * cancellation when none is offered. */
export async function createReviewClient(cwd: string, harness: ReviewHarness = 'codex', override?: HarnessAdapter): Promise<Client> {
  return createClient({
    adapter: override ?? harnessConfig[harness].adapter(cwd),
    identity: { adapterId: harness, runtimeConfigId: 'code-review' },
    interactions: {
      approval: approveWithNarrowestScope,
    },
  })
}

/** Select the CLI fix agent's session permission mode for source edits and project checks.
 * reviewAndPrintReport passes this to reviewCode only for --fix; undefined (Hermes/Pi) leaves
 * fix sessions at backend defaults. Internal CLI policy. */
export function fixPermissionMode(harness: ReviewHarness): string | undefined {
  return harnessConfig[harness].fix
}

/** Include a configured executable for Claude or Hermes. Trim only for the presence check so the
 * adapter receives the exact configured path. An absent or blank override leaves adapter defaults in effect. */
function optionalCommand(name: 'CLAUDE_BIN' | 'HERMES_BIN'): { command?: string } {
  return process.env[name]?.trim() ? { command: process.env[name] } : {}
}

/** Pair each backend's adapter factory and fix permissions so additions must supply both.
 * Factories defer process.env reads until client creation. Codex trims CODEX_BIN;
 * Claude/Hermes use their raw override only when nonblank, otherwise their adapter defaults. */
const harnessConfig = {
  codex: {
    adapter: (cwd: string) => createCodexAdapter({ command: process.env.CODEX_BIN?.trim() || 'codex', cwd }),
    fix: 'agent',
  },
  claude: {
    adapter: () => createClaudeAdapter({ defaultHome: true, env: process.env, ...optionalCommand('CLAUDE_BIN') }),
    fix: 'bypassPermissions',
  },
  hermes: {
    adapter: () => createHermesAdapter(optionalCommand('HERMES_BIN')),
    fix: undefined,
  },
  pi: { adapter: () => createPiAdapter(), fix: undefined },
} satisfies Record<ReviewHarness, { adapter: (cwd: string) => HarnessAdapter; fix: string | undefined }>
