/** Projects ACP wire content and updates for the adapter; exports are package-internal. */
import { acpFileChanges } from './file-changes';
import type { Item, InputBlock, JsonValue, JsonObject, ConfigOption, Capabilities, SessionState } from '@anureo/protocol';
import { publicValue } from '@anureo/protocol';
import { HarnessSdkError, type SessionEventSink } from '@anureo/sdk';
import type { ContentBlock, McpServer } from '@agentclientprotocol/sdk';

/** Read a native object without cloning it; arrays, null and primitives become an empty record. */
export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/**
 * Make a detached JSON copy and apply publicValue redaction before retaining native payloads.
 * Nullish values become null; JSON serialization/parsing errors propagate to the caller.
 * Callers still own removal of secrets embedded in arbitrary text.
 */
export function safe(value: unknown): JsonValue { return publicValue(JSON.parse(JSON.stringify(value ?? null)) as JsonValue); }
/** Flatten supported native content to text in source order; unsupported blocks contribute no text. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('\n');
  const object = record(value);
  if (object.type === 'text' && typeof object.text === 'string') return object.text;
  if (object.type === 'content') return text(object.content);
  if (object.type === 'diff') return `${typeof object.oldText === 'string' ? object.oldText : ''}\n${typeof object.newText === 'string' ? object.newText : ''}`;
  if (object.type === 'resource') return text(object.resource);
  return '';
}
/**
 * Translate prompt blocks for AcpBackendSession's standard and correlated submissions.
 * Throws INVALID_PARAMS before dispatch when an image lacks inline data or a MIME type.
 */
export function input(blocks: InputBlock[]): ContentBlock[] {
  return blocks.map((block): ContentBlock => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'file') return { type: 'resource_link', uri: block.uri, name: block.name ?? block.uri, ...(block.mimeType ? { mimeType: block.mimeType } : {}) };
    if (!block.data || !block.mimeType) throw new HarnessSdkError('INVALID_PARAMS', 'ACP images require inline data and mimeType');
    return { type: 'image', data: block.data, mimeType: block.mimeType, ...(block.url ? { uri: block.url } : {}) };
  });
}
/**
 * Build ACP server entries for AcpAdapter.openSession without connecting to any server.
 * Omitted servers, stdio arguments, headers and environment entries default to empty collections.
 */
export function mcp(servers: import('@anureo/protocol').McpServer[] = []): McpServer[] {
  return servers.map((server) => server.type === 'http'
    ? { type: 'http', name: server.name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }
    : { name: server.name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) });
}
/**
 * Project supported native configuration for AcpBackendSession.configure to store in capabilities
 * and current state. Keys retain native descriptors for setConfiguration to address the peer;
 * model aliases share their native descriptor, and absent current values remain absent.
 */
export function configuration(data: Record<string, unknown>): { options: ConfigOption[]; values: JsonObject; keys: Map<string, Record<string, unknown>> } {
  const options: ConfigOption[] = [], values: JsonObject = {}, keys = new Map<string, Record<string, unknown>>();
  /** Keep the advertised descriptor, current value and native dispatch key aligned, including aliases. */
  function registerOption(descriptor: ConfigOption, nativeOption: Record<string, unknown>): void {
    options.push(descriptor);
    keys.set(descriptor.id, nativeOption);
    if (descriptor.value !== undefined) values[descriptor.id] = descriptor.value;
  }
  for (const item of Array.isArray(data.configOptions) ? data.configOptions : []) {
    const option = record(item); if (typeof option.id !== 'string') continue;
    const id = option.id; const current = option.currentValue;
    if (option.type !== 'boolean' && option.type !== 'select') continue;
    const schema: JsonObject = option.type === 'boolean' ? { type: 'boolean' } : { type: 'string', enum: selectValues(option.options) };
    const descriptor: ConfigOption = { id, title: typeof option.name === 'string' ? option.name : id, scope: 'session', schema, ...(typeof current === 'string' || typeof current === 'boolean' ? { value: current } : {}) };
    registerOption(descriptor, option);
    if (option.category === 'model' && id !== 'model') {
      // The model alias still maps to the original native option.
      registerOption({ ...descriptor, id: 'model' }, option);
    }
  }
  const modes = record(data.modes);
  if (Array.isArray(modes.availableModes)) {
    const modeIds = modes.availableModes.map((mode) => record(mode).id).filter((id): id is string => typeof id === 'string');
    options.push({ id: 'mode', title: 'ACP mode', scope: 'session', schema: { type: 'string', enum: modeIds } });
    keys.set('mode', { id: 'mode', type: 'mode', options: modeIds });
    if (typeof modes.currentModeId === 'string') values.mode = modes.currentModeId;
  }
  return { options, values, keys };
}

