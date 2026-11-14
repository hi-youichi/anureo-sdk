// Publishes report snapshots atomically; it must not manage writer locks or decide run outcomes.
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RefactorReport } from './results'

/** Internal snapshot writer awaited by checkpointStep and prepareModules before advancing phases,
 * and by finalizeRun before lock release. Resolves after renaming newline-terminated JSON into place.
 * A sibling temporary file keeps readers on the previous complete snapshot until rename succeeds.
 * The run directory must already exist and callers must serialize writes under the writer lock:
 * the fixed temporary path cannot support concurrent saves. Serialization/filesystem errors reject
 * without undoing edits; a failed write/rename may leave the temporary file for inspection. */
export async function saveReport(report: RefactorReport): Promise<void> {
  const path = join(report.directory, 'report.json')
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`)
  await rename(temporary, path)
}
