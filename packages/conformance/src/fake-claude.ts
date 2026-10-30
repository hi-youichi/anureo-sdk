import { BoundedEventQueue } from "@anureo/sdk";
import type { JsonObject, JsonValue } from "@anureo/protocol";

export interface ClaudeQueryScript {
  messages: JsonObject[];
  onInput?: (input: JsonValue, emit: (message: JsonObject) => Promise<void>) => Promise<void>;
  models?: Array<{ value: string; displayName: string; description: string }>;
  canRewind?: boolean;
}
/** Minimal injectable query facade. The adapter supplies its SDK-facing structural types. */
export class ScriptedClaudeQuery implements AsyncIterable<JsonObject> {
  readonly calls: Array<{ method: string; value?: JsonValue }> = [];
  private readonly queue = new BoundedEventQueue<JsonObject>();
  private closed = false;
  constructor(private readonly script: ClaudeQueryScript) { for (const message of script.messages) this.queue.push(structuredClone(message)); }
  [Symbol.asyncIterator](): AsyncIterator<JsonObject> { return this.queue[Symbol.asyncIterator](); }
  async streamInput(stream: AsyncIterable<JsonValue>): Promise<void> {
    for await (const input of stream) { this.calls.push({ method: "input", value: input }); await this.script.onInput?.(input, (message) => this.queue.write(message)); }
  }
  async interrupt(): Promise<void> { this.calls.push({ method: "interrupt" }); }
  async setModel(model?: string): Promise<void> { this.calls.push({ method: "setModel", ...(model ? { value: model } : {}) }); }
  async setPermissionMode(mode: string): Promise<void> { this.calls.push({ method: "setPermissionMode", value: mode }); }
  async setMaxThinkingTokens(tokens: number | null): Promise<void> { this.calls.push({ method: "setMaxThinkingTokens", value: tokens }); }
  async rewindFiles(id: string): Promise<{ canRewind: boolean; error?: string }> { this.calls.push({ method: "rewindFiles", value: id }); return this.script.canRewind ? { canRewind: true } : { canRewind: false, error: "No checkpoint" }; }
  async supportedModels() { return this.script.models ?? [{ value: "fake-model", displayName: "Fake", description: "Fixture" }]; }
  finish(): void { this.queue.end(); }
  close(): void { if (!this.closed) { this.closed = true; this.calls.push({ method: "close" }); this.queue.end(); } }
}
export function createFakeClaudeQuery(script: ClaudeQueryScript): ScriptedClaudeQuery { return new ScriptedClaudeQuery(script); }
