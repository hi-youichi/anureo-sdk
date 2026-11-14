import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import type { NativeFixtureFrame, WireFlavor } from "../src/fixtures";

/**
 * Serve JSONL on this process's stdio for fake-acp.ts, fake-ahp.ts and fake-codex.ts.
 * HARNESS_FIXTURE_SCRIPT selects a JSON array of NativeFixtureFrame steps; an unset
 * or empty path uses only default replies. Script read/parse and processing failures reject
 * to the executable; malformed input lines receive parse-error replies instead.
 * Resolve on input EOF or an expected-response mismatch; mismatch sets exit code 2.
 * HARNESS_FIXTURE_READY=1 requests a stderr readiness marker after the first read is armed.
 * The parent owns stdin closure and process disposal; stdout writes are not awaited for drain.
 */
export async function runWireFake(flavor: Exclude<WireFlavor, "claude">): Promise<void> {
  const scriptPath = process.env.HARNESS_FIXTURE_SCRIPT;
  const frames: NativeFixtureFrame[] = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : [];
  const send: WireSender = (message) => {
    process.stdout.write(`${JSON.stringify(flavor === "codex" ? message : { jsonrpc: "2.0", ...message })}\n`);
  };
  const handleRequest = createRequestHandler({ flavor, frames, send });
  await readWireRequests({ send, handleRequest });
}

interface WireMessage { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
type WireSender = (message: Record<string, unknown>) => void;
type RequestHandler = (request: WireMessage) => "continue" | "stop";

/**
 * Own read-ahead and parse recovery for runWireFake. Invoke handleRequest for parsed
 * messages until EOF or its stop result; malformed JSON emits a parse error without
 * consuming a script step. Read and handler failures reject without retrying.
 */
async function readWireRequests({ send, handleRequest }: { send: WireSender; handleRequest: RequestHandler }): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  // Arm the first input read before advertising readiness. This avoids racing cold
  // Bun module initialization with a parent that writes and immediately closes stdin.
  let pendingLineRead = iterator.next();
  if (process.env.HARNESS_FIXTURE_READY === "1") process.stderr.write("HARNESS_FIXTURE_READY\n");
  for (;;) {
    const entry = await pendingLineRead;
    if (entry.done) {
      break;
    }
    const line = entry.value;
    pendingLineRead = iterator.next();
    let request: WireMessage;
    try {
      request = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (handleRequest(request) === "stop") break;
  }
}

/**
 * Own the script cursor for one runWireFake invocation. readWireRequests invokes the
 * returned handler; only matching steps advance, before their messages are emitted.
 * A response mismatch emits no frame, sets exit code 2 and tells the reader to stop.
 * Unmatched messages use default replies without advancing; emission failures propagate.
 */
function createRequestHandler({ flavor, frames, send }: {
  flavor: Exclude<WireFlavor, "claude">;
  frames: readonly NativeFixtureFrame[];
  send: WireSender;
}): RequestHandler {
  let position = 0;
  return (request) => {
    const frame = frames[position];
    if (frame && (frame.waitForMethod === undefined || frame.waitForMethod === request.method)) {
      if (frame.expectedResponse && !matchesExpectedResponse(request, frame.expectedResponse)) {
        process.stderr.write("FIXTURE_RESPONSE_MISMATCH\n");
        process.exitCode = 2;
        return "stop";
      }
      position++;
      for (const message of frame.emit) send(substituteFixtureValue(message, request) as Record<string, unknown>);
    } else {
      sendDefaultResponse({ flavor, request, send });
    }
    return "continue";
  };
}

/** Compare peer replies exactly as authored, including result property order in their JSON encoding. */
function matchesExpectedResponse(request: WireMessage, expected: NonNullable<NativeFixtureFrame["expectedResponse"]>): boolean {
  return request.id === expected.id && JSON.stringify(request.result) === JSON.stringify(expected.result);
}

/** Expand script values recursively; "$params." addresses one literal key, and absent values remain undefined. */
function substituteFixtureValue(value: unknown, request: WireMessage): unknown {
  if (value === "$requestId") return request.id;
  if (typeof value === "string" && value.startsWith("$params.")) return request.params?.[value.slice(8)];
  if (Array.isArray(value)) return value.map((entry) => substituteFixtureValue(entry, request));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substituteFixtureValue(child, request)]));
  }
  return value;
}

/**
 * Reply to unmatched requests, ignoring notifications/responses. Prompt updates precede
 * the terminal reply so consumers observe fixture text before end_turn; unknown methods receive -32601.
 */
function sendDefaultResponse({ flavor, request, send }: {
  flavor: Exclude<WireFlavor, "claude">;
  request: WireMessage;
  send: WireSender;
}): void {
  if (request.id === undefined || !request.method) return;
  if (request.method === "initialize") {
    send({ id: request.id, result: createInitializeResult(flavor) });
  } else if (request.method === "session/new") {
    send({ id: request.id, result: { sessionId: "fake-acp-session" } });
  } else if (request.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: request.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture response" } } } });
    send({ id: request.id, result: { stopReason: "end_turn" } });
  } else {
    send({ id: request.id, error: { code: -32601, message: "Method not found" } });
  }
}

/** Supply the minimal flavor-specific handshake metadata used by the default initialize reply. */
function createInitializeResult(flavor: Exclude<WireFlavor, "claude">) {
  if (flavor === "codex") {
    return {
      userAgent: "codex/0.164.0",
      platform: process.platform,
    };
  }
  if (flavor === "acp") {
    return {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "vanilla-fake", version: "1" },
    };
  }
  return {
    protocolVersion: 1,
    runtime: { name: "fake-ahp", version: "1", adapter: "reference" },
    capabilities: {},
  };
}
