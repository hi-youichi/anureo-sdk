import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BeeProfileReview } from '@anureo/adapter-swarm'

export async function saveProfileProposal(
  project: string,
  review: Extract<BeeProfileReview, { status: 'proposed' }>,
  sourceFile = review.sourceFile,
): Promise<string> {
  const directory = join(project, '.anureo', 'evolution', ...(review.profileSource ? [review.profileSource.scope] : []), review.profileId, 'proposals')
  const id = randomUUID()
  const file = join(directory, `${id}.json`)
  const temporary = join(directory, `.${id}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(temporary, JSON.stringify({ ...review, id, sourceFile, createdAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' })
    await rename(temporary, file)
    return file
  } catch (cause) {
    await unlink(temporary).catch(() => {})
    throw cause
  }
}
