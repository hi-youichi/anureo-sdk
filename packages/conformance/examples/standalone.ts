import { createHarnessRuntime } from "@anureo/sdk";
import { createScriptedAdapter } from "../src/fake";

const runtime = createHarnessRuntime(createScriptedAdapter());
await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "standalone-example", version: "1" } });
const session = await runtime.openSession({ requestId: "open", mode: "new", binding: { sessionId: "example-session", adapterId: "scripted", runtimeConfigId: "example-runtime" }, cwd: process.cwd(), config: { model: "fake-model" } });
const reader = session.events()[Symbol.asyncIterator]();
const turn = session.startTurn({ requestId: "start", sessionId: session.binding.sessionId, turnId: "example-turn", input: [{ type: "text", text: "Hello from the independent Harness SDK" }] });
while (true) {
  const event = await reader.next();
  if (event.done) throw new Error("Missing terminal event");
  if (event.value.type === "item/completed" && event.value.payload.item.type === "agentMessage") process.stdout.write(`${event.value.payload.item.text}\n`);
  if (event.value.type === "turn/completed") break;
}
await turn; await reader.return?.(); await session.close(); await runtime.dispose();
