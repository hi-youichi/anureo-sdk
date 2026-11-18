import { sdkError } from '@anureo/sdk'
import { parseModelCatalog, type SwarmModel, type SwarmModelCatalog } from '@anureo/adapter-swarm'
import type { CodexModel } from '@anureo/adapter-codex/catalog'
import type { PiModel } from '@anureo/adapter-pi/catalog'

export function codexModels(models: readonly CodexModel[]): SwarmModel[] {
  return models.map(model => ({
    id: model.id,
    ...(model.name?.trim() ? { name: model.name } : {}),
    ...(model.description?.trim() ? { description: model.description } : {}),
    ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
    ...(model.hidden === undefined ? {} : { hidden: model.hidden }),
    ...(model.efforts === undefined ? {} : { efforts: model.efforts.map(effort => ({ id: effort.id, ...(effort.description?.trim() ? { description: effort.description } : {}) })) }),
    ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
    ...(model.serviceTiers === undefined ? {} : { serviceTiers: model.serviceTiers.filter(tier => tier.trim()) }),
    ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
  }))
}

export function claudeModels(models: readonly { value: string; displayName: string; description: string; supportsEffort?: boolean; supportedEffortLevels?: readonly string[] }[]): SwarmModel[] {
  return models.map(model => ({ id: model.value, ...(model.displayName?.trim() ? { name: model.displayName } : {}), ...(model.description?.trim() ? { description: model.description } : {}),
    ...(model.supportedEffortLevels === undefined ? model.supportsEffort === false ? { efforts: [] } : {} : { efforts: model.supportedEffortLevels.map(id => ({ id })) }),
  }))
}

export function piModels(models: readonly PiModel[]): SwarmModel[] {
  return models.map(model => ({ id: model.ref, ...(model.name?.trim() ? { name: model.name } : {}), efforts: model.thinkingLevels.map(id => ({ id })) }))
}

/** Discovery never prevents a legacy/default-model invocation. Diagnostics remain on stderr. */
export async function loadSwarmModelCatalog(discover: (() => Promise<SwarmModel[]>) | undefined, diagnostic: (message: string) => void, effortConfigKey?: 'effort' | 'thinkingLevel'): Promise<SwarmModelCatalog> {
  const mapping = effortConfigKey ? { effortConfigKey } : {}
  if (!discover) return { default: { status: 'unavailable', ...mapping, reason: 'Backend has no independent model discovery' } }
  try {
    const models = await discover()
    return { default: parseModelCatalog({ default: { status: 'available', ...mapping, models } }).default! }
  }
  catch (cause) {
    const reason = `Model discovery failed: ${sdkError(cause).code}`
    diagnostic(reason)
    return { default: { status: 'unavailable', ...mapping, reason } }
  }
}
