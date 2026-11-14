import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { AHP_PROTOCOL_CONTRACT, type InitializeResult } from "@anureo/protocol";
import type { NativeFixtureFrame, WireFlavor } from "../src/fixtures";

/**
 * Serve newline-delimited protocol messages on this process's stdio. Each of
 * fake-acp.ts, fake-ahp.ts and fake-codex.ts awaits this with its protocol flavor.
 * ACP and AHP add a default JSON-RPC version. Codex preserves the supplied envelope.
 * HARNESS_FIXTURE_SCRIPT is the path to a JSON array of NativeFixtureFrame steps.
 * An unset or empty path selects default replies only. Script loading and processing
 * failures reject the executable's top-level await. Invalid input gets a JSON-RPC error reply.
 * Resolve on input EOF or a response mismatch. A mismatch writes FIXTURE_RESPONSE_MISMATCH
 * to stderr and EOF with unconsumed steps writes FIXTURE_SCRIPT_INCOMPLETE. Both set exit code 2.
 * The parent owns stdin closure, output draining and process disposal.
 * The promise can resolve with stdout writes still pending. Set HARNESS_FIXTURE_READY
 * to "1" to get the HARNESS_FIXTURE_READY marker on stderr after the first read is armed.
 */
export async function runWireFake(flavor: Exclude<WireFlavor, "claude">): Promise<void> {
  const scriptPath = process.env.HARNESS_FIXTURE_SCRIPT;
  const frames: unknown = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : [];
  if (!Array.isArray(frames)) throw new TypeError("HARNESS_FIXTURE_SCRIPT must contain a JSON array of fixture steps");
  const send: WireSender = (message) => {
    const envelope = flavor === "codex" ? message : { jsonrpc: "2.0", ...message };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  };
  const handler = createRequestHandler({ flavor, frames, send });
  await readWireRequests({ send, ...handler });
}

interface WireMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}
type WireSender = (message: Record<string, unknown>) => void;
interface RequestHandler {
  handleRequest(request: WireMessage): "continue" | "stop";
  hasPendingFrames(): boolean;
}

/**
 * Read ahead for runWireFake and dispatch parsed messages in order. Invalid messages
 * receive error replies without advancing the script. EOF or a handler stop ends dispatch.
 * Handler exceptions reject the run. The parent remains responsible for ending stdin,
 * including after a stop with a read already pending.
 */
async function readWireRequests({ send, handleRequest, hasPendingFrames }: RequestHandler & { send: WireSender }): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  // Arm the first input read before advertising readiness. This avoids racing cold
  // Bun module initialization with a parent that writes and immediately closes stdin.
  let pendingLineRead = iterator.next();
  if (process.env.HARNESS_FIXTURE_READY === "1") process.stderr.write("HARNESS_FIXTURE_READY\n");
  for (;;) {
    const entry = await pendingLineRead;
    if (entry.done) {
      if (hasPendingFrames()) {
        process.stderr.write("FIXTURE_SCRIPT_INCOMPLETE\n");
        process.exitCode = 2;
      }
      return;
    }
    const line = entry.value;
    pendingLineRead = iterator.next();
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      send({ id: null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    if (handleRequest(request as WireMessage) === "stop") return;
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
  let nextSessionId = 0;
  const allocateSessionId = () => `fake-acp-session-${++nextSessionId}`;
  function handleRequest(request: WireMessage): "continue" | "stop" {
    const frame = frames[position];
    if (!frame || (frame.waitForMethod !== undefined && frame.waitForMethod !== request.method)) {
      sendDefaultResponse({ flavor, request, send, allocateSessionId });
      return "continue";
    }
    const fields = frame.expectedResponse && differingResponseFields(request, frame.expectedResponse);
    if (fields?.length) {
      process.stderr.write("FIXTURE_RESPONSE_MISMATCH\n");
      process.stderr.write(`Fixture step ${position + 1} differs in ${fields.join(", ")}\n`);
      process.exitCode = 2;
      return "stop";
    }
    position++;
    for (const message of frame.emit) {
      send(substituteFixtureValue(message, request) as Record<string, unknown>);
    }
    return "continue";
  }
  return { handleRequest, hasPendingFrames: () => position < frames.length };
}

/** Compare peer replies exactly as authored, including result property order in their JSON encoding. */
function differingResponseFields(request: WireMessage, expected: NonNullable<NativeFixtureFrame["expectedResponse"]>): string[] {
  const fields: string[] = [];
  if (request.id !== expected.id) fields.push("id");
  if (JSON.stringify(request.result) !== JSON.stringify(expected.result)) fields.push("result JSON");
  return fields;
}

/**
 * Expand script values against the message that advanced the cursor. "$params." addresses
 * one literal key. Missing substitutions become undefined, so JSON serialization omits
 * object properties and writes null for array entries.
 */
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
 * Give the script handler fallback replies for messages with both an ID and a method.
 * Prompt updates precede the terminal reply so the parent receives fixture text before end_turn.
 * Unknown request methods receive -32601.
 */
function sendDefaultResponse({ flavor, request, send, allocateSessionId }: {
  flavor: Exclude<WireFlavor, "claude">;
  request: WireMessage;
  send: WireSender;
  allocateSessionId: () => string;
}): void {
  if (request.id === undefined || !request.method) return;
  switch (request.method) {
    case "initialize":
      send({ id: request.id, result: createInitializeResult(flavor) });
      return;
    case "session/new":
      send({ id: request.id, result: { sessionId: flavor === "acp" ? allocateSessionId() : "fake-acp-session" } });
      return;
    case "session/prompt":
      send({
        method: "session/update",
        params: {
          sessionId: request.params?.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "fixture response" },
          },
        },
      });
      send({ id: request.id, result: { stopReason: "end_turn" } });
      return;
    default:
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
    protocolContract: AHP_PROTOCOL_CONTRACT,
    runtime: { name: "fake-ahp", version: "1", adapter: "reference" },
    capabilities: {},
  } satisfies InitializeResult;
}
