// Runs host input policy before dispatch and owns the resources of pending hooks.
import { assertRequest, type AhpRequestMap } from '@anureo/protocol';
import type { BeforeInputEvent, BeforeInputHook, ClientHooks, InputTransformHook } from '../client-options';
import { HarnessSdkError } from '../errors';
import type { QueueLimits } from '../queue';
import type { NativeHookCallbacks } from '../ports';
import { positive } from './limits';

type InputMethod = 'input/submit' | 'turn/steer';
export type HookInput = { [M in InputMethod]: { method: M; params: AhpRequestMap[M] } }[InputMethod];

function copyHandlers<T>(handlers: readonly T[] | undefined): T[] {
  if (handlers === undefined) return [];
  if (!Array.isArray(handlers)) throw new HarnessSdkError('INVALID_PARAMS');
  const copy = [...handlers];
  if (copy.some(handler => typeof handler !== 'function')) throw new HarnessSdkError('INVALID_PARAMS');
  return copy;
}

/** A client's copied registration and shared budgets. Each opened session owns its own FIFO. */
export class InputHooks {
  readonly revision: string | undefined;
  readonly hasInputHooks: boolean;
  readonly native: NativeHookCallbacks | undefined;
  readonly timeoutMs: number;
  readonly maxFrameBytes: number;
  private readonly maxBytes: number;
  private readonly transforms: readonly InputTransformHook[];
  private readonly validators: readonly BeforeInputHook[];
  private pendingBytes = 0;
  private runningCallbacks = 0;

  constructor(config: ClientHooks, limits?: QueueLimits) {
    if (!config || typeof config.inputRevision !== 'string' || !config.inputRevision.trim()) {
      throw new HarnessSdkError('INVALID_PARAMS');
    }
    this.transforms = copyHandlers(config.transformInput);
    this.validators = copyHandlers(config.beforeInput);
    this.hasInputHooks = this.transforms.length > 0 || this.validators.length > 0;
    this.timeoutMs = positive(config.timeoutMs, 5_000);
    if (this.timeoutMs > 0x7fffffff) throw new HarnessSdkError('INVALID_PARAMS');
    this.maxFrameBytes = positive(limits?.maxFrameBytes, 8 * 1024 * 1024);
    this.maxBytes = positive(limits?.maxBytes, 16 * 1024 * 1024);
    this.native = this.nativeCallbacks(config);
    this.revision = this.hasInputHooks || this.native ? config.inputRevision : undefined;
  }

  private nativeCallbacks({ beforeTool, beforeStop }: ClientHooks): NativeHookCallbacks | undefined {
    if (beforeStop !== undefined && typeof beforeStop !== 'function') throw new HarnessSdkError('INVALID_PARAMS');
    if (beforeTool === undefined && beforeStop === undefined) return;
    // The native matcher needs a separate response-delivery margin in seconds.
    if (this.timeoutMs > 0x7fffffff - 2_000) throw new HarnessSdkError('INVALID_PARAMS');
    let tool: NativeHookCallbacks['beforeTool'];
    if (beforeTool !== undefined) {
      if (!beforeTool || typeof beforeTool.handle !== 'function' || !Array.isArray(beforeTool.toolNames)) throw new HarnessSdkError('INVALID_PARAMS');
      const toolNames = [...beforeTool.toolNames];
      if (!toolNames.length || toolNames.some(name => typeof name !== 'string' || !name.trim()) || new Set(toolNames).size !== toolNames.length) {
        throw new HarnessSdkError('INVALID_PARAMS');
      }
      const handle = beforeTool.handle;
      tool = {
        toolNames: Object.freeze(toolNames),
        invoke: async (event, signal) => {
          if (!toolNames.includes(event.toolName)) return 'continue';
          const result = await this.runNative(event, handle, signal);
          return result.ok && result.value === undefined ? 'continue' : 'deny';
        },
      };
    }
    return {
      timeoutMs: this.timeoutMs,
      beforeTool: tool,
      beforeStop: beforeStop && (async (event, signal) => {
        const result = await this.runNative(event, beforeStop, signal);
        if (!result.ok) return;
        const output = result.value;
        if (output?.action === 'continue' && typeof output.prompt === 'string' && output.prompt.trim()
          && Buffer.byteLength(output.prompt) <= 4_096) return output.prompt;
      }),
    };
  }

