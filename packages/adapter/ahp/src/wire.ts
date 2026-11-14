/** Owns JSON-RPC correlation, bounded framing and connection cleanup for remote AHP peers. */
import { HarnessSdkError } from "@anureo/sdk";
import { spawnHarnessProcess, type HarnessProcess, type HarnessProcessOptions } from "@anureo/sdk/process";

/**
 * Supply framed text I/O to AhpWire or through AhpAdapterOptions.transport/connect.
 * Ownership transfers to the wire or adapter. Implementations report source failure by
 * rejecting iteration. Direct wire users await AhpWire.close to release the connection.
 */
export interface AhpTransport {
  /** Yield one complete JSON-RPC text frame per value. AhpWire claims the reader immediately. */
  messages: AsyncIterable<string>;
  /** Submit one frame and resolve when accepted locally. Reject write or admission failures; sends can overlap. */
  send: (message: string) => Promise<void>;
  /** Release the connection and unblock a waiting reader. Report local cleanup failures by rejecting. */
  close: () => Promise<void>;
}

/** Configure AhpWire directly or through the fields inherited by AhpAdapterOptions. */
export interface WireOptions {
  /** Per-request reply deadline in milliseconds, starting before send; defaults to 30,000. */
  timeoutMs?: number;
  /** Maximum UTF-8 bytes per incoming frame or outgoing request. Defaults to 8 MiB. */
  maxFrameBytes?: number;
  /** Maximum requests awaiting settlement, including during send. Defaults to 256. */
  maxPending?: number;
  /** Maximum queued and running notification callbacks; defaults to 2048. */
  maxNotifications?: number;
  /**
   * Called once at cleanup with the first cause's SDK error code, or PROTOCOL_ERROR for other
   * causes. Throws are ignored.
   */
  diagnostic?: (code: string) => void;
}

/**
 * Exchange JSON-RPC requests and serialized notifications over one owned transport. AhpAdapter
 * uses this for its handshake, session operations and replay, and validates the returned payloads.
 * Direct consumers likewise own payload validation and must await close to observe cleanup failure.
 */
export class AhpWire {
  /** Take ownership of the transport and start reading immediately. Install callbacks before sending requests. */
  constructor(private readonly transport: AhpTransport, private readonly options: WireOptions = {}) {
    // Background cleanup rejects through the shared promise returned by close().
    void this.read().catch(() => {});
  }

  /**
   * Receives notifications serially without blocking reply reads. AhpAdapter.initializeConnection
   * registers its notification router here so replay can await RPC replies. A throw or rejection
   * starts cleanup. The queue looks up the current callback at delivery time and keeps processing
   * frames already queued when close starts.
   */
  onNotification?: (method: string, params: unknown) => Promise<void> | void;

  /**
   * Invoked once with the first close cause, concurrently with transport cleanup.
   * AhpAdapter.initializeConnection registers failConnection to fail session sinks and interaction
   * waiters. A throw or rejection becomes a resource-release failure reported by close.
   * The callback must return independently of close, which awaits its completion.
   */
  onClose?: (cause: unknown) => Promise<void> | void;

