/** Checks pinned protocol schema provenance and version mappings; it must not regenerate or modify schemas. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** Minimum native request/item vocabulary needed by both supported profiles. */
const requiredDefinitionNames = [
  'ThreadStartParams',
  'ThreadResumeParams',
  'ThreadForkParams',
  'TurnStartParams',
  'TurnSteerParams',
  'TurnInterruptParams',
  'ThreadItem',
]

const protocolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'protocol')

/**
 * For the sequential CLI checks, read one pinned version, verify provenance before interpreting its
 * definitions, and log success only after required vocabulary and revert mapping pass. Reject file/JSON
 * errors or the first invariant violation; never write protocol assets.
 */
async function checkPinnedSchema(version: string): Promise<void> {
  const bytes = await readFile(path.join(protocolRoot, version, 'native.schema.json'))
  const provenance = JSON.parse(await readFile(path.join(protocolRoot, version, 'provenance.json'), 'utf8')) as { subsetSha256: string }
  if (createHash('sha256').update(bytes).digest('hex') !== provenance.subsetSha256) throw new Error(`${version}: fixed schema changed without updating provenance`)
  // Hash the original bytes before parsing: equivalent JSON is still a change to a pinned asset.
  const schema = JSON.parse(bytes.toString()) as { definitions: Record<string, unknown> }
  for (const definitionName of requiredDefinitionNames) {
    if (!schema.definitions[definitionName]) {
      throw new Error(`${version}: missing ${definitionName}`)
    }
  }
  const hasRevertParams = !!schema.definitions.ThreadRevertParams
  const hasRollbackParams = !!schema.definitions.ThreadRollbackParams
  // Each native line must expose exactly one boundary contract; the methods are not interchangeable.
  const matchesExpectedVersion = hasRevertParams === (version === '0.164.0')
  const hasExclusiveMapping = hasRevertParams !== hasRollbackParams
  if (!matchesExpectedVersion || !hasExclusiveMapping) throw new Error(`${version}: unsafe revert/rollback mapping`)
  console.log(`${version}: schema hash and native mapping verified`)
}

/** For the post-validation comparison, read and parse one version's definitions without writes; filesystem/JSON errors reject. This read deliberately follows the provenance checks. */
async function readSchemaDefinitions(version: string): Promise<Record<string, unknown>> {
  const schema = JSON.parse(await readFile(path.join(protocolRoot, version, 'native.schema.json'), 'utf8'))
  return schema.definitions
}

/** After both checks succeed, reread pinned schemas in version order and print the watched method changes for CLI consumers. Reject read/JSON errors; no files are modified. */
async function reportSchemaChanges(): Promise<void> {
  const legacy = await readSchemaDefinitions('0.148.0')
  const modern = await readSchemaDefinitions('0.164.0')
  const watched = ['ThreadRollbackParams','ThreadRevertParams','ThreadSettingsUpdateParams','ThreadTurnsListParams','ThreadItemsListParams']
  console.log(JSON.stringify({ addedIn0164: watched.filter(name => !legacy[name] && modern[name]), removedIn0164: watched.filter(name => legacy[name] && !modern[name]) }))
}

for (const version of ['0.148.0', '0.164.0']) await checkPinnedSchema(version)
await reportSchemaChanges()
