// Projects ACP prompt input, session configuration and live updates for the adapter.
import { acpFileChanges } from './file-changes';
import type {
  Capabilities, ConfigOption, InputBlock, Item, JsonObject, JsonValue,
  McpServer as SessionMcpServer, SessionState, SubagentItem, ToolCallItem,
} from '@anureo/protocol';
import { publicValue } from '@anureo/protocol';
import { HarnessSdkError, type SessionEventSink } from '@anureo/sdk';
import type { ContentBlock, McpServer } from '@agentclientprotocol/sdk';

/** Read a native object by reference. Arrays, null and primitives become a fresh empty record. */
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/**
 * Make a detached JSON copy and apply publicValue redaction before retaining native payloads.
 * Nullish values become null. JSON serialization and parsing errors propagate synchronously.
 * Callers still own removal of secrets embedded in arbitrary text.
 */
export function safe(value: unknown): JsonValue {
  return publicValue(JSON.parse(JSON.stringify(value ?? null)) as JsonValue);
}
/**
 * Flatten native content for message, plan and compaction text. Arrays join block text with
 * newlines, diffs join old and new text with a newline, and unrecognized blocks yield empty text.
 */
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
 * Translate prompt blocks in order for AcpBackendSession.submitStandardInput and
 * submitCorrelatedInput to send in session/prompt. File links use the URI as the name when
 * omitted. Throws INVALID_PARAMS before dispatch if an image's data or MIME type is empty or missing.
 */
export function input(blocks: InputBlock[]): ContentBlock[] {
  return blocks.map((block): ContentBlock => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'file') {
      return {
        type: 'resource_link',
        uri: block.uri,
        name: block.name ?? block.uri,
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
      };
    }
    if (!block.data || !block.mimeType) throw new HarnessSdkError('INVALID_PARAMS', 'ACP images require inline data and mimeType');
    return { type: 'image', data: block.data, mimeType: block.mimeType, ...(block.url ? { uri: block.url } : {}) };
  });
}
/**
 * Build native MCP server entries in input order for the session request sent by AcpAdapter.openSession.
 * Omitted servers, stdio arguments, HTTP headers and environment variables become empty arrays.
 */
export function mcp(servers: SessionMcpServer[] = []): McpServer[] {
  return servers.map((server) => server.type === 'http'
    ? { type: 'http', name: server.name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }
    : { name: server.name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) });
}
/**
 * Project native booleans, select lists and modes for AcpBackendSession.configure to advertise in
 * capabilities and merge into current state. Missing current values supply no patch.
 * setConfiguration uses keys to address the native option or mode, so the model alias points
 * to its original native descriptor.
 */
