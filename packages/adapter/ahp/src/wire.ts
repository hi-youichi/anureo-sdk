/** Owns JSON-RPC correlation, bounded framing and connection cleanup for remote AHP peers. */
import { HarnessSdkError } from "@anureo/sdk";
import { spawnHarnessProcess, type HarnessProcess, type HarnessProcessOptions } from "@anureo/sdk/process";

/**
 * Supply framed text I/O to AhpWire or AhpAdapterOptions.transport/connect. The adapter owns
 * closing the supplied transport; direct wire users must close their wire. Implementations
 * report source failure by rejecting iteration. The stdio transport removes its line delimiters.
 */
export interface AhpTransport {
  /** One incoming frame per value; AhpWire claims and consumes the iterator immediately. */
  messages: AsyncIterable<string>;
  /** Submit one frame without waiting for a peer reply; reject write/admission failures. */
  send: (message: string) => Promise<void>;
  /** Release the owned connection; resolution describes local cleanup, not peer acknowledgement. */
  close: () => Promise<void>;
}

/** Wire configuration shared with AhpAdapterOptions; omitted limits use the documented defaults. */
export interface WireOptions {
  /** Per-request reply deadline in milliseconds, starting before send; defaults to 30,000. */
  timeoutMs?: number;
  /** UTF-8 bytes per incoming frame or outgoing request; defaults to 8 MiB. Outgoing notifications bypass this check. */
  maxFrameBytes?: number;
  /** Maximum outstanding requests, including sends still in progress; defaults to 256. */
  maxPending?: number;
  /** Maximum queued and running notification callbacks; defaults to 2048. */
  maxNotifications?: number;
  /** Called once when cleanup starts with a safe failure code; exceptions cannot prevent cleanup. */
  diagnostic?: (code: string) => void;
}

/**
 * Exchange JSON-RPC requests and serialized notifications over one owned transport. AhpAdapter
 * uses this for its handshake, session operations and replay, and validates the returned payloads.
 * Direct consumers likewise own payload validation and must await close to observe cleanup failure.
 */
export class AhpWire {
  /** Start reading immediately; install notification/close callbacks before sending the handshake. */
  constructor(private readonly transport: AhpTransport, private readonly options: WireOptions = {}) {
    this.loop = this.read();
    void this.loop.catch(() => {});
  }

  /**
   * Receives notifications serially without blocking reply reads. AhpAdapter.initializeConnection
   * registers its notification router here; rejection starts connection cleanup. Already queued
   * callbacks still run after close, and close does not wait for them.
   */
  onNotification?: (method: string, params: unknown) => Promise<void> | void;

  /**
   * Invoked once with the first close cause, concurrently with transport cleanup. AhpAdapter
   * registers failConnection to fail session sinks and interaction waiters. close awaits this
   * callback and reports its rejection as a resource-release failure.
   */
  onClose?: (cause: unknown) => Promise<void> | void;

