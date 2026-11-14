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

/** Create an initialized CLI client with unattended approval of the narrowest advertised allow option.
 * executeReviewCommand uses this internal factory by default and awaits disposal after report output;
 * direct source callers must also await disposal. Initialization failures reject.
 * Defaults to Codex; cwd configures its process launch. Overrides skip built-in adapter construction.
 * `harness` must describe the adapter actually installed (including `override`):
 * identity.adapterId becomes the session binding, so a mismatched pair fails or
 * mislabels every session open far from the construction site. */
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

/** Read and trim an executable override; missing or blank values use the supplied default. */
function binaryOverride(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

/** Pair each backend's adapter factory and fix permissions so additions must supply both.
 * Factories defer process.env reads until client creation. Codex trims CODEX_BIN;
 * Claude/Hermes use their raw override only when nonblank, otherwise their adapter defaults. */
const harnessConfig = {
  codex: {
    adapter: (cwd: string) => createCodexAdapter({ command: binaryOverride('CODEX_BIN', 'codex'), cwd }),
    fix: 'agent',
  },
  claude: {
    adapter: () => createClaudeAdapter({ defaultHome: true, env: process.env,
      ...(process.env.CLAUDE_BIN?.trim() ? { command: process.env.CLAUDE_BIN } : {}) }),
    fix: 'bypassPermissions',
  },
  hermes: {
    adapter: () => createHermesAdapter(process.env.HERMES_BIN?.trim() ? { command: process.env.HERMES_BIN } : {}),
    fix: undefined,
  },
  pi: { adapter: () => createPiAdapter(), fix: undefined },
} satisfies Record<ReviewHarness, { adapter: (cwd: string) => HarnessAdapter; fix: string | undefined }>