export function configuration(data: Record<string, unknown>): { options: ConfigOption[]; values: JsonObject; keys: Map<string, Record<string, unknown>> } {
  const options: ConfigOption[] = [];
  const values: JsonObject = {};
  const keys = new Map<string, Record<string, unknown>>();
  /** Keep the advertised descriptor, current value and native dispatch key aligned, including aliases. */
  function registerOption(descriptor: ConfigOption, nativeOption: Record<string, unknown>): void {
    options.push(descriptor);
    keys.set(descriptor.id, nativeOption);
    if (descriptor.value !== undefined) values[descriptor.id] = descriptor.value;
  }
  for (const item of Array.isArray(data.configOptions) ? data.configOptions : []) {
    const option = record(item);
    const descriptor = configOption(option);
    if (!descriptor) continue;
    registerOption(descriptor, option);
    if (option.category === 'model' && descriptor.id !== 'model') {
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
 * AcpBackendSession keeps a standard mapper and creates a separate mapper for each correlated
 * turn that receives an update. The session controls reset, completion and resource cleanup.
 * Await each update in source order. Sink and callback failures reject after any prior mutations.
 */
export class AcpUpdateMapper {
  /**
   * AcpBackendSession supplies the event sink, a turn ID reader that can return undefined while
   * idle, and callbacks backed by snapshot and configure. The mapper applies state patches
   * synchronously before reading or publishing state. Enable subagents only after negotiation.
   */
  constructor(
    private readonly sink: SessionEventSink,
    private readonly getTurn: () => string | undefined,
    private readonly state: () => SessionState,
    private readonly setState: (data: Record<string, unknown>) => void,
    private readonly subagents: boolean,
  ) {}

  /**
   * Forget cached items, completions, summaries and generated plan IDs without publishing.
   * AcpBackendSession.beginStandardSubmission calls this before reusing the standard mapper.
   */
  reset(): void {
    this.items.clear();
    this.ended.clear();
    this.compaction.clear();
    this.serial = 0;
  }
  /**
   * Flush unended cached items in insertion order, promoting running status to completed.
   * AcpBackendSession.submitStandardInput and nativeEvent await this before publishing
   * turn/completed. Publication failures reject and leave prior mutations and events in place.
   * With no current turn, no items are published.
   */
  async complete(): Promise<void> {
    for (const item of this.items.values()) {
      if (this.ended.has(item.id)) continue;
      await this.upsert({ ...item, status: item.status === 'running' ? 'completed' : item.status }, 'completion');
    }
  }
  /**
   * Await projection/publication of one native update forwarded by AcpBackendSession.update.
   * Configuration, metadata and usage can be published while idle. Other idle updates and unmapped
   * turn updates produce notices. A failed publication leaves state and cache mutations in place.
   * AcpAdapter's notification routing observes rejection and ends the stream.
   */
  async update(update: Record<string, unknown>): Promise<void> {
    const kind = update.sessionUpdate;
    const turnId = this.getTurn();
    if (kind === 'config_option_update' || kind === 'current_mode_update') {
      this.setState(update);
      await this.sink.emit({ type: 'session/state', payload: this.state() });
      return;
    }
    if (kind === 'usage_update') {
      await this.sink.emit({
        type: 'usage/updated',
        payload: {
          provider: 'acp',
          scope: 'session',
          source: 'native',
          ...(typeof update.used === 'number' ? { contextUsed: update.used } : {}),
          ...(typeof update.size === 'number' ? { contextWindow: update.size } : {}),
        },
      }, { ...(turnId ? { turnId } : {}) });
      return;
    }
    if (kind === 'session_info_update') {
      await this.updateMetadata(update);
      return;
    }
    if (!turnId || kind === 'available_commands_update') {
      await this.sink.emit({
        type: 'notice',
        payload: {
          severity: 'info',
          code: `ACP_${String(kind ?? 'UPDATE').toUpperCase()}`,
          message: 'ACP session metadata update',
          raw: safe(update),
        },
      });
      return;
    }
    if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(String(kind))) {
      await this.updateMessage(update, turnId);
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      await this.updateToolCall(update);
      return;
    }
    if (kind === 'plan' || kind === 'plan_update' || kind === 'plan_removed') {
      await this.updatePlan(update);
      return;
    }
    if (kind === 'compaction_update' || kind === 'compaction_summary_chunk') {
      await this.updateCompaction(update);
      return;
    }
    if ((kind === 'subagent_spawned' || kind === 'subagent_state_update') && this.subagents) {
      await this.updateSubagent(update);
      return;
    }
    await this.sink.emit({
      type: 'notice',
      payload: { severity: 'info', code: 'ACP_UNKNOWN_UPDATE', message: 'Unmapped ACP update retained', raw: safe(update) },
    }, { turnId });
  }
  private readonly items = new Map<string, Item>();
  private readonly ended = new Set<string>();
  private serial = 0;
  private readonly compaction = new Map<string, string>();
  /**
   * Cache a turn's item before publishing it. An unseen ID starts even in completion mode.
   * Later snapshots emit full patches until the ID is marked ended. Mark it ended before
   * awaiting completion publication so subsequent writes stay silent even if the sink rejects.
   * With no current turn, discard the snapshot without touching the cache.
   */
  private async upsert(item: Item, publication: 'snapshot' | 'completion' = 'snapshot'): Promise<void> {
    const turnId = this.getTurn();
    if (!turnId) return;

    const previousItem = this.items.get(item.id);
    this.items.set(item.id, item);
    if (this.ended.has(item.id)) return;

    if (!previousItem) {
      await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId });
    } else if (publication === 'snapshot') {
      await this.sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'patch', value: safe(item) } }, { turnId });
    }
    if (publication === 'completion') {
      this.ended.add(item.id);
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId });
    }
  }
  /**
   * Apply a changed title before publishing session/metadata, including while idle.
   * Omitted, invalid and unchanged titles leave state and publication alone. Null clears the title.
   */
  private async updateMetadata(update: Record<string, unknown>): Promise<void> {
    if (!Object.hasOwn(update, 'title') || (typeof update.title !== 'string' && update.title !== null)) return;

    const title = update.title;
    if (this.state().metadata?.title === title) return;

    this.setState({ sessionTitle: title });
    await this.sink.emit({ type: 'session/metadata', payload: { title } });
  }
  /**
   * Accumulate message chunks by kind and message ID, falling back to one item per kind.
   * Publish a start before the first delta. User items emit full patches and agent/reasoning
   * items emit text deltas. Unsupported content is retained in notices. complete flushes the items.
   */
  private async updateMessage(update: Record<string, unknown>, turnId: string): Promise<void> {
    const kind = update.sessionUpdate;
    const nativeId = typeof update.messageId === 'string' ? update.messageId : String(kind);
    const id = `${String(kind)}:${nativeId}`;
    const chunk = text(update.content);
    if (!chunk && record(update.content).type !== 'text') {
      await this.sink.emit({
        type: 'notice',
        payload: { severity: 'info', code: 'ACP_NON_TEXT_CONTENT', message: 'ACP non-text content retained', raw: safe(update.content) },
      }, { turnId });
    }
    let item = this.items.get(id);
    if (!item) {
      item = kind === 'agent_thought_chunk' ? { id, type: 'reasoning', text: '' }
        : kind === 'user_message_chunk' ? { id, type: 'userMessage', content: [] }
        : { id, type: 'agentMessage', text: '', phase: 'final' };
      this.items.set(id, item);
      await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId });
    }
    if (item.type === 'userMessage') {
      const block = userMessageBlock(update.content, chunk);
      if (block) {
        item.content.push(block);
      } else {
        await this.sink.emit({
          type: 'notice',
          payload: { severity: 'info', code: 'ACP_UNKNOWN_CONTENT', message: 'ACP user content', raw: safe(update.content) },
        }, { turnId });
      }
      await this.sink.emit({ type: 'item/delta', payload: { itemId: id, kind: 'patch', value: safe(item) } }, { turnId });
    } else if (item.type === 'agentMessage' || item.type === 'reasoning') {
      item.text = (item.text ?? '') + chunk;
      await this.sink.emit({ type: 'item/delta', payload: { itemId: id, kind: 'text', text: chunk } }, { turnId });
    }
  }
  /** Publish the merged tool snapshot, closing the item when its mapped status is terminal. */
  private async updateToolCall(update: Record<string, unknown>): Promise<void> {
    const id = String(update.toolCallId);
    const previousItem = this.items.get(id);
    const previousToolCall = previousItem?.type === 'toolCall' ? previousItem : undefined;
    const item = toolSnapshot(id, update, previousToolCall);
    await this.upsert(item, item.status !== 'running' ? 'completion' : 'snapshot');
  }
  /**
   * Publish standard steps under one stable ID and extension plans under their supplied or
   * generated IDs. Extension removal publishes an empty terminal plan.
   */
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
    const removed = kind === 'plan_removed';
    await this.upsert({
      id,
      type: 'plan',
      steps: removed ? [] : [{ id: 'content', text: text(plan.content ?? plan.markdown ?? plan), status: 'pending' }],
      extensions: { 'x-acp/native-plan': safe(update) },
    }, removed ? 'completion' : 'snapshot');
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
    await this.upsert({
      id,
      type: 'compaction',
      summary,
      status: update.status === 'failed' ? 'failed' : update.status === 'cancelled' ? 'interrupted' : terminal ? 'completed' : 'running',
    }, terminal ? 'completion' : 'snapshot');
  }
  /** Merge negotiated subagent fields and publish a terminal snapshot when its native state ends. */
  private async updateSubagent(update: Record<string, unknown>): Promise<void> {
    const id = `subagent:${String(update.subagentSessionId)}`;
    const previousItem = this.items.get(id);
    const state = subagentState(update.state);
    await this.upsert({
      ...(previousItem?.type === 'subagent' ? previousItem : { id, type: 'subagent', subagentId: String(update.subagentSessionId) }),
      state,
      ...(typeof update.name === 'string' ? { name: update.name } : {}),
      ...(typeof update.task === 'string' ? { task: update.task } : {}),
    }, state !== 'running' ? 'completion' : 'snapshot');
  }
}

