import { HarnessSdkError } from '@anureo/sdk'
import type { CodexJsonlClient } from './jsonl'
import { record, string } from './native-values'

/** Model metadata returned by catalog and adapter discovery, including entries hidden from the usual picker. */
export type CodexModel = {
  /** Nonempty native id, or the native model field if id is absent or non-string. */
  id: string
  /** First string among the native displayName, name and resolved id fields, including an empty label. */
  name: string
  /** Present only when the native response marks this model as the default. */
  isDefault?: boolean
  /** Present only when the native response hides this model from the usual picker. */
  hidden?: boolean
  /** Nonempty reasoning effort IDs with optional picker descriptions. An empty list is retained. */
  efforts?: Array<{ id: string; description?: string }>
  /** Nonempty native default reasoning effort ID, when provided. */
  defaultEffort?: string
  /** Native service-tier IDs in response order, including empty strings. Codex uses priority for fast mode. */
  serviceTiers?: string[]
}

/**
 * Read model pages sequentially on an initialized client, retaining native order and hidden
 * entries. Catalog listModels and CodexNativeAdapter.listModels return this array to hosts.
 * A missing, empty or non-string next cursor ends pagination. Reject malformed pages or model
 * identities, repeated cursors, more than 10,000 models and RPC failures. The caller owns the client.
 */
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

/**
 * Project a native page entry for readCodexModels. An empty native id is invalid even when model
 * is present. Throw PROTOCOL_ERROR for an invalid identity and omit malformed optional fields
 * or list entries while preserving valid entries in native order.
 */
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
