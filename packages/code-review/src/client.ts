import { createClaudeAdapter } from '@anureo/adapter-claude'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createHermesAdapter } from '@anureo/adapter-hermes'
import { createPiAdapter } from '@anureo/adapter-pi'
import { createClient, type Client, type HarnessAdapter } from '@anureo/sdk'

export const reviewHarnesses = ['codex', 'claude', 'hermes', 'pi'] as const
export type ReviewHarness = (typeof reviewHarnesses)[number]

/** Shared env-override rule: an exported-but-empty value falls back to the default. */
function binaryOverride(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

/** Single owner of per-harness knowledge: adapter construction (including the
 * CODEX_BIN/CLAUDE_BIN/HERMES_BIN override convention) and the fix agent's
 * permission mode. `satisfies` makes adding a harness without both arms a
 * compile error instead of a silently degraded fix session. */
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

function createAdapter(cwd: string, harness: ReviewHarness): HarnessAdapter {
  return harnessConfig[harness].adapter(cwd)
}

/** The CLI owns this client; library callers may supply any structured-output client.
 * `harness` must describe the adapter actually installed (including `override`):
 * identity.adapterId becomes the session binding, so a mismatched pair fails or
 * mislabels every session open far from the construction site. */
export async function createReviewClient(cwd: string, harness: ReviewHarness = 'codex', override?: HarnessAdapter): Promise<Client> {
  return createClient({
    adapter: override ?? createAdapter(cwd, harness),
    identity: { adapterId: harness, runtimeConfigId: 'code-review' },
    interactions: {
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

/** Session permission mode for the fix agent, which edits sources and runs project
 * checks directly. Hermes rejects the field outright; Pi already defaults to full access. */
export function fixPermissionMode(harness: ReviewHarness): string | undefined {
  return harnessConfig[harness].fix
}
