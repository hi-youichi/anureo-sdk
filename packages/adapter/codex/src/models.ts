/** Projects read-only native model pages for discovery callers; it must not own connections or create threads. */
import { HarnessSdkError } from '@anureo/sdk'
import type { CodexJsonlClient } from './jsonl'
import { record, string } from './native-values'

/** Metadata returned to catalog and adapter discovery callers, including hidden models; optional fields follow native metadata and carry no connection ownership. */
export type CodexModel = {
  /** Native id, falling back to the native model field when id is not a string. */
  id: string
  /** Native display label, falling back to the model identity. */
  name: string
  /** Present only when the native response marks this model as the default. */
  isDefault?: boolean
  /** Present only when the native response hides this model from the usual picker. */
  hidden?: boolean
  /** Supported reasoning effort IDs and optional picker descriptions. */
  efforts?: Array<{ id: string; description?: string }>
  /** Nonempty native default reasoning effort ID, when provided. */
  defaultEffort?: string
  /** Service tiers the model accepts; 'priority' is Codex's fast tier. */
  serviceTiers?: string[]
}

/** Project one native page entry for the pagination reader without mutation or I/O. Reject missing/empty identities; omit invalid optional entries and empty effort IDs, retaining tier strings and native ordering. */
function decodeModel(entry: unknown): CodexModel {
  const model = record(entry)
  const id = string(model.id) ?? string(model.model)
  if (!id) throw new HarnessSdkError('PROTOCOL_ERROR')

  const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.flatMap(item => {
    const option = record(item)
    const effort = string(option.reasoningEffort)
    const description = string(option.description)
    return effort ? [{ id: effort, ...(description ? { description } : {}) }] : []
  }) : undefined
  const defaultEffort = string(model.defaultReasoningEffort)
  const serviceTiers = Array.isArray(model.serviceTiers) ? model.serviceTiers.flatMap(item => string(record(item).id) ?? []) : undefined

  return {
    id,
    name: string(model.displayName) ?? string(model.name) ?? id,
    ...(model.isDefault === true ? { isDefault: true } : {}),
    ...(model.hidden === true ? { hidden: true } : {}),
    ...(efforts ? { efforts } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(serviceTiers ? { serviceTiers } : {}),
  }
}

/** For catalog and adapter probes, read model pages sequentially on an initialized client, retaining native order and hidden entries. Reject malformed entries, repeated cursors, more than 10,000 models or transport errors; never create threads or dispose the caller's client. */
export async function readCodexModels(client: CodexJsonlClient): Promise<CodexModel[]> {
  const models: CodexModel[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = record(await client.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) }))
    if (!Array.isArray(page.data)) throw new HarnessSdkError('PROTOCOL_ERROR')
    for (const entry of page.data) models.push(decodeModel(entry))
    // Validate the complete page before the limit/cursor checks to preserve failure precedence.
    if (models.length > 10_000) throw new HarnessSdkError('MODEL_LIMIT_EXCEEDED')
    cursor = string(page.nextCursor)
    if (cursor && seen.has(cursor)) throw new HarnessSdkError('PROTOCOL_ERROR', 'Repeated native model cursor')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return models
}
