import type { PiHostFactory, PiHostModel } from './host'
import { createPiHost } from './host'

/** One Pi model with the picker metadata Anureo keeps. */
export type PiModel = PiHostModel

/**
 * List the models Pi can use right now. Opens a throwaway in-memory session so no session file is written,
 * and always disposes it.
 */
export async function createPiCatalogSession(options: { cwd?: string; agentDir?: string; createHost?: PiHostFactory } = {}): Promise<{ models: PiModel[] }> {
  const factory = options.createHost ?? createPiHost
  const host = await factory({ cwd: options.cwd ?? process.cwd(), mode: 'new', persist: false, ...(options.agentDir ? { agentDir: options.agentDir } : {}) })
  try { return { models: await host.listModels() } } finally { await host.dispose() }
}
