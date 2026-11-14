import { captureTree } from './git-tree'
import type { RefactorOptions } from './options'
import { isSource, isTextSource } from './source-policy'

/** Return the whole host fingerprint map and its eligible text paths in sorted Git order.
 * runDesign persists the map and sends the eligible files to design. prepareModules uses a fresh
 * inventory after design for planning and plan validation. Snapshot failures, unsafe eligible
 * paths and an empty eligible list reject before the corresponding agent is dispatched. */
export async function inventory({ cwd, include, exclude }: Pick<RefactorOptions, 'cwd' | 'include' | 'exclude'>): Promise<{ tree: Map<string, string>; files: string[] }> {
  const tree = await captureTree(cwd)
  const files: string[] = []
  for (const file of tree.keys()) {
    if (isSource(file, include, exclude) && await isTextSource(cwd, file)) files.push(file)
  }
  if (!files.length) throw new Error('No eligible Git-visible source files found')
  return { tree, files }
}
