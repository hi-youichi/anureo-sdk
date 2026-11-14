// Selects CLI adapters and their default permission modes.
import { resolve } from 'node:path'
import { approveWithNarrowestScope, createClient } from '@anureo/sdk'
import { spawnHarnessProcess } from '@anureo/sdk/process'

export const refactorHarnesses = ['codex', 'claude', 'hermes', 'pi', 'acp', 'ahp', 'dsh'] as const
export type RefactorHarness = (typeof refactorHarnesses)[number]

export interface HarnessSelection {
  id: RefactorHarness
  command?: string
  args?: string[]
  url?: string
}

/** CLI defaults for backends with known permission modes. Protocol peers can use their own modes. */
export const harnessPermissions: Partial<Record<RefactorHarness, { readPermissionMode: string; editPermissionMode: string }>> = {
  codex: { readPermissionMode: 'read-only', editPermissionMode: 'agent-full-access' },
  claude: { readPermissionMode: 'plan', editPermissionMode: 'acceptEdits' },
  pi: { readPermissionMode: 'read-only', editPermissionMode: 'agent-full-access' },
}

/** Initialize the selected adapter. The CLI owns the returned client and awaits disposal. */
export async function createRefactorClient(cwd: string, selection: HarnessSelection) {
  const adapter = await createAdapter(cwd, selection)
  return createClient({
    adapter,
    identity: { adapterId: selection.id, runtimeConfigId: 'refactor' },
    interactions: { approval: approveWithNarrowestScope },
  })
}

async function createAdapter(cwd: string, { id, command, args, url }: HarnessSelection) {
  switch (id) {
    case 'codex': {
      const { createCodexAdapter } = await import('@anureo/adapter-codex')
      const executable = process.env.CODEX_BIN?.trim() || 'codex'
      const script = /\.[cm]?js$/i.test(executable) ? resolve(cwd, executable) : undefined
      return createCodexAdapter({
        command: executable, cwd,
        // Explicit JavaScript entries also run on hosts without shebang support.
        processFactory: script ? options => spawnHarnessProcess({
          ...options, command: process.execPath, args: [script, ...options.args ?? []],
        }) : undefined,
      })
    }
    case 'claude': {
      const { createClaudeAdapter } = await import('@anureo/adapter-claude')
      const executable = process.env.CLAUDE_BIN?.trim() || undefined
      return createClaudeAdapter({ command: executable, defaultHome: true, env: process.env,
        executableRuntime: executable && /\.[cm]?js$/i.test(executable) ? 'bun' : undefined })
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
