import { expect, test } from "bun:test";
import { spawnHarnessProcess, type HarnessProcess } from "@anureo/sdk/process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeClaudeQuery } from "./fake-claude";
import type { NativeFixtureFrame, WireFlavor } from "./fixtures";

for (const flavor of ["codex", "acp", "ahp"] as const) test(`fake ${flavor} JSONL backend substitutes IDs and emits scripted native frames`, async () => {
  const { output, exit } = await exchangeWithFake({
    flavor,
    script: [{ waitForMethod: "custom/test", emit: [{ id: "$requestId", result: { value: "$params.value" } }] }],
    input: [JSON.stringify({ id: 7, method: "custom/test", params: { value: "correct" } })],
  });
  expect(exit.code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ id: 7, result: { value: "correct" } });
  expect(JSON.parse(output).jsonrpc).toBe(flavor === "codex" ? undefined : "2.0");
});

test("wire defaults and parse recovery leave the next scripted step pending", async () => {
  const { output, exit } = await exchangeWithFake({
    flavor: "acp",
    script: [
      { waitForMethod: "custom/test", emit: [{ id: "$requestId", result: { nested: ["$params.value", "$params.absent"] } }] },
      { expectedResponse: { id: "peer-call", result: { ok: true } }, emit: [{ method: "verified" }] },
    ],
    input: [
      "invalid JSON",
      JSON.stringify({ id: 1, method: "initialize" }),
      JSON.stringify({ method: "notification" }),
      JSON.stringify({ id: 2, method: "session/new" }),
      JSON.stringify({ id: 3, method: "session/prompt", params: { sessionId: "session" } }),
      JSON.stringify({ id: 4, method: "unknown" }),
      JSON.stringify({ id: 5, method: "custom/test", params: { value: "scripted" } }),
      JSON.stringify({ id: "peer-call", result: { ok: true } }),
    ],
  });
  expect(exit.code).toBe(0);
  expect(output.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "vanilla-fake", version: "1" } } },
    { jsonrpc: "2.0", id: 2, result: { sessionId: "fake-acp-session" } },
    { jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture response" } } } },
    { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } },
    { jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found" } },
    { jsonrpc: "2.0", id: 5, result: { nested: ["scripted", null] } },
    { jsonrpc: "2.0", method: "verified" },
  ]);
});

for (const response of [
  { id: "wrong", result: { first: 1, second: 2 } },
  { id: "peer-call", result: { first: 0, second: 2 } },
  { id: "peer-call", result: { second: 2, first: 1 } },
]) test(`wire response mismatch stops before emission: ${JSON.stringify(response)}`, async () => {
  const { output, diagnostics, exit } = await exchangeWithFake({
    flavor: "codex",
    script: [{ expectedResponse: { id: "peer-call", result: { first: 1, second: 2 } }, emit: [{ method: "must-not-emit" }] }],
    input: [JSON.stringify(response), JSON.stringify({ id: 1, method: "initialize" })],
  });
  expect(exit.code).toBe(2);
  expect(output).toBe("");
  expect(diagnostics).toContain("FIXTURE_RESPONSE_MISMATCH\n");
});
test("fake Claude query streams typed messages and records control calls without a real SDK", async () => {
  const query = createFakeClaudeQuery({
    messages: [{ type: "system", subtype: "init" }],
    canRewind: true,
    onInput: async (_, emit) => {
      await emit({ type: "result", subtype: "success" });
    },
  });
  const reader = query[Symbol.asyncIterator]();
  expect((await reader.next()).value).toMatchObject({ type: "system" });

  await query.streamInput((async function* () {
    yield { type: "user", content: "hello" };
  })());
  expect((await reader.next()).value).toMatchObject({ type: "result" });

  await query.setModel("fake-model");
  await query.interrupt();
  expect(await query.rewindFiles("checkpoint")).toEqual({ canRewind: true });

  query.close();
  expect((await reader.next()).done).toBe(true);
  expect(query.calls.map((call) => call.method)).toEqual(["input", "setModel", "interrupt", "rewindFiles", "close"]);
});

/** Run a bounded JSONL exchange and own its temporary script, process and timeout, including failed exchanges. */
async function exchangeWithFake({ flavor, script, input }: {
  flavor: Exclude<WireFlavor, "claude">;
  script: readonly NativeFixtureFrame[];
  input: readonly string[];
}) {
  const directory = await mkdtemp(join(tmpdir(), "harness fixture "));
  try {
    const fixture = join(directory, "script.json");
    await writeFile(fixture, JSON.stringify(script));
    const child = await spawnHarnessProcess({ command: process.execPath, args: [fileURLToPath(new URL(`../scripts/fake-${flavor}.ts`, import.meta.url))], env: { ...process.env, HARNESS_FIXTURE_SCRIPT: fixture, HARNESS_FIXTURE_READY: "1" } });
    const observation = observeFakeOutput(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exchangeCompletion = completeExchange({ child, observation, input });
      // The exchange can reject after timeout while disposal closes its pipes.
      void exchangeCompletion.catch(() => {});
      const exchangeTimeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fake ${flavor} did not complete its JSONL exchange`)), 4000);
      });
      return await Promise.race([exchangeCompletion, exchangeTimeout]);
    } finally {
      if (timer) clearTimeout(timer);
      await child.dispose();
      await Promise.allSettled([observation.read, observation.readErrors]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Drain both pipes concurrently; readiness resolves from stderr while snapshots retain all stdout and bounded diagnostics. */
function observeFakeOutput(child: HarnessProcess) {
  let output = "", diagnostics = "";
  const decoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => { ready = resolve; });
  const read = (async () => {
    for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
  })();
  const readErrors = (async () => {
    for await (const chunk of child.stderr) {
      diagnostics = (diagnostics + stderrDecoder.decode(chunk, { stream: true })).slice(-2048);
      if (diagnostics.includes("HARNESS_FIXTURE_READY")) ready();
    }
  })();
  return { listening, read, readErrors, snapshot: () => ({ output, diagnostics }) };
}

/** Wait for the armed peer before writing and closing input, then collect exit and output EOF; I/O failures reject. */
async function completeExchange({ child, observation, input }: {
  child: HarnessProcess;
  observation: ReturnType<typeof observeFakeOutput>;
  input: readonly string[];
}) {
  await observation.listening;
  await child.write(`${input.join("\n")}\n`);
  await child.closeInput();
  const exit = await child.exited;
  await observation.read;
  await observation.readErrors;
  return { exit, ...observation.snapshot() };
}
