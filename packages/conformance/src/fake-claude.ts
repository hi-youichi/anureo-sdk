import { BoundedEventQueue } from "@anureo/sdk";
import type { JsonObject, JsonValue } from "@anureo/protocol";

/** Configure the initial output, input behavior and simulated capabilities of a Claude query fixture. */
export interface ClaudeQueryScript {
  /** Initial messages cloned and buffered in order within the default BoundedEventQueue limits. */
  messages: JsonObject[];
  /**
   * Supply a response script that streamInput awaits after recording each input.
   * Await emit to buffer a message or deliver it to a waiting reader. It can wait for
   * queue capacity and reject on closure or admission failure. Keep emitted objects stable
   * while buffered. Callback failures reject streamInput and leave admitted output available.
   */
  onInput?: (input: JsonValue, emit: (message: JsonObject) => Promise<void>) => Promise<void>;
  /** Returned by reference when supplied, including an empty list; omission selects the fake model. */
  models?: Array<{ value: string; displayName: string; description: string }>;
  /** Set true to allow simulated rewind. Omission or false returns a "No checkpoint" denial. */
  canRewind?: boolean;
}
/**
 * Script a Claude query for a test without launching a peer. Controls record observations
 * for assertions. To use one with a Claude adapter's queryFactory, bridge the factory's
 * prompt into streamInput, project the output as native SDK messages and supply additional
 * Query methods the adapter requires, such as applyFlagSettings.
 * Direct callers end output with finish or close and drain or return the output iterator.
 */
export class ScriptedClaudeQuery implements AsyncIterable<JsonObject> {
  /** Ordered input/control observations; input values are retained by reference. */
  readonly calls: Array<{ method: string; value?: JsonValue }> = [];

  /** Clone and buffer initial messages; cloning or queue admission failures throw synchronously. */
  constructor(private readonly script: ClaudeQueryScript) {
    for (const message of script.messages) this.queue.push(structuredClone(message));
  }

  /**
   * Claim exclusive output reads. A second acquisition throws EVENT_STREAM_ALREADY_OWNED
   * until the first iterator releases ownership. Overlapping pending reads reject with
   * CONCURRENT_EVENT_READ. Call return when stopping early. If finish or close settled
   * an already pending read, call return or next again to release ownership.
   */
  [Symbol.asyncIterator](): AsyncIterator<JsonObject> { return this.queue[Symbol.asyncIterator](); }

  /**
   * Consume one input stream in order, resolving at EOF after its onInput calls complete.
   * Input, callback and awaited emit failures reject without closing output. The caller
   * owns input cancellation and output closure; consume output concurrently if emits fill the queue.
   */
  async streamInput(stream: AsyncIterable<JsonValue>): Promise<void> {
    for await (const input of stream) {
      this.calls.push({ method: "input", value: input });
      await this.script.onInput?.(input, (message) => this.queue.write(message));
    }
  }

  /** Record an interrupt without cancelling input or ending output. */
  async interrupt(): Promise<void> { this.calls.push({ method: "interrupt" }); }
  /** Record a model selection; omitted or empty model strings produce a call without a value. */
  async setModel(model?: string): Promise<void> { this.calls.push({ method: "setModel", ...(model ? { value: model } : {}) }); }
  /** Record a permission mode without validating or applying it. */
  async setPermissionMode(mode: string): Promise<void> { this.calls.push({ method: "setPermissionMode", value: mode }); }
  /** Record a thinking-token budget, including null, without validating or applying it. */
  async setMaxThinkingTokens(tokens: number | null): Promise<void> { this.calls.push({ method: "setMaxThinkingTokens", value: tokens }); }
  /** Record the checkpoint ID and return configured availability; denial is a result, and no files change. */
  async rewindFiles(id: string): Promise<{ canRewind: boolean; error?: string }> {
    this.calls.push({ method: "rewindFiles", value: id });
    return this.script.canRewind ? { canRewind: true } : { canRewind: false, error: "No checkpoint" };
  }
  /** Resolve with the supplied list by reference or a fresh single-model list. This adds no call record. */
  async supportedModels() { return this.script.models ?? [{ value: "fake-model", displayName: "Fake", description: "Fixture" }]; }

  /** End output admission once and wake blocked emits to reject. Buffered messages still drain and input stays open. */
  finish(): void { this.queue.end(); }
  /** Record close once and end output admission; buffered messages still drain and input is not cancelled. */
  close(): void {
    if (this.closeCalled) return;
    this.closeCalled = true;
    this.calls.push({ method: "close" });
    this.queue.end();
  }

  private readonly queue = new BoundedEventQueue<JsonObject>();
  private closeCalled = false;
}

/** Create a query with its own call log and output queue. Initial cloning or admission failures throw synchronously. */
export function createFakeClaudeQuery(script: ClaudeQueryScript): ScriptedClaudeQuery {
  return new ScriptedClaudeQuery(script);
}
