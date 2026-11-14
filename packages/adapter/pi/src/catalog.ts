import type { PiHostFactory, PiHostModel } from './host'
import { createPiHost } from './host'

/** One Pi model with the picker metadata Anureo keeps. */
export type PiModel = PiHostModel

/**
 * List credential-available Pi models using a throwaway in-memory host; no session file is written.
 * cwd defaults to process.cwd(), and createHost defaults to the embedded factory. After acquisition,
 * disposal is awaited even if listing rejects. Acquisition/listing/disposal failures reject; a disposal
 * failure takes precedence over a listing failure. The caller receives models with no host to release.
 */
export async function createPiCatalogSession(options: { cwd?: string; agentDir?: string; createHost?: PiHostFactory } = {}): Promise<{ models: PiModel[] }> {
  const factory = options.createHost ?? createPiHost
  const host = await factory({ cwd: options.cwd ?? process.cwd(), mode: 'new', persist: false, ...(options.agentDir ? { agentDir: options.agentDir } : {}) })
  try { return { models: await host.listModels() } } finally { await host.dispose() }
}