/**
 * Project one execution's native updates into ordered item events and session patches.
 * AcpBackendSession owns one mapper per correlated turn or resets its standard mapper before reuse.
 * Callers await updates in source order and complete before publishing turn completion. Sink and
 * callback failures reject without rollback; the caller owns observation failure and session cleanup.
 */
export class AcpUpdateMapper {
  /**
   * AcpBackendSession supplies the sink and callbacks: getTurn reads the execution identity,
   * state reads its snapshot, and setState synchronously applies configure/title patches.
   * Construction performs no I/O; subagents enables projection of negotiated subagent updates.
   */
  constructor(private readonly sink: SessionEventSink, private readonly getTurn: () => string | undefined, private readonly state: () => SessionState, private readonly setState: (data: Record<string, unknown>) => void, private readonly subagents: boolean) {}
  /** Forget execution-local caches without emitting events; beginStandardSubmission calls this before reuse. */
  reset(): void { this.items.clear(); this.ended.clear(); this.compaction.clear(); this.serial = 0; }
  /**
   * Flush unended cached items in insertion order, promoting running status to completed.
   * submitStandardInput and nativeEvent await this before turn/completed; publication failures
   * reject and leave earlier publications intact. With no current turn, no items are published.
   */
  async complete(): Promise<void> {
    for (const item of this.items.values()) if (!this.ended.has(item.id)) await this.upsert({ ...item, status: item.status === 'running' ? 'completed' : item.status }, 'completion');
  }
  /**
   * Await projection/publication of one native update forwarded by AcpBackendSession.update.
   * Session patches work while idle; other idle updates and unsupported content become notices.
   * State is mutated before publication where needed and is not rolled back on rejection.
   */
  async update(update: Record<string, unknown>): Promise<void> {
    const kind = update.sessionUpdate;
    const turnId = this.getTurn();
    if (kind === 'config_option_update' || kind === 'current_mode_update') {
      this.setState(update); await this.sink.emit({ type: 'session/state', payload: this.state() }); return;
    }
    if (kind === 'usage_update') {
      await this.sink.emit({ type: 'usage/updated', payload: { provider: 'acp', scope: 'session', source: 'native', ...(typeof update.used === 'number' ? { contextUsed: update.used } : {}), ...(typeof update.size === 'number' ? { contextWindow: update.size } : {}) } }, { ...(turnId ? { turnId } : {}) }); return;
    }
    if (kind === 'session_info_update') {
      await this.updateMetadata(update);
      return;
    }
    if (!turnId || kind === 'available_commands_update') {
      await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: `ACP_${String(kind ?? 'UPDATE').toUpperCase()}`, message: 'ACP session metadata update', raw: safe(update) } }); return;
    }
    if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(String(kind))) {
      await this.updateMessage(update, turnId); return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      await this.updateToolCall(update); return;
    }
    if (kind === 'plan' || kind === 'plan_update' || kind === 'plan_removed') {
      await this.updatePlan(update); return;
    }
    if (kind === 'compaction_update' || kind === 'compaction_summary_chunk') {
      await this.updateCompaction(update); return;
    }
    if ((kind === 'subagent_spawned' || kind === 'subagent_state_update') && this.subagents) {
      await this.updateSubagent(update); return;
    }
    await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_UNKNOWN_UPDATE', message: 'Unmapped ACP update retained', raw: safe(update) } }, { turnId });
  }
  private readonly items = new Map<string, Item>();
  private readonly ended = new Set<string>();
  private serial = 0;
  private compaction = new Map<string, string>();
  /**
   * Cache snapshots before publication, starting unseen items before any completion.
   * Completed IDs accept cache changes silently; failures preserve mutations already made.
   */
  private async upsert(item: Item, publication: 'snapshot' | 'completion' = 'snapshot'): Promise<void> {
    const turnId = this.getTurn();
    if (!turnId) return;

    const previousItem = this.items.get(item.id);
    // Always update the cache; ended items no longer emit events.
    this.items.set(item.id, item);
    if (this.ended.has(item.id)) return;

    if (!previousItem) {
      // A first update that is already complete still emits started before completed.
      await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId });
    } else if (publication === 'snapshot') {
      await this.sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'patch', value: safe(item) } }, { turnId });
    }
    if (publication === 'completion') {
      this.ended.add(item.id);
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId });
    }
  }
  /** Apply title patches before publication; omission/invalid titles preserve state and null clears it. */
  private async updateMetadata(update: Record<string, unknown>): Promise<void> {
    if (Object.hasOwn(update, 'title') && (typeof update.title === 'string' || update.title === null)) {
      const title = update.title;
      if (this.state().metadata?.title !== title) {
        this.setState({ sessionTitle: title });
        await this.sink.emit({ type: 'session/metadata', payload: { title } });
      }
    }
  }
  /** Accumulate message chunks and await their deltas, retaining unsupported content in notices.
   * Agent/reasoning items use text deltas; user items use full patches. All remain open until complete. */
  private async updateMessage(update: Record<string, unknown>, turnId: string): Promise<void> {
    const kind = update.sessionUpdate;
    const nativeId = typeof update.messageId === 'string' ? update.messageId : String(kind);
    const id = `${String(kind)}:${nativeId}`;
    const chunk = text(update.content);
    if (!chunk && record(update.content).type !== 'text') await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_NON_TEXT_CONTENT', message: 'ACP non-text content retained', raw: safe(update.content) } }, { turnId });
    let item = this.items.get(id);
    if (!item) {
      item = kind === 'agent_thought_chunk' ? { id, type: 'reasoning', text: '' }
        : kind === 'user_message_chunk' ? { id, type: 'userMessage', content: [] }
        : { id, type: 'agentMessage', text: '', phase: 'final' };
      this.items.set(id, item); await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId });
    }
    if (item.type === 'userMessage') {
      const content = record(update.content);
      if (content.type === 'text') item.content.push({ type: 'text', text: chunk });
      else if (content.type === 'image' && typeof content.data === 'string') item.content.push({ type: 'image', data: content.data, mimeType: typeof content.mimeType === 'string' ? content.mimeType : undefined });
      else if (content.type === 'resource_link' && typeof content.uri === 'string') item.content.push({ type: 'file', uri: content.uri });
      else await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_UNKNOWN_CONTENT', message: 'ACP user content', raw: safe(update.content) } }, { turnId });
      await this.sink.emit({ type: 'item/delta', payload: { itemId: id, kind: 'patch', value: safe(item) } }, { turnId });
    } else if (item.type === 'agentMessage' || item.type === 'reasoning') {
      item.text = (item.text ?? '') + chunk;
      await this.sink.emit({ type: 'item/delta', payload: { itemId: id, kind: 'text', text: chunk } }, { turnId });
    }
  }
  /** Merge sparse tool patches so omission preserves prior fields; explicit content replaces materials.
   * Defined rawOutput, including null, takes precedence over content as the output snapshot. */
  private async updateToolCall(update: Record<string, unknown>): Promise<void> {
    const id = String(update.toolCallId);
    const previousItem = this.items.get(id);
    const previousToolCall = previousItem?.type === 'toolCall' ? previousItem : undefined;
    const kindMap: Record<string, 'command' | 'fileChange' | 'web' | 'other'> = { execute: 'command', edit: 'fileChange', delete: 'fileChange', move: 'fileChange', fetch: 'web' };
    let status: Item['status'] = 'running';
    if (update.status === 'failed') {
      status = 'failed';
    } else if (update.status === 'completed') {
      status = 'completed';
    } else if (update.status === undefined && previousToolCall) {
      status = previousToolCall.status ?? 'running';
    }
    const baseItem: Item = {
      ...(previousToolCall ?? { id, type: 'toolCall', kind: 'other', title: 'ACP tool' }),
      ...(typeof update.title === 'string' ? { title: update.title } : {}), ...(typeof update.kind === 'string' ? { kind: kindMap[update.kind] ?? 'other', nativeType: update.kind } : {}), status,
      ...(update.content !== undefined ? { fileChanges: acpFileChanges(update.content) } : {}),
      ...(update.rawInput !== undefined ? { input: safe(update.rawInput) } : {}),
    };
    let outputPatch: { output?: JsonValue } = {};
    // Any defined rawOutput, including null, takes precedence over content.
    if (update.rawOutput !== undefined) {
      outputPatch = { output: safe(update.rawOutput) };
    } else if (update.content !== undefined) {
      outputPatch = { output: safe(update.content) };
    }
    const item: Item = {
      ...baseItem,
      ...outputPatch,
      ...(Array.isArray(update.locations) ? { locations: toolLocations(update.locations) } : {}),
    };
    await this.upsert(item, status !== 'running' ? 'completion' : 'snapshot');
  }
  /** Keep the standard plan's fixed identity and extension plans' native or generated identities.
   * Only extension removal closes a plan here; other plan snapshots remain open until complete. */
  private async updatePlan(update: Record<string, unknown>): Promise<void> {
    const kind = update.sessionUpdate;
    if (kind === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      await this.upsert({
        id: 'acp-plan',
        type: 'plan',
        steps: entries.map((entry, index) => {
          const value = record(entry);
          return {
            id: String(index),
            text: String(value.content ?? ''),
            status: value.status === 'completed' ? 'completed' : value.status === 'in_progress' ? 'inProgress' : 'pending',
          };
        }),
      });
      return;
    }
    const plan = record(update.plan);
    const id = `plan:${String(update.planId ?? plan.planId ?? ++this.serial)}`;
    await this.upsert({
      id,
      type: 'plan',
      steps: kind === 'plan_removed' ? [] : [{ id: 'content', text: text(plan.content ?? record(plan).markdown ?? plan), status: 'pending' }],
      extensions: { 'x-acp/native-plan': safe(update) },
    }, kind === 'plan_removed' ? 'completion' : 'snapshot');
  }
  /** Accumulate summary chunks, replace explicit summaries, and close only on native terminal status. */
  private async updateCompaction(update: Record<string, unknown>): Promise<void> {
    const kind = update.sessionUpdate;
    const id = `compaction:${String(update.compactionId)}`;
    let summary = this.compaction.get(id) ?? '';
    if (kind === 'compaction_summary_chunk') summary += text(update.content);
    else if ('summary' in update) summary = text(update.summary);
    this.compaction.set(id, summary);
    const terminal = update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled';
    await this.upsert({ id, type: 'compaction', summary, status: update.status === 'failed' ? 'failed' : update.status === 'cancelled' ? 'interrupted' : terminal ? 'completed' : 'running' }, terminal ? 'completion' : 'snapshot');
  }
  /** Merge negotiated subagent fields and publish a terminal snapshot when its native state ends. */
  private async updateSubagent(update: Record<string, unknown>): Promise<void> {
    const id = `subagent:${String(update.subagentSessionId)}`; const old = this.items.get(id);
    const state = update.state === 'completed' ? 'completed' : ['cancelled', 'disconnected'].includes(String(update.state)) ? 'interrupted' : update.state === 'failed' ? 'failed' : 'running';
    await this.upsert({ ...(old?.type === 'subagent' ? old : { id, type: 'subagent', subagentId: String(update.subagentSessionId) }), state, ...(typeof update.name === 'string' ? { name: update.name } : {}), ...(typeof update.task === 'string' ? { task: update.task } : {}) }, state !== 'running' ? 'completion' : 'snapshot');
  }
}

