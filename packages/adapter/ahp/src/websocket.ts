/** Owns WebSocket address policy, connection setup and bounded incoming text frames. */
import { BoundedEventQueue, HarnessSdkError } from "@anureo/sdk";
import type { AhpTransport } from "./wire";

/**
 * Open a text-frame transport for AhpAdapterOptions.connect or direct AhpWire use. Resolve once
 * the socket is open, before AHP negotiation. The owner must close the returned transport.
 * Accept wss: or loopback ws: and reject parsed credentials or nonempty query/fragment components.
 * Address, construction and queue setup failures reject setup. An error or close before open
 * rejects with RPC_CONNECTION_FAILED. An expired handshake rejects with RPC_TIMEOUT.
 * After a setup failure, the helper attempts to close the socket before returning the error.
 * Native error and close events end reads. Non-text or rejected frames also initiate socket close.
 * Buffer up to 2048 incoming frames and drain buffered frames before reporting read failure.
 * Send resolves after socket.send accepts data. Close resolves after initiating native closure.
 * A native exception during either operation rejects that operation.
 */
export async function createWebSocketTransport(url: string, options: {
  /** Construct a socket from the original validated URL. Omission uses the global WebSocket or rejects if unavailable. */
  factory?: (url: string) => WebSocket;
  /** Socket open timeout in milliseconds. Defaults to 30,000. */
  timeoutMs?: number;
  /** Incoming UTF-8 frame budget. Defaults to 8 MiB and must be a positive safe integer. */
  maxFrameBytes?: number;
  /** Incoming byte budget and outgoing bufferedAmount threshold. Defaults to 16 MiB and must be a positive safe integer. */
  maxBufferedBytes?: number;
} = {}): Promise<AhpTransport> {
  validateWebSocketAddress(url);
  if (!options.factory && typeof WebSocket === "undefined") throw new HarnessSdkError("WEBSOCKET_FACTORY_REQUIRED");
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const queue = new BoundedEventQueue<string>({
    maxFrameBytes: options.maxFrameBytes,
    maxBytes: maxBufferedBytes,
    maxEvents: 2048,
  }, frame => new TextEncoder().encode(frame).byteLength);
  const socket = options.factory ? options.factory(url) : new WebSocket(url);
  try {
    const transport = createSocketTransport(socket, queue, maxBufferedBytes);
    await waitForConnection(socket, options.timeoutMs ?? 30_000);
    return transport;
  } catch (cause) {
    try { socket.close(); } catch {}
    throw cause;
  }
}

const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/**
 * Check address policy before the factory receives the URL. Propagate URL parse failures and
 * throw INVALID_PARAMS for unsupported protocols, restricted URL components or remote plaintext.
 */
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
 * Set up framed reads and local close state before createWebSocketTransport waits for open,
 * so early frames and failures are retained.
 */
function createSocketTransport(socket: WebSocket, queue: BoundedEventQueue<string>, maxBufferedBytes: number): AhpTransport {
  let closed = false;
  /** Message events admit text frames. Failure ends the queue with the cause before native close can fire. */
  const receiveFrame = (event: MessageEvent<unknown>) => {
    try {
      if (typeof event.data !== "string") throw new HarnessSdkError("PROTOCOL_ERROR");
      queue.push(event.data);
    } catch (cause) {
      queue.end(cause);
      socket.close();
    }
  };

  /** Native errors and closes fail reads after buffered frames drain. The owner still handles socket release. */
  const failReads = () => {
    queue.end(new HarnessSdkError("RPC_CONNECTION_CLOSED", "RPC_CONNECTION_CLOSED", false, true));
  };

  socket.addEventListener("message", receiveFrame);
  socket.addEventListener("close", () => {
    closed = true;
    failReads();
  });
  socket.addEventListener("error", failReads);
  return {
    messages: queue,
    /** Reject unless open or if bufferedAmount exceeds the threshold before sending. Native send failures propagate. */
    async send(message) {
      if (closed || socket.readyState !== 1) {
        throw new HarnessSdkError("RPC_CONNECTION_CLOSED", "RPC_CONNECTION_CLOSED", false, true);
      }
      if (socket.bufferedAmount > maxBufferedBytes) {
        throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
      }
      socket.send(message);
    },
    /** Mark closed before invoking native close to prevent duplicate close calls. End reads after native close returns. */
    async close() {
      if (closed) return;
      closed = true;
      socket.close();
      queue.end();
    },
  };
}

/**
 * Await socket readiness for createWebSocketTransport, accepting an already-open factory socket.
 * Open, error, close and timeout settle setup and remove the temporary listeners.
 */
function waitForConnection(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      removeHandshakeListeners();
      reject(new HarnessSdkError("RPC_TIMEOUT"));
    }, timeoutMs);
    /** Detach setup callbacks and clear the deadline when a socket event settles setup. */
    const removeHandshakeListeners = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onConnectionFailure);
      socket.removeEventListener("close", onConnectionFailure);
    };
    const onOpen = () => {
      removeHandshakeListeners();
      resolve();
    };
    const onConnectionFailure = () => {
      removeHandshakeListeners();
      reject(new HarnessSdkError("RPC_CONNECTION_FAILED"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onConnectionFailure);
    socket.addEventListener("close", onConnectionFailure);
    if (socket.readyState === 1) onOpen();
  });
}