  /**
   * Send a request and resolve with its correlated result. Callers validate the result schema.
   * Serialization errors throw synchronously. Remote errors, malformed replies, admission limits,
   * timeouts and connection loss reject the promise. The reply deadline includes sending. Timeouts
   * and asynchronous send failures reject with outcomeUnknown and leave the wire open. A synchronous
   * transport send exception rejects as supplied and leaves correlation until reply, timeout or close.
   * Callers own retry decisions. Use close to stop waiting for outstanding replies.
   */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closing) return Promise.reject(connectionClosedError());
    if (this.pending.size >= (this.options.maxPending ?? 256)) {
      return Promise.reject(new HarnessSdkError("BACKPRESSURE_EXCEEDED"));
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (exceedsFrameLimit(frame, this.options.maxFrameBytes)) {
      return Promise.reject(new HarnessSdkError("FRAME_TOO_LARGE"));
    }
    return this.sendRequest({ id, method, frame });
  }

  /**
   * Send a notification directly through transport.send, which controls admission and completion
   * and receives the frame regardless of the wire's request and frame limits.
   * Omitted or undefined params leave the field out. Serialization can throw synchronously and
   * transport failures propagate as supplied.
   * AhpAdapter.initializeConnection awaits this for initialized before reporting readiness.
   */
  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
  }

  /**
   * Stop admitting requests and reject outstanding ones with RPC_CONNECTION_CLOSED immediately.
   * Await onClose and transport.close concurrently. Repeated calls share the same promise, including
   * after background failure. It settles when both release operations finish and rejects with
   * RESOURCE_RELEASE_FAILED if either fails. The reader and notification queue run independently.
   * AhpAdapter.dispose awaits this after the SDK has released its session handles.
   */
  close(): Promise<void> {
    return this.beginClose(new HarnessSdkError("RUNTIME_DISPOSED"));
  }

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closing = false;
  private closePromise?: Promise<void>;
  private notificationTail = Promise.resolve();
  private queuedNotificationCount = 0;

  /**
   * Register correlation and its deadline before dispatch so a fast reply can settle the request.
   * Asynchronous send rejection retires any still-pending entry and reports an unknown outcome.
   */
  private sendRequest({ id, method, frame }: { id: number; method: string; frame: string }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HarnessSdkError("RPC_TIMEOUT", "RPC_TIMEOUT", false, true, { method }));
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.transport.send(frame).catch(() => {
        this.takePending(id)?.reject(connectionClosedError());
      });
    });
  }

  /** Read until EOF or failure and initiate cleanup unless it has already started. */
  private async read(): Promise<void> {
    let failure: unknown = connectionClosedError();
    try {
      for await (const frame of this.transport.messages) {
        if (this.closing) break;
        const reply = this.dispatchMessage(parseFrame(frame, this.options.maxFrameBytes));
        // Only replies to peer requests block reads; notification handlers may themselves await RPCs.
        if (reply) await reply;
      }
    } catch (cause) {
      failure = cause;
    }
    if (!this.closing) await this.beginClose(failure);
  }

  /** Return the method-not-found write for read to await. Correlation and notification admission run inline. */
  private dispatchMessage(message: Record<string, unknown>): Promise<void> | undefined {
    if (typeof message.method !== "string") {
      this.settleResponse(message);
      return;
    }
    if (message.id !== undefined) {
      return this.transport.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      }));
    }
    this.enqueueNotification(message.method, message.params);
  }

  /** Consume matching correlation once. A malformed reply rejects that caller with PROTOCOL_ERROR. */
  private settleResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== "number") return;
    const pending = this.takePending(message.id);
    if (!pending) return;
    if (message.error && typeof message.error === "object") {
      pending.reject(remoteErrorToSdkError(message.error as Record<string, unknown>));
    } else if (Object.hasOwn(message, "result")) {
      pending.resolve(message.result);
    } else {
      pending.reject(new HarnessSdkError("PROTOCOL_ERROR"));
    }
  }

  /** Remove live correlation and clear its deadline so a late response or send failure cannot settle it again. */
  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
    }
    return pending;
  }

  /** Serialize callback delivery in frame order. Backlog overflow throws to read and starts cleanup. */
  private enqueueNotification(method: string, params: unknown): void {
    if (++this.queuedNotificationCount > (this.options.maxNotifications ?? 2048)) {
      throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
    }
    this.notificationTail = this.notificationTail
      .then(() => this.onNotification?.(method, params))
      .catch(cause => this.beginClose(cause).catch(() => {}))
      .finally(() => this.queuedNotificationCount--);
  }

  /** Retire pending requests immediately and cache first-cause cleanup before invoking callbacks. */
  private beginClose(cause: unknown): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(connectionClosedError());
    }
    this.pending.clear();
    this.closePromise = Promise.resolve().then(() => this.releaseConnection(cause));
    return this.closePromise;
  }

  /** Run both releases and report their stable failure codes in RESOURCE_RELEASE_FAILED, without retaining private causes. */
  private async releaseConnection(cause: unknown): Promise<void> {
    try {
      this.options.diagnostic?.(cause instanceof HarnessSdkError ? cause.code : "PROTOCOL_ERROR");
    } catch {
      // A diagnostic callback cannot prevent either release operation.
    }
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
 * Acquire a process and expose newline-delimited UTF-8 frames as soon as process startup succeeds.
 * Startup failures reject. Reads accept CRLF, skip empty lines and reject oversized frames or
 * an unterminated nonblank tail. The transport drains stderr privately. Send appends a newline
 * and completes with process.write. Close awaits process.dispose and follows its ownership policy.
 * AhpAdapter.initializeConnection transfers the transport to AhpWire or closes it if disposal
 * occurred during acquisition. Direct transport users own close, including after EOF.
 */
export async function createStdioTransport(options: HarnessProcessOptions & {
  /** Acquire a process from the supplied options. The transport reads its output and disposes it on close. */
  processFactory?: (p: HarnessProcessOptions) => Promise<HarnessProcess>;
  /** Incoming decoded UTF-8 frame budget, including unfinished lines; defaults to 8 MiB. */
  maxFrameBytes?: number;
}): Promise<AhpTransport> {
  const process = await (options.processFactory ?? spawnHarnessProcess)(options);
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  void drainStderr(process).catch(() => {});
  return {
    messages: readStdioFrames(process, maxFrameBytes),
    send: message => process.write(message + "\n"),
    close: () => process.dispose(),
  };
}

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

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

/** Measure the raw frame in UTF-8 bytes so non-ASCII text counts against the same budget. */
function exceedsFrameLimit(frame: string, maxFrameBytes?: number): boolean {
  return new TextEncoder().encode(frame).byteLength > (maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
}

/** Decode a size-checked JSON-RPC 2.0 object. Throws FRAME_TOO_LARGE or PROTOCOL_ERROR for read to close the wire. */
function parseFrame(frame: string, maxFrameBytes?: number): Record<string, unknown> {
  if (exceedsFrameLimit(frame, maxFrameBytes)) throw new HarnessSdkError("FRAME_TOO_LARGE");
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new HarnessSdkError("PROTOCOL_ERROR");
  }
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

/** Keep stderr flowing without retaining private output. createStdioTransport ignores drain failure. */
async function drainStderr(process: HarnessProcess): Promise<void> {
  for await (const _ of process.stderr) {}
}

/** Decode stdout incrementally and enforce the byte budget on complete and unfinished lines. */
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