  private async runNative<E, R>(
    event: E,
    handler: (event: E, context: { signal: AbortSignal }) => R,
    nativeSignal: AbortSignal,
  ): Promise<{ ok: true; value: Awaited<R> } | { ok: false }> {
    const failure = { ok: false } as const;
    if (nativeSignal.aborted || this.runningCallbacks >= 32) return failure;
    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = AbortSignal.any([controller.signal, nativeSignal]);
    let resolveAbort!: (value: typeof failure) => void;
    const cancelled = new Promise<typeof failure>(resolve => { resolveAbort = resolve; });
    const abort = () => resolveAbort(failure);
    signal.addEventListener('abort', abort, { once: true });
    this.runningCallbacks++;
    const work = Promise.resolve().then(async () => {
      try {
        if (signal.aborted) return failure;
        const value = structuredClone(await handler(structuredClone(event), { signal }));
        if (performance.now() >= deadline) controller.abort();
        return signal.aborted ? failure : { ok: true as const, value };
      } catch { return failure; }
      finally { this.runningCallbacks--; }
    });
    try { return await Promise.race([work, cancelled]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  resize(delta: number): void {
    if (this.pendingBytes + delta > this.maxBytes) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED');
    this.pendingBytes += delta;
  }

  private async invoke<R>(handler: (event: BeforeInputEvent, context: { signal: AbortSignal }) => R, input: HookInput, signal: AbortSignal): Promise<Awaited<R>> {
    if (this.runningCallbacks >= 32) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED');
    this.runningCallbacks++;
    try {
      const { sessionId, requestId, submissionId } = input.params;
      const identity = { sessionId, requestId, submissionId, input: structuredClone(input.params.input) };
      const event: BeforeInputEvent = input.method === 'input/submit'
        ? { ...identity, method: input.method, delivery: input.params.delivery }
        : { ...identity, method: input.method, expectedTurnId: input.params.expectedTurnId };
      return await handler(event, { signal });
    } catch {
      throw new HarnessSdkError('HOOK_FAILED');
    } finally {
      this.runningCallbacks--;
    }
  }

  async prepare(entry: PendingInput, check: () => void, reserveReplacement: (value: number) => void): Promise<HookInput> {
    let input = entry.input;
    for (const handler of this.transforms) {
      check();
      const blocks = await this.invoke(handler, input, entry.controller.signal);
      check();
      if (blocks === undefined) continue;
      let replacementBytes: number;
      try {
        if (!Array.isArray(blocks)) throw new TypeError();
        const replacement = structuredClone(blocks);
        input = input.method === 'input/submit'
          ? { method: input.method, params: { ...input.params, input: replacement } }
          : { method: input.method, params: { ...input.params, input: replacement } };
        assertRequest(input.method, input.params);
        replacementBytes = Buffer.byteLength(JSON.stringify(input.params));
      } catch {
        throw new HarnessSdkError('HOOK_FAILED');
      }
      if (replacementBytes > this.maxFrameBytes) throw new HarnessSdkError('FRAME_TOO_LARGE');
      reserveReplacement(replacementBytes);
    }
    check();
    entry.validate(input);
    for (const handler of this.validators) {
      check();
      const decision = await this.invoke(handler, input, entry.controller.signal);
      check();
      if (decision === undefined) continue;
      let copy: typeof decision;
      try {
        copy = structuredClone(decision);
      } catch {
        throw new HarnessSdkError('HOOK_FAILED');
      }
      if (copy?.action === 'deny') throw new HarnessSdkError('HOOK_DENIED');
      throw new HarnessSdkError('HOOK_FAILED');
    }
    return input;
  }
}

interface PendingInput {
  input: HookInput;
  originalBytes: number;
  replacementBytes: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
  started: boolean;
  validate: (input: HookInput) => void;
  dispatch: (input: HookInput) => void;
  reject: (cause: HarnessSdkError) => void;
}

/** Owns one session's pending policy work up to the synchronous backend handoff. */
export class InputHookQueue {
  private readonly pending = new Set<PendingInput>();
  private scheduled = false;

  constructor(private readonly hooks: InputHooks) {}

  enqueue(input: HookInput, originalBytes: number, callbacks: Pick<PendingInput, 'validate' | 'dispatch' | 'reject'>): void {
    try { this.hooks.resize(originalBytes); }
    catch (cause) { callbacks.reject(cause as HarnessSdkError); return; }
    const entry: PendingInput = {
      input, originalBytes, replacementBytes: 0, ...callbacks,
      controller: new AbortController(),
      started: false,
      deadline: performance.now() + this.hooks.timeoutMs,
      timer: setTimeout(() => this.reject(entry, new HarnessSdkError('HOOK_TIMEOUT')), this.hooks.timeoutMs),
    };
    this.pending.add(entry);
    this.schedule();
  }

  cancel(cause: HarnessSdkError): string[] {
    const entries = [...this.pending];
    for (const entry of entries) { this.remove(entry); entry.reject(cause); }
    // Abort listeners can call session methods. Notify after the owner has
    // completed the control request's own synchronous state transition.
    if (entries.length) queueMicrotask(() => {
      for (const entry of entries) entry.controller.abort();
    });
    return entries.map(entry => entry.input.params.submissionId);
  }

  private remove(entry: PendingInput): void {
    this.pending.delete(entry);
    clearTimeout(entry.timer);
    this.hooks.resize(-entry.originalBytes - entry.replacementBytes);
    this.schedule();
  }

  private reject(entry: PendingInput, cause: HarnessSdkError): void {
    if (!this.pending.has(entry)) return;
    this.remove(entry);
    entry.reject(cause);
    entry.controller.abort();
  }

  private schedule(): void {
    if (this.scheduled || this.pending.size === 0) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const entry = this.pending.values().next().value;
      if (!entry || entry.started) return;
      entry.started = true;
      void this.run(entry);
    });
  }

  private async run(entry: PendingInput): Promise<void> {
    const check = () => {
      if (!this.pending.has(entry)) throw new HarnessSdkError('REQUEST_ABORTED');
      if (performance.now() >= entry.deadline) throw new HarnessSdkError('HOOK_TIMEOUT');
    };
    try {
      const input = await this.hooks.prepare(entry, check, bytes => {
        this.hooks.resize(bytes - entry.replacementBytes);
        entry.replacementBytes = bytes;
      });
      check();
      entry.validate(input);
      check();
      this.remove(entry);
      entry.dispatch(input);
    } catch (cause) {
      if (performance.now() >= entry.deadline) this.reject(entry, new HarnessSdkError('HOOK_TIMEOUT'));
      else this.reject(entry, cause instanceof HarnessSdkError ? cause : new HarnessSdkError('HOOK_FAILED'));
    }
  }
}
