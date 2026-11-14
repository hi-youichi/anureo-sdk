// Selects CLI adapters and their default permission modes.
import { resolve } from 'node:path'
import { approveWithNarrowestScope, createClient, type Client } from '@anureo/sdk'
import { spawnHarnessProcess } from '@anureo/sdk/process'

/** Harness IDs accepted by the CLI, in the order shown in help and argument diagnostics. */
export const refactorHarnesses = ['codex', 'claude', 'hermes', 'pi', 'acp', 'ahp', 'dsh'] as const
/** An ID from the installed CLI's harness list. */
export type RefactorHarness = (typeof refactorHarnesses)[number]

/** Backend and peer settings passed by the CLI to its client factory after option admission. */
export interface HarnessSelection {
  id: RefactorHarness
  /** Stdio executable required for ACP and for AHP over stdio. */
  command?: string
  /** Literal peer arguments in command-line order. Requires command. */
  args?: string[]
  /** AHP WebSocket endpoint. Mutually exclusive with stdio settings. */
  url?: string
}

/** Session modes executeRefactor uses when no explicit CLI override is given.
 * An absent entry lets the adapter choose its defaults. */
export const harnessPermissions: Partial<Record<RefactorHarness, { readPermissionMode: string; editPermissionMode: string }>> = {
  codex: { readPermissionMode: 'read-only', editPermissionMode: 'agent-full-access' },
  claude: { readPermissionMode: 'plan', editPermissionMode: 'acceptEdits' },
  pi: { readPermissionMode: 'read-only', editPermissionMode: 'agent-full-access' },
}

/** Initialize a client for the CLI's validated selection and absolute target directory.
 * Resolves once the SDK client can open sessions. Adapter loading and SDK initialization failures
 * reject. The CLI registers unattended approval using the narrowest advertised allow option.
 * executeRefactor passes failures to runCli and awaits disposal of a returned client. */
export async function createRefactorClient(cwd: string, selection: HarnessSelection): Promise<Client> {
  const adapter = await createAdapter(cwd, selection)
  return createClient({
    adapter,
    identity: { adapterId: selection.id, runtimeConfigId: 'refactor' },
    interactions: { approval: approveWithNarrowestScope },
  })
}

const javaScriptEntry = /\.[cm]?js$/i

/** Load only the selected backend for createRefactorClient. Adapter import or construction
 * failures reject. The SDK initializes the returned adapter and owns its lifecycle from there. */
async function createAdapter(cwd: string, { id, command, args, url }: HarnessSelection) {
  switch (id) {
    case 'codex': {
      const { createCodexAdapter } = await import('@anureo/adapter-codex')
      const executable = process.env.CODEX_BIN?.trim() || 'codex'
      const script = javaScriptEntry.test(executable) ? resolve(cwd, executable) : undefined
      return createCodexAdapter({
        command: executable, cwd,
        // The adapter uses this for version probes and session launches. Resolve the script
        // against the CLI target so it still works when a session launches in a worktree.
        processFactory: script ? options => spawnHarnessProcess({
          ...options, command: process.execPath, args: [script, ...(options.args ?? [])],
        }) : undefined,
      })
    }
    case 'claude': {
      const { createClaudeAdapter } = await import('@anureo/adapter-claude')
      const executable = process.env.CLAUDE_BIN?.trim() || undefined
      return createClaudeAdapter({
        command: executable, defaultHome: true, env: process.env,
        executableRuntime: executable && javaScriptEntry.test(executable) ? 'bun' : undefined,
      })
    }
    case 'hermes': {
      const { createHermesAdapter } = await import('@anureo/adapter-hermes')
      return createHermesAdapter({ command: process.env.HERMES_BIN?.trim() || undefined })
    }
    case 'pi': {
      const { createPiAdapter } = await import('@anureo/adapter-pi')
      return createPiAdapter()
    }
    case 'acp': {
      const { createAcpAdapter } = await import('@anureo/adapter-acp')
      return createAcpAdapter({ command, args, cwd })
    }
    case 'ahp': {
      const { createAhpAdapter, createWebSocketTransport } = await import('@anureo/adapter-ahp')
      return createAhpAdapter(url ? { url, connect: createWebSocketTransport } : { command, args, cwd })
    }
    case 'dsh': {
      const { createDshAcpAdapter } = await import('@anureo/adapter-acp')
      return createDshAcpAdapter({ command: process.env.DSH_BIN?.trim() || undefined, cwd })
    }
  }
}
