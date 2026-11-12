import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'

/** Exclude both conventional metadata paths and the actual configured run storage. */
export async function assertReviewablePath(cwd: string, path: string, workflowDirectory: string): Promise<void> {
  const storage = await realpath(workflowDirectory)
  const fromStorage = relative(storage, path)
  const inStorage = !fromStorage || (!isAbsolute(fromStorage) && fromStorage !== '..' && !fromStorage.startsWith(`..${sep}`))
  const metadata = relative(cwd, path).split(sep).some(part => ['.git', '.anureo', 'node_modules'].includes(part))
  if (inStorage || metadata) throw new HarnessSdkError('REVIEW_INVALID_SOURCE', `Operational metadata cannot be reviewed or fixed as source: ${path}`)
}