  /**
   * Send a request and resolve its correlated result, without schema validation. Reject remote
   * errors, malformed replies, admission limits, timeouts or connection loss; timeouts and rejected
   * sends carry an unknown outcome and do not retry or close the wire. Synchronous send exceptions
   * reject unchanged. Serialization errors throw synchronously. The reply deadline includes sending;
   * there is no per-request cancellation.
   */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closing) return Promise.reject(connectionClosedError());
    if (this.pending.size >= (this.options.maxPending ?? 256)) {
      return Promise.reject(new HarnessSdkError("BACKPRESSURE_EXCEEDED"));
    }
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (exceedsFrameLimit(message, this.options.maxFrameBytes)) {
      return Promise.reject(new HarnessSdkError("FRAME_TOO_LARGE"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HarnessSdkError("RPC_TIMEOUT", "RPC_TIMEOUT", false, true, { method }));
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.transport.send(message).catch(() => {
        this.takePending(id)?.reject(connectionClosedError());
      });
    });
  }

  /**
   * Send without awaiting a reply; completion and admission follow transport.send. Omitted params
   * are left out of the frame. Serialization can throw synchronously and send failures propagate.
   * AhpAdapter.initializeConnection awaits this for initialized before reporting readiness.
   */
  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
  }

  /**
   * Stop request admission and reject outstanding requests immediately, then await onClose and
   * transport.close concurrently. Repeated calls share the same success or RESOURCE_RELEASE_FAILED
   * rejection, including after background failure. Does not await the reader or notification queue.
   * AhpAdapter.dispose awaits this after the SDK has released its session handles.
   */
  close(): Promise<void> {
    return this.beginClose(new HarnessSdkError("RUNTIME_DISPOSED"));
  }

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closing = false;
  // Covers the close callback and transport cleanup; does not await the read loop or notification queue.
  private closePromise?: Promise<void>;
  private notificationTail = Promise.resolve();
  private queuedNotificationCount = 0;
  private readonly loop: Promise<void>;

  /** Consume until EOF/failure, then close with that cause; explicit close already owns cleanup. */
  private async read(): Promise<void> {
    let failure: unknown = connectionClosedError();
    try {
      for await (const frame of this.transport.messages) {
        if (this.closing) break;
        const reply = this.dispatchMessage(parseFrame(frame, this.options.maxFrameBytes));
        // Only replies to peer requests block reads; notification handlers may themselves await RPCs.
        if (reply) await reply;
      }
    } catch (cause) { failure = cause; }
    if (!this.closing) await this.beginClose(failure);
  }

  /** Route an envelope; only unsupported peer requests return a write to await before reading again. */
  private dispatchMessage(message: Record<string, unknown>): Promise<void> | undefined {
    if (typeof message.method !== "string") {
      this.settleResponse(message);
      return;
    }
    if (message.id !== undefined) {
      return this.transport.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
    }
    this.enqueueNotification(message);
  }

  /** Settle only a matching request, ignoring late/foreign IDs; a malformed reply fails that request. */
  private settleResponse(message: Record<string, unknown>): void {
    const pending = this.takePending(message.id as number);
    if (!pending) return;
    if (message.error && typeof message.error === "object") {
      pending.reject(remoteErrorToSdkError(message.error as Record<string, unknown>));
    } else if (Object.hasOwn(message, "result")) {
      pending.resolve(message.result);
    } else {
      pending.reject(new HarnessSdkError("PROTOCOL_ERROR"));
    }
  }

  /** Response and send-failure paths remove correlation and cancel its deadline before settlement. */
  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
    }
    return pending;
  }

  /** Bound queued/running callbacks; handler failure closes the wire without cancelling later callbacks. */
  private enqueueNotification(message: Record<string, unknown>): void {
    if (++this.queuedNotificationCount > (this.options.maxNotifications ?? 2048)) {
      throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
    }
    this.notificationTail = this.notificationTail
      .then(() => this.onNotification?.(message.method as string, message.params))
      .catch(cause => this.beginClose(cause).catch(() => {}))
      .finally(() => this.queuedNotificationCount--);
  }

  /** First close wins: retire pending work synchronously and cache cleanup before invoking callbacks. */
  private beginClose(cause: unknown): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(connectionClosedError());
    }
    this.pending.clear();
    return this.closePromise = Promise.resolve().then(() => this.releaseConnection(cause));
  }

  /** Run both releases even if either fails; expose only stable failure codes, never private causes. */
  private async releaseConnection(cause: unknown): Promise<void> {
    try { this.options.diagnostic?.(cause instanceof HarnessSdkError ? cause.code : "PROTOCOL_ERROR"); }
    catch { /* Diagnostics do not own connection cleanup. */ }
    const [closeHandlerResult, transportCloseResult] = await Promise.allSettled([
      Promise.resolve().then(() => this.onClose?.(cause)),
      Promise.resolve().then(() => this.transport.close()),
    ]);
    const errors: { code: string }[] = [];
    if (closeHandlerResult.status === "rejected") errors.push({ code: "AHP_CLOSE_HANDLER_FAILED" });
    if (transportCloseResult.status === "rejected") errors.push({ code: "AHP_TRANSPORT_CLOSE_FAILED" });
    if (errors.length) {
      throw new HarnessSdkError("RESOURCE_RELEASE_FAILED", "AHP connection cleanup failed", false, true, { errors });
    }
  }
}

