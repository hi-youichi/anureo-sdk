/** Runs the read-only pinned schema checks for the package and CI. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const legacyPin = { version: '0.148.0', revertDefinition: 'ThreadRollbackParams' } as const
const modernPin = { version: '0.164.0', revertDefinition: 'ThreadRevertParams' } as const
type SchemaPin = typeof legacyPin | typeof modernPin
type SchemaDefinitions = Record<string, unknown>

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
 * Check one pin for the CLI. Verify its byte hash before parsing its definitions and print success
 * after validation. A read, parse or validation failure rejects and halts the CLI before comparison.
 */
async function checkPinnedSchema(pin: SchemaPin): Promise<void> {
  const { version } = pin
  const bytes = await readSchemaBytes(pin)
  const provenancePath = path.join(protocolRoot, version, 'provenance.json')
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as { subsetSha256: string }
  // Hash the original bytes before parsing: equivalent JSON is still a change to a pinned asset.
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== provenance.subsetSha256) {
    throw new Error(`${version}: fixed schema changed without updating provenance`)
  }
  validateDefinitions(pin, parseDefinitions(bytes))
  console.log(`${version}: schema hash and native mapping verified`)
}

/** Load raw bytes for verification and the later comparison, propagating filesystem errors. */
function readSchemaBytes({ version }: SchemaPin): Promise<Buffer> {
  return readFile(path.join(protocolRoot, version, 'native.schema.json'))
}

/** Decode one pinned UTF-8 schema and return its definitions for the checks or report. Invalid JSON throws. */
function parseDefinitions(bytes: Buffer): SchemaDefinitions {
  const schema = JSON.parse(bytes.toString('utf8')) as { definitions: SchemaDefinitions }
  return schema.definitions
}

/**
 * For checkPinnedSchema, require the shared vocabulary before checking the pin's exclusive revert
 * contract. Throw on the first violation.
 */
function validateDefinitions({ version, revertDefinition }: SchemaPin, definitions: SchemaDefinitions): void {
  for (const definitionName of requiredDefinitionNames) {
    if (!definitions[definitionName]) {
      throw new Error(`${version}: missing ${definitionName}`)
    }
  }
  const otherDefinition = revertDefinition === 'ThreadRevertParams' ? 'ThreadRollbackParams' : 'ThreadRevertParams'
  if (!definitions[revertDefinition] || definitions[otherDefinition]) {
    throw new Error(`${version}: unsafe revert/rollback mapping`)
  }
}

/** Reread both schemas in version order after verification and print the watched method changes. Read and parse failures reject the CLI before the diff is printed. */
async function reportSchemaChanges(): Promise<void> {
  const legacy = parseDefinitions(await readSchemaBytes(legacyPin))
  const modern = parseDefinitions(await readSchemaBytes(modernPin))
  const watched = [
    'ThreadRollbackParams',
    'ThreadRevertParams',
    'ThreadSettingsUpdateParams',
    'ThreadTurnsListParams',
    'ThreadItemsListParams',
  ]
  console.log(JSON.stringify({
    addedIn0164: watched.filter(name => !legacy[name] && modern[name]),
    removedIn0164: watched.filter(name => legacy[name] && !modern[name]),
  }))
}

for (const pin of [legacyPin, modernPin]) await checkPinnedSchema(pin)
await reportSchemaChanges()
