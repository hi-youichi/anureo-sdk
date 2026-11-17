import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { SwarmModel, SwarmModelCatalog } from '@anureo/adapter-swarm'
import type { CodexModel } from '@anureo/adapter-codex/catalog'
import type { PiModel } from '@anureo/adapter-pi/catalog'

export function codexModels(models: readonly CodexModel[]): SwarmModel[] {
  return models.map(model => ({ id: model.id, ...(model.name?.trim() ? { name: model.name } : {}), ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }), ...(model.hidden === undefined ? {} : { hidden: model.hidden }) }))
}

export function claudeModels(models: readonly { value: string; displayName: string; description: string }[]): SwarmModel[] {
  return models.map(model => ({ id: model.value, ...(model.displayName?.trim() ? { name: model.displayName } : {}), ...(model.description?.trim() ? { description: model.description } : {}) }))
}

export function piModels(models: readonly PiModel[]): SwarmModel[] {
  return models.map(model => ({ id: model.ref, ...(model.name?.trim() ? { name: model.name } : {}) }))
}

/** Discovery never prevents a legacy/default-model invocation. Diagnostics remain on stderr. */
export async function loadSwarmModelCatalog(discover: (() => Promise<SwarmModel[]>) | undefined, diagnostic: (message: string) => void): Promise<SwarmModelCatalog> {
  if (!discover) return { default: { status: 'unavailable', reason: 'Backend has no independent model discovery' } }
  try {
    const models = await discover()
    const ids = new Set<string>()
    if (!Array.isArray(models) || models.length > 10_000) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG')
    for (const model of models) {
      if (!model || typeof model.id !== 'string' || !model.id.trim() || model.id !== model.id.trim() || model.id.length > 512 || ids.has(model.id)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG')
      ids.add(model.id)
      for (const [field, limit] of [['name', 512], ['description', 4000]] as const) {
        if (model[field] !== undefined && (typeof model[field] !== 'string' || !model[field].trim() || model[field].length > limit)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG')
      }
      for (const field of ['hidden', 'isDefault'] as const) if (model[field] !== undefined && typeof model[field] !== 'boolean') throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG')
    }
    return { default: { status: 'available', models } }
  }
  catch (cause) {
    const reason = `Model discovery failed: ${sdkError(cause).code}`
    diagnostic(reason)
    return { default: { status: 'unavailable', reason } }
  }
}
