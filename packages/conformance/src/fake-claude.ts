import { BoundedEventQueue } from "@anureo/sdk";
import type { JsonObject, JsonValue } from "@anureo/protocol";

/** Configure a credential-free query fixture; only initial messages are cloned. */
export interface ClaudeQueryScript {
  /** Initial messages admitted synchronously, in order, within the default BoundedEventQueue limits. */
  messages: JsonObject[];
  /**
   * streamInput records each input, then awaits this callback before reading the next.
   * Await emit to admit output under backpressure; admission does not wait for consumption.
   * Emitted objects are retained by reference and must not be mutated while buffered.
   */
  onInput?: (input: JsonValue, emit: (message: JsonObject) => Promise<void>) => Promise<void>;
  /** Returned by reference when supplied, including an empty list; omission selects the fake model. */
  models?: Array<{ value: string; displayName: string; description: string }>;
  /** Truthy reports rewind availability; omission or false returns a "No checkpoint" denial. */
  canRewind?: boolean;
}
/**
 * Drive conformance consumers through a minimal Claude query surface without launching a peer.
 * Configuration, interrupt and rewind calls record observations without native effects. This is a partial SDK facade;
 * consumers adapting it to an SDK interface supply the remaining structural requirements.
 * Drain or return the sole output iterator and call finish or close to end output explicitly.
 */
export class ScriptedClaudeQuery implements AsyncIterable<JsonObject> {
  /** Ordered input/control observations; input values are retained by reference. */
  readonly calls: Array<{ method: string; value?: JsonValue }> = [];

  /** Clone and buffer initial messages; cloning or queue admission failures throw synchronously. */
  constructor(private readonly script: ClaudeQueryScript) {
    for (const message of script.messages) this.queue.push(structuredClone(message));
  }

  /**
   * Claim exclusive output reads; a second owner throws until the first drains completion or returns.
   * Overlapping pending reads reject; returning an iterator releases ownership without ending output.
   */
  [Symbol.asyncIterator](): AsyncIterator<JsonObject> { return this.queue[Symbol.asyncIterator](); }

  /**
   * Consume inputs sequentially, resolving after EOF and all onInput callbacks complete.
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
  /** Resolve with the configured list or the single fake model without recording a control call. */
  async supportedModels() { return this.script.models ?? [{ value: "fake-model", displayName: "Fake", description: "Fixture" }]; }

  /** Idempotently end output admission; buffered messages still drain and input is not cancelled. */
  finish(): void { this.queue.end(); }
  /** Record close once and end output admission; buffered messages still drain and input is not cancelled. */
  close(): void {
    if (!this.closeCalled) {
      this.closeCalled = true;
      this.calls.push({ method: "close" });
      this.queue.end();
    }
  }

  private readonly queue = new BoundedEventQueue<JsonObject>();
  private closeCalled = false;
}

/** Create an independently buffered query; initial admission can throw, and the caller owns output closure. */
export function createFakeClaudeQuery(script: ClaudeQueryScript): ScriptedClaudeQuery {
  return new ScriptedClaudeQuery(script);
}