/**
 * Acquire a process and expose newline-delimited UTF-8 frames without waiting for AHP readiness;
 * process/factory startup failures reject. Empty lines are ignored and CRLF is accepted. Iteration
 * rejects oversized frames or a non-whitespace unterminated tail. Stderr is drained privately.
 * AhpAdapter.initializeConnection passes this to AhpWire, which closes it; direct callers must close
 * it even after EOF. send awaits process.write; close awaits process.dispose and its ownership policy.
 * maxFrameBytes defaults to 8 MiB, including the unfinished decoded frame before a newline arrives.
 */
export async function createStdioTransport(options: HarnessProcessOptions & {
  /** Override process acquisition; the returned process's output is consumed and its dispose owns cleanup. */
  processFactory?: (p: HarnessProcessOptions) => Promise<HarnessProcess>;
  /** Incoming decoded UTF-8 frame budget, including unfinished lines; defaults to 8 MiB. */
  maxFrameBytes?: number;
}): Promise<AhpTransport> {
  const process = await (options.processFactory ?? spawnHarnessProcess)(options);
  const maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
  void drainStderr(process).catch(() => {});
  return {
    messages: readStdioFrames(process, maxFrameBytes),
    send: message => process.write(message + "\n"),
    close: () => process.dispose(),
  };
}

/** One outstanding reply and its deadline; sending can still be in progress when it settles. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (cause: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A lost connection cannot establish whether the peer applied an outstanding operation. */
function connectionClosedError(): HarnessSdkError {
  return new HarnessSdkError("RPC_CONNECTION_CLOSED", "RPC_CONNECTION_CLOSED", false, true);
}

/** Compare the shared UTF-8 frame budget without parsing or retaining potentially private contents. */
function exceedsFrameLimit(frame: string, maxFrameBytes?: number): boolean {
  return new TextEncoder().encode(frame).byteLength > (maxFrameBytes ?? 8 * 1024 * 1024);
}

/** Validate only the RPC envelope; AhpAdapter validates method-specific payloads after dispatch. */
function parseFrame(frame: string, maxFrameBytes?: number): Record<string, unknown> {
  if (exceedsFrameLimit(frame, maxFrameBytes)) throw new HarnessSdkError("FRAME_TOO_LARGE");
  let value: unknown;
  try { value = JSON.parse(frame); }
  catch { throw new HarnessSdkError("PROTOCOL_ERROR"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessSdkError("PROTOCOL_ERROR");
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") throw new HarnessSdkError("PROTOCOL_ERROR");
  return message;
}

/** Preserve explicit remote outcome/retry metadata while discarding private remote error text. */
function remoteErrorToSdkError(error: Record<string, unknown>): HarnessSdkError {
  const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
  let code = "AHP_RPC_ERROR";
  if (typeof data.code === "string") {
    code = data.code;
  } else if (error.code === -32601) {
    code = "CAPABILITY_UNSUPPORTED";
  }
  const retryable = data.retryable === true;
  const outcomeUnknown = data.outcomeUnknown === true;
  return new HarnessSdkError(code, "AHP_RPC_ERROR", retryable, outcomeUnknown);
}

/** Drain diagnostics without copying secret-bearing raw stderr into public errors/logs. */
async function drainStderr(process: HarnessProcess): Promise<void> {
  for await (const _ of process.stderr) {}
}

/** Decode incrementally; bound complete and partial lines, and reject an unterminated nonblank tail. */
async function* readStdioFrames(process: HarnessProcess, maxFrameBytes: number): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (exceedsFrameLimit(line, maxFrameBytes)) throw new HarnessSdkError("FRAME_TOO_LARGE");
      if (line) yield line;
    }
    // Bound the unfinished frame even before its newline arrives.
    if (exceedsFrameLimit(buffer, maxFrameBytes)) throw new HarnessSdkError("FRAME_TOO_LARGE");
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new HarnessSdkError("PROTOCOL_ERROR", "Unterminated AHP frame");
}
