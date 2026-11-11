import { rm } from 'node:fs/promises'

/** Settle every release before deleting test files. Uncertain releases retain their directories. */
export async function cleanupFixtures(clients: Array<{ dispose(): Promise<void> }>, directories: string[]) {
  const ownedDirectories = directories.splice(0)
  const released = await Promise.allSettled(clients.splice(0).map(client => Promise.resolve().then(() => client.dispose())))
  const releaseErrors = released.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (releaseErrors.length) throw new AggregateError(releaseErrors, `Fixture cleanup failed; retained directories: ${ownedDirectories.join(', ')}`)
  const removed = await Promise.allSettled(ownedDirectories.map(path => rm(path, { recursive: true, force: true })))
  const removeErrors = removed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (removeErrors.length) throw new AggregateError(removeErrors, 'Fixture directory cleanup failed')
}
