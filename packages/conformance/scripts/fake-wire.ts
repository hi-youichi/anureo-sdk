import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import type { NativeFixtureFrame, WireFlavor } from "../src/fixtures";

interface WireMessage { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
/** Script data lives outside workspace manifests. No process is started until called. */
export async function runWireFake(flavor: Exclude<WireFlavor, "claude">): Promise<void> {
  const scriptPath = process.env.HARNESS_FIXTURE_SCRIPT;
  const frames: NativeFixtureFrame[] = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : [];
  let position = 0;
  const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(flavor === "codex" ? message : { jsonrpc: "2.0", ...message })}\n`);
  const substitute = (value: unknown, request: WireMessage): unknown => {
    if (value === "$requestId") return request.id;
    if (typeof value === "string" && value.startsWith("$params.")) return request.params?.[value.slice(8)];
    if (Array.isArray(value)) return value.map((entry) => substitute(entry, request));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substitute(child, request)]));
    return value;
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  // Arm the first input read before advertising readiness. This avoids racing cold
  // Bun module initialization with a parent that writes and immediately closes stdin.
  let pending = iterator.next();
  if (process.env.HARNESS_FIXTURE_READY === "1") process.stderr.write("HARNESS_FIXTURE_READY\n");
  for (;;) {
    const entry = await pending; if (entry.done) break; const line = entry.value;
    pending = iterator.next();
    let request: WireMessage;
    try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    const frame = frames[position];
    if (frame && (frame.waitForMethod === undefined || frame.waitForMethod === request.method)) {
      if (frame.expectedResponse && (request.id !== frame.expectedResponse.id || JSON.stringify(request.result) !== JSON.stringify(frame.expectedResponse.result))) { process.stderr.write("FIXTURE_RESPONSE_MISMATCH\n"); process.exitCode = 2; break; }
      position++;
      for (const message of frame.emit) send(substitute(message, request) as Record<string, unknown>);
      continue;
    }
    if (request.id === undefined || !request.method) continue;
    if (request.method === "initialize") {
      send({ id: request.id, result: flavor === "codex" ? { userAgent: "codex/0.164.0", platform: process.platform } : flavor === "acp" ? { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "vanilla-fake", version: "1" } } : { protocolVersion: 1, runtime: { name: "fake-ahp", version: "1", adapter: "reference" }, capabilities: {} } });
    } else if (request.method === "session/new") send({ id: request.id, result: { sessionId: "fake-acp-session" } });
    else if (request.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: request.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture response" } } } });
      send({ id: request.id, result: { stopReason: "end_turn" } });
    } else send({ id: request.id, error: { code: -32601, message: "Method not found" } });
  }
}
