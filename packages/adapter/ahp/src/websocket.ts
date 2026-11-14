/** Owns WebSocket address policy, connection setup and bounded incoming text frames. */
import { BoundedEventQueue, HarnessSdkError } from "@anureo/sdk";
import type { AhpTransport } from "./wire";

/**
 * Open a text-frame transport for AhpAdapterOptions.connect or direct AhpWire use. Resolve after
 * open, without negotiating AHP; the returned transport's owner must close it. Accept wss: or
 * loopback ws: without credentials, query or fragment. Invalid addresses, unavailable WebSocket,
 * factory/queue failures and handshake error/close/timeout reject; a timeout initiates socket close.
 * Incoming binary frames or queue overflow end reads with failure and initiate socket close.
 * Buffer at most 2048 incoming frames; buffered frames drain before read failure. send resolves
 * after socket.send, without waiting for drain. close initiates closure without awaiting its event;
 * native send/close exceptions reject their respective operations.
 */
export async function createWebSocketTransport(url: string, options: {
  /** Supply a WebSocket implementation; omitted uses the runtime global, if available. */
  factory?: (url: string) => WebSocket;
  /** Handshake timeout in milliseconds; defaults to 30,000. */
  timeoutMs?: number;
  /** Incoming UTF-8 frame budget; defaults to 8 MiB and must be a positive safe integer. */
  maxFrameBytes?: number;
  /** Incoming byte budget and outgoing bufferedAmount threshold; defaults to 16 MiB, a positive safe integer. */
  maxBufferedBytes?: number;
} = {}): Promise<AhpTransport> {
  validateWebSocketAddress(url);
  if (!options.factory && typeof WebSocket === "undefined") throw new HarnessSdkError("WEBSOCKET_FACTORY_REQUIRED");
  const socket = options.factory ? options.factory(url) : new WebSocket(url);
  const transport = createSocketTransport(socket, options);
  await waitForConnection(socket, options.timeoutMs ?? 30_000);
  return transport;
}

/** Reject address features that could expose credentials or allow plaintext connections off loopback. */
function validateWebSocketAddress(url: string): void {
  const address = new URL(url);
  const isSupportedProtocol = ["ws:", "wss:"].includes(address.protocol);
  const hasForbiddenAddressInfo = Boolean(address.username || address.password || address.search || address.hash);
  const isPlaintextRemoteHost = address.protocol === "ws:"
    && !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname);
  if (!isSupportedProtocol || hasForbiddenAddressInfo || isPlaintextRemoteHost) {
    throw new HarnessSdkError("INVALID_PARAMS", "Invalid AHP WebSocket address");
  }
}

/**
 * Register source listeners before waiting for open so early frames/failures are retained. This
 * scope owns the queue and close state; ending reads on error does not itself close the socket.
 */
function createSocketTransport(socket: WebSocket, options: { maxFrameBytes?: number; maxBufferedBytes?: number }): AhpTransport {
  const queue = new BoundedEventQueue<string>({ maxFrameBytes: options.maxFrameBytes, maxBytes: options.maxBufferedBytes ?? 16 * 1024 * 1024, maxEvents: 2048 }, v => new TextEncoder().encode(v).byteLength);
  let closed = false;
  /** Native error/close events fail reads after buffered frames have drained. */
  const fail = () => { queue.end(new HarnessSdkError("RPC_CONNECTION_CLOSED", "RPC_CONNECTION_CLOSED", false, true)); };
  socket.addEventListener("message", event => {
    try {
      if (typeof event.data !== "string") throw new HarnessSdkError("PROTOCOL_ERROR");
      queue.push(event.data);
    } catch (cause) {
      queue.end(cause);
      socket.close();
    }
  });
  socket.addEventListener("close", () => { closed = true; fail(); });
  socket.addEventListener("error", fail);
  return {
    messages: queue,
    /** Resolve once socket.send accepts the frame; reject closed state, excess bufferedAmount or native send failure. */
    async send(message) {
      if (closed || socket.readyState !== 1) {
        throw new HarnessSdkError("RPC_CONNECTION_CLOSED", "RPC_CONNECTION_CLOSED", false, true);
      }
      if (socket.bufferedAmount > (options.maxBufferedBytes ?? 16 * 1024 * 1024)) {
        throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
      }
      socket.send(message);
    },
    /** Idempotently initiate native close and end reads; completion does not wait for the close event. */
    async close() {
      if (closed) return;
      closed = true;
      socket.close();
      queue.end();
    },
  };
}

/**
 * Own the temporary handshake listeners and timer. Error/close rejects RPC_CONNECTION_FAILED;
 * timeout closes first, so a synchronous close event can win over its RPC_TIMEOUT rejection.
 */
function waitForConnection(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new HarnessSdkError("RPC_TIMEOUT")); }, timeoutMs);
    /** Open/error/close listeners detach the handshake callbacks without affecting source listeners. */
    const cleanupConnectionWait = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onConnectionFailure);
      socket.removeEventListener("close", onConnectionFailure);
    };
    const onOpen = () => {
      cleanupConnectionWait();
      resolve();
    };
    const onConnectionFailure = () => {
      cleanupConnectionWait();
      reject(new HarnessSdkError("RPC_CONNECTION_FAILED"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onConnectionFailure);
    socket.addEventListener("close", onConnectionFailure);
    if (socket.readyState === 1) onOpen();
  });
}