/**
 * Resolves a host-supplied config value to the exact wire value an agent advertises.
 *
 * AcpAdapter.openSession uses this for its model override before applying configuration.
 * Returns the requested value when no nonempty string enum constrains it, otherwise accepts
 * an exact match or a unique provider-qualified suffix. Throws CAPABILITY_UNSUPPORTED for
 * a missing session option and INVALID_PARAMS for an unknown or ambiguous enum value.
 *
 * Agents such as DSH publish model choices as `provider/model`, so a bare
 * `deepseek-v4-flash` must be resolved before `session/set_config_option`;
 * otherwise the AHP schema guard or the backend rejects the value.
 */
export function resolveConfigValue(capabilities: Capabilities, key: string, wanted: string): string {
  const option = (capabilities.config?.options ?? []).find((entry) => entry.id === key && entry.scope === 'session');
  if (!option) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', `Backend does not expose the ${key} config option`);
  const schema = option.schema;
  const values = schema && typeof schema === 'object' && !Array.isArray(schema) && schema.type === 'string' && Array.isArray(schema.enum)
    ? schema.enum.filter((value): value is string => typeof value === 'string')
    : [];
  if (values.length === 0 || values.includes(wanted)) return wanted;
  const matches = values.filter((value) => value.endsWith(`/${wanted}`) || value.split('/').pop() === wanted);
  if (matches.length === 1) return matches[0]!;
  throw new HarnessSdkError('INVALID_PARAMS', `Unknown ${key} value`, false, false, { key, wanted, accepted: values });
}

/** Flatten grouped ACP select choices in advertised order; non-array groups contribute no values. */
function selectValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = record(entry);
    return typeof option.value === 'string' ? [option.value] : selectValues(option.options);
  });
}

/** Preserve path-bearing tool locations in native order, retaining a line only when numeric. */
function toolLocations(locations: unknown[]): { path: string; line?: number }[] {
  return locations.flatMap((location) => {
    const value = record(location);
    return typeof value.path === 'string'
      ? [{ path: value.path, ...(typeof value.line === 'number' ? { line: value.line } : {}) }]
      : [];
  });
}
