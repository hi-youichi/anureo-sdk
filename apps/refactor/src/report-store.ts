import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RefactorReport } from './results'

/** Publish the current report as newline-terminated JSON and resolve after replacing report.json.
 * checkpointStep saves the design outcome before its failure gate, prepareModules saves the plan
 * before dispatch, and runModules saves each recorded outcome in integration order. finalizeRun
 * awaits the last publication attempt before releasing the lock.
 * The caller supplies an existing run directory and serializes writes under the writer lock
 * because all saves use the same sibling temporary file. Serialization and filesystem errors
 * reject. A failed write or rename may leave a temporary file beside the previous snapshot. */
export async function saveReport(report: RefactorReport): Promise<void> {
  const path = join(report.directory, 'report.json')
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`)
  await rename(temporary, path)
}
