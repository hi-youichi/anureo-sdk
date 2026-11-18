// Real independent process; pause after observing G so both writers compete for G+1.
import { createInterface } from 'node:readline'
import { FileEvolutionStore } from '../src/evolution'

const [directory, mode, profileId, generation, targetId] = process.argv.slice(2)
const input = createInterface({ input: process.stdin })
const released = new Promise<void>(resolve => input.once('line', () => resolve()))
class RacingStore extends FileEvolutionStore {
  private observed = false
  override async resolve(id: string) {
    const value = await super.resolve(id)
    if (!this.observed) {
      this.observed = true
      console.log(JSON.stringify({ ready: true, generation: value?.head.generation }))
      await released
    }
    return value
  }
}
try {
  const store = new RacingStore({ directory, scope: 'project' })
  const result = mode === 'publish'
    ? await store.publish(profileId, Number(generation), targetId)
    : await store.rollback(profileId, targetId, Number(generation), 'Concurrent rollback')
  console.log(JSON.stringify({ result }))
} finally { input.close() }
