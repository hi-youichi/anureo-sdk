import { acpFileChanges } from './file-changes';
import type { Item, InputBlock, JsonValue, JsonObject, ConfigOption, Capabilities, SessionState } from '@anureo/protocol';
import { publicValue } from '@anureo/protocol';
import { HarnessSdkError, type SessionEventSink } from '@anureo/sdk';
import type { ContentBlock, McpServer } from '@agentclientprotocol/sdk';

export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function safe(value: unknown): JsonValue { return publicValue(JSON.parse(JSON.stringify(value ?? null)) as JsonValue); }
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
export function input(blocks: InputBlock[]): ContentBlock[] {
  return blocks.map((block): ContentBlock => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'file') return { type: 'resource_link', uri: block.uri, name: block.name ?? block.uri, ...(block.mimeType ? { mimeType: block.mimeType } : {}) };
    if (!block.data || !block.mimeType) throw new HarnessSdkError('INVALID_PARAMS', 'ACP images require inline data and mimeType');
    return { type: 'image', data: block.data, mimeType: block.mimeType, ...(block.url ? { uri: block.url } : {}) };
  });
}
export function mcp(servers: import('@anureo/protocol').McpServer[] = []): McpServer[] {
  return servers.map((server) => server.type === 'http'
    ? { type: 'http', name: server.name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }
    : { name: server.name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) });
}
function selectValues(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => { const option = record(entry); return typeof option.value === 'string' ? [option.value] : selectValues(option.options); }) : [];
}
export function configuration(data: Record<string, unknown>): { options: ConfigOption[]; values: JsonObject; keys: Map<string, Record<string, unknown>> } {
  const options: ConfigOption[] = [], values: JsonObject = {}, keys = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(data.configOptions) ? data.configOptions : []) {
    const option = record(item); if (typeof option.id !== 'string') continue;
    const id = option.id; const current = option.currentValue;
    if (option.type !== 'boolean' && option.type !== 'select') continue;
    const schema: JsonObject = option.type === 'boolean' ? { type: 'boolean' } : { type: 'string', enum: selectValues(option.options) };
    const descriptor: ConfigOption = { id, title: typeof option.name === 'string' ? option.name : id, scope: 'session', schema, ...(typeof current === 'string' || typeof current === 'boolean' ? { value: current } : {}) };
    options.push(descriptor); keys.set(id, option); if (descriptor.value !== undefined) values[id] = descriptor.value;
    if (option.category === 'model' && id !== 'model') { options.push({ ...descriptor, id: 'model' }); keys.set('model', option); if (descriptor.value !== undefined) values.model = descriptor.value; }
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

/** Accumulates native updates; only complete snapshots become authoritative item/completed. */
export class AcpUpdateMapper {
  private readonly items = new Map<string, Item>();
  private readonly ended = new Set<string>();
  private serial = 0;
  private compaction = new Map<string, string>();
  constructor(private readonly sink: SessionEventSink, private readonly getTurn: () => string | undefined, private readonly state: () => SessionState, private readonly setState: (data: Record<string, unknown>) => void, private readonly subagents: boolean) {}
  reset(): void { this.items.clear(); this.ended.clear(); this.compaction.clear(); this.serial = 0; }
  private async upsert(item: Item, terminal = false): Promise<void> {
    const turnId = this.getTurn(); if (!turnId) return;
    const old = this.items.get(item.id); this.items.set(item.id, item);
    if (this.ended.has(item.id)) return;
    if (!old) await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId });
    else if (!terminal) await this.sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'patch', value: safe(item) } }, { turnId });
    if (terminal) { this.ended.add(item.id); await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId }); }
  }
  async complete(): Promise<void> {
    for (const item of this.items.values()) if (!this.ended.has(item.id)) await this.upsert({ ...item, status: item.status === 'running' ? 'completed' : item.status }, true);
  }
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
      if (Object.hasOwn(update, 'title') && (typeof update.title === 'string' || update.title === null)) {
        const title = update.title
        if (this.state().metadata?.title !== title) {
          this.setState({ sessionTitle: title })
          await this.sink.emit({ type: 'session/metadata', payload: { title } })
        }
      }
      return
    }
    if (!turnId || kind === 'available_commands_update') {
      await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: `ACP_${String(kind ?? 'UPDATE').toUpperCase()}`, message: 'ACP session metadata update', raw: safe(update) } }); return;
    }
    if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(String(kind))) {
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
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(update.toolCallId); const old = this.items.get(id);
      const kindMap: Record<string, 'command' | 'fileChange' | 'web' | 'other'> = { execute: 'command', edit: 'fileChange', delete: 'fileChange', move: 'fileChange', fetch: 'web' };
      const status = update.status === 'failed' ? 'failed' : update.status === 'completed' ? 'completed' : update.status === undefined && old?.type === 'toolCall' ? old.status ?? 'running' : 'running';
      const item: Item = {
        ...(old?.type === 'toolCall' ? old : { id, type: 'toolCall', kind: 'other', title: 'ACP tool' }),
        ...(typeof update.title === 'string' ? { title: update.title } : {}), ...(typeof update.kind === 'string' ? { kind: kindMap[update.kind] ?? 'other', nativeType: update.kind } : {}), status,
        ...(update.content !== undefined ? { fileChanges: acpFileChanges(update.content) } : {}),
        ...(update.rawInput !== undefined ? { input: safe(update.rawInput) } : {}),
        ...(update.rawOutput !== undefined ? { output: safe(update.rawOutput) } : update.content !== undefined ? { output: safe(update.content) } : {}),
        ...(Array.isArray(update.locations) ? { locations: update.locations.flatMap((location) => { const value = record(location); return typeof value.path === 'string' ? [{ path: value.path, ...(typeof value.line === 'number' ? { line: value.line } : {}) }] : []; }) } : {}),
      };
      await this.upsert(item, status !== 'running'); return;
    }
    if (kind === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      await this.upsert({ id: 'acp-plan', type: 'plan', steps: entries.map((entry, index) => { const value = record(entry); return { id: String(index), text: String(value.content ?? ''), status: value.status === 'completed' ? 'completed' : value.status === 'in_progress' ? 'inProgress' : 'pending' }; }) }); return;
    }
    if (kind === 'plan_update' || kind === 'plan_removed') {
      const plan = record(update.plan); const id = `plan:${String(update.planId ?? plan.planId ?? ++this.serial)}`;
      await this.upsert({ id, type: 'plan', steps: kind === 'plan_removed' ? [] : [{ id: 'content', text: text(plan.content ?? record(plan).markdown ?? plan), status: 'pending' }], extensions: { 'x-acp/native-plan': safe(update) } }, kind === 'plan_removed'); return;
    }
    if (kind === 'compaction_update' || kind === 'compaction_summary_chunk') {
      const id = `compaction:${String(update.compactionId)}`;
      let summary = this.compaction.get(id) ?? '';
      if (kind === 'compaction_summary_chunk') summary += text(update.content);
      else if ('summary' in update) summary = text(update.summary);
      this.compaction.set(id, summary);
      const terminal = update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled';
      await this.upsert({ id, type: 'compaction', summary, status: update.status === 'failed' ? 'failed' : update.status === 'cancelled' ? 'interrupted' : terminal ? 'completed' : 'running' }, terminal); return;
    }
    if ((kind === 'subagent_spawned' || kind === 'subagent_state_update') && this.subagents) {
      const id = `subagent:${String(update.subagentSessionId)}`; const old = this.items.get(id);
      const state = update.state === 'completed' ? 'completed' : ['cancelled', 'disconnected'].includes(String(update.state)) ? 'interrupted' : update.state === 'failed' ? 'failed' : 'running';
      await this.upsert({ ...(old?.type === 'subagent' ? old : { id, type: 'subagent', subagentId: String(update.subagentSessionId) }), state, ...(typeof update.name === 'string' ? { name: update.name } : {}), ...(typeof update.task === 'string' ? { task: update.task } : {}) }, state !== 'running'); return;
    }
    await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_UNKNOWN_UPDATE', message: 'Unmapped ACP update retained', raw: safe(update) } }, { turnId });
  }
}
