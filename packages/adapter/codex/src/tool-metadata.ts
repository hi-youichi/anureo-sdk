import type { JsonObject, ToolCallItem } from '@anureo/protocol'
import { record, safe, string, type NativeRecord } from './native-values'

/** Project evidence from each native snapshot for both live and history items. */
export function toolExtensions(raw: NativeRecord): Pick<ToolCallItem, 'extensions'> {
  const execution: JsonObject = {}
  if (typeof raw.exitCode === 'number' && Number.isInteger(raw.exitCode)) execution.exitCode = raw.exitCode
  if (typeof raw.signal === 'string') execution.signal = raw.signal
  if (typeof raw.cwd === 'string') execution.cwd = raw.cwd
  if (typeof raw.success === 'boolean') execution.success = raw.success
  const error = string(raw.error) ?? string(record(raw.error).message)
  if (error?.trim()) {
    execution.error = { kind: raw.type === 'mcpToolCall' ? 'protocol' : 'tool', message: error }
  }

  const extensions: JsonObject = {}
  if (Object.keys(execution).length) extensions.toolExecution = execution
  if (raw.type === 'mcpToolCall') {
    const metadata = mcpDisplayMetadata(raw)
    if (Object.keys(metadata).length) extensions.mcp = metadata
  }
  return Object.keys(extensions).length ? { extensions: safe(extensions) as JsonObject } : {}
}

/** Use an allowlist for native display data. A resource URI identifies a widget for display. */
function mcpDisplayMetadata(raw: NativeRecord): JsonObject {
  const app = record(raw.appContext)
  const definition = record(raw.toolDefinition)
  const meta = record(definition._meta)
  const display = record(raw.toolDisplay)
  const source = record(raw.source)
  const result: JsonObject = {}

  for (const key of ['functionName', 'pluginId', 'sourceName']) {
    const value = string(raw[key])
    if (value?.trim()) result[key] = value
  }
  for (const key of ['connectorId', 'linkId', 'appName', 'actionName']) {
    const value = string(app[key])
    if (value?.trim()) result[key] = value
  }
  for (const key of ['logoUrl', 'logoDarkUrl']) {
    const url = httpDisplayUrl(raw[key])
    if (url) result[key] = url
  }

  const title = string(definition.title)
  if (title?.trim()) result.toolTitle = title
  const labels: JsonObject = {}
  for (const key of ['title', 'invoking', 'invoked']) {
    const label = string(display[key])
    const fallback = key === 'title' ? undefined : string(meta[`openai/toolInvocation/${key}`])
    const value = label?.trim() ? label : fallback
    if (value?.trim()) labels[key] = value
  }
  if (Object.keys(labels).length) result.display = labels

  const kind = string(source.kind)
  if (kind?.trim()) {
    const backend = string(source.backend)
    const url = httpDisplayUrl(source.url)
    result.source = { kind, ...(backend?.trim() ? { backend } : {}), ...(url ? { url } : {}) }
  }

  const resourceUri = [record(raw.mcpAppUi).resourceUri, app.resourceUri, raw.mcpAppResourceUri]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (resourceUri) {
    result.resourceUri = resourceUri
    result.isAppWidget = true
  }
  return result
}

function httpDisplayUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const url = URL.parse(value)
  if (url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
    return url.href
  }
}
