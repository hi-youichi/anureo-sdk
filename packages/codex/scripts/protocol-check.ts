import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const requiredDefinitionNames = [
  'ThreadStartParams',
  'ThreadResumeParams',
  'ThreadForkParams',
  'TurnStartParams',
  'TurnSteerParams',
  'TurnInterruptParams',
  'ThreadItem',
]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'protocol')
for (const version of ['0.148.0', '0.164.0']) {
  const bytes = await readFile(path.join(root, version, 'native.schema.json'))
  const provenance = JSON.parse(await readFile(path.join(root, version, 'provenance.json'), 'utf8')) as { subsetSha256: string }
  if (createHash('sha256').update(bytes).digest('hex') !== provenance.subsetSha256) throw new Error(`${version}: fixed schema changed without updating provenance`)
  const schema = JSON.parse(bytes.toString()) as { definitions: Record<string, unknown> }
  for (const definitionName of requiredDefinitionNames) {
    if (!schema.definitions[definitionName]) {
      throw new Error(`${version}: missing ${definitionName}`)
    }
  }
  const hasRevertParams = !!schema.definitions.ThreadRevertParams
  const hasRollbackParams = !!schema.definitions.ThreadRollbackParams
  const matchesExpectedVersion = hasRevertParams === (version === '0.164.0')
  const hasExclusiveMapping = hasRevertParams !== hasRollbackParams
  if (!matchesExpectedVersion || !hasExclusiveMapping) throw new Error(`${version}: unsafe revert/rollback mapping`)
  console.log(`${version}: schema hash and native mapping verified`)
}

const legacy = JSON.parse(await readFile(path.join(root, '0.148.0', 'native.schema.json'), 'utf8')).definitions as Record<string, unknown>
const modern = JSON.parse(await readFile(path.join(root, '0.164.0', 'native.schema.json'), 'utf8')).definitions as Record<string, unknown>
const watched = ['ThreadRollbackParams','ThreadRevertParams','ThreadSettingsUpdateParams','ThreadTurnsListParams','ThreadItemsListParams']
console.log(JSON.stringify({ addedIn0164: watched.filter(name => !legacy[name] && modern[name]), removedIn0164: watched.filter(name => legacy[name] && !modern[name]) }))
