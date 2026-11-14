import { createPiHost, type PiHostFactory, type PiHostModel } from './host'

/** One Pi model with the picker metadata Anureo keeps. */
export type PiModel = PiHostModel

/**
 * Discover models available with the configured Pi credentials. The factory receives a request for
 * a new in-memory host. cwd defaults to process.cwd(), and createHost defaults to createPiHost.
 * A missing or empty agentDir lets the factory use its default. After acquisition, await host
 * disposal even if listing rejects. If listing and disposal both fail, disposal wins. The caller
 * receives models and has no host to release.
 */
export async function createPiCatalogSession(options: { cwd?: string; agentDir?: string; createHost?: PiHostFactory } = {}): Promise<{ models: PiModel[] }> {
  const factory = options.createHost ?? createPiHost
  const host = await factory({
    cwd: options.cwd ?? process.cwd(),
    mode: 'new',
    persist: false,
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
  })
  try {
    return { models: await host.listModels() }
  } finally {
    await host.dispose()
  }
}