/**
 * Resolve a host value against the agent's advertised session configuration.
 * AcpAdapter.openSession passes the model override here before calling setConfiguration.
 * Returns the requested value when no nonempty string enum constrains it, otherwise accepts
 * an exact match or a unique provider-qualified suffix. Throws CAPABILITY_UNSUPPORTED for
 * a missing session option and INVALID_PARAMS for an unknown or ambiguous enum value.
 *
 * This lets hosts use a bare model name when a peer advertises `provider/model`.
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
  if (matches.length === 1) return matches[0];
  throw new HarnessSdkError('INVALID_PARAMS', `Unknown ${key} value`, false, false, { key, wanted, accepted: values });
}

/**
 * Describe a selectable or boolean native option for session capability advertisement.
 * Skip unsupported types and options without a string ID. Omit absent or invalid current values.
 */
function configOption(option: Record<string, unknown>): ConfigOption | undefined {
  if (typeof option.id !== 'string') return undefined;
  const id = option.id;
  const current = option.currentValue;
  if (option.type !== 'boolean' && option.type !== 'select') return undefined;

  const schema: JsonObject = option.type === 'boolean'
    ? { type: 'boolean' }
    : { type: 'string', enum: selectValues(option.options) };
  return {
    id,
    title: typeof option.name === 'string' ? option.name : id,
    scope: 'session',
    schema,
    ...(typeof current === 'string' || typeof current === 'boolean' ? { value: current } : {}),
  };
}

/** Flatten grouped ACP select choices in advertised order; non-array groups contribute no values. */
function selectValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = record(entry);
    return typeof option.value === 'string' ? [option.value] : selectValues(option.options);
  });
}

/** Use the flattened chunk for text and retain image data or file URIs. Return undefined for unsupported content. */
function userMessageBlock(value: unknown, chunk: string): InputBlock | undefined {
  const content = record(value);
  if (content.type === 'text') return { type: 'text', text: chunk };
  if (content.type === 'image' && typeof content.data === 'string') {
    return {
      type: 'image',
      data: content.data,
      mimeType: typeof content.mimeType === 'string' ? content.mimeType : undefined,
    };
  }
  if (content.type === 'resource_link' && typeof content.uri === 'string') {
    return { type: 'file', uri: content.uri };
  }
  return undefined;
}

const TOOL_KINDS: Record<string, ToolCallItem['kind']> = {
  execute: 'command',
  edit: 'fileChange',
  delete: 'fileChange',
  move: 'fileChange',
  fetch: 'web',
};

/**
 * Build a new tool snapshot, retaining previous values for omitted fields. Defined content
 * replaces file materials. Defined rawOutput, including null, wins over content for output.
 * Serialization failures propagate before the caller caches or publishes the snapshot.
 */
function toolSnapshot(id: string, update: Record<string, unknown>, previous: ToolCallItem | undefined): ToolCallItem {
  let status: ToolCallItem['status'] = 'running';
  if (update.status === 'failed' || update.status === 'completed') {
    status = update.status;
  } else if (update.status === undefined) {
    status = previous?.status ?? 'running';
  }
  const baseItem: ToolCallItem = {
    ...(previous ?? { id, type: 'toolCall', kind: 'other', title: 'ACP tool' }),
    ...(typeof update.title === 'string' ? { title: update.title } : {}),
    ...(typeof update.kind === 'string' ? { kind: TOOL_KINDS[update.kind] ?? 'other', nativeType: update.kind } : {}),
    status,
    ...(update.content !== undefined ? { fileChanges: acpFileChanges(update.content) } : {}),
    ...(update.rawInput !== undefined ? { input: safe(update.rawInput) } : {}),
  };
  const outputPatch = update.rawOutput !== undefined
    ? { output: safe(update.rawOutput) }
    : update.content !== undefined
      ? { output: safe(update.content) }
      : {};
  return {
    ...baseItem,
    ...outputPatch,
    ...(Array.isArray(update.locations) ? { locations: toolLocations(update.locations) } : {}),
  };
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

/** Treat cancellation and disconnection as interruptions. Unrecognized states remain running. */
function subagentState(state: unknown): SubagentItem['state'] {
  if (state === 'completed') return 'completed';
  if (['cancelled', 'disconnected'].includes(String(state))) return 'interrupted';
  if (state === 'failed') return 'failed';
  return 'running';
}
