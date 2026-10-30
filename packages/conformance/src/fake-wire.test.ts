import { expect, test } from "bun:test";
import { spawnHarnessProcess } from "@anureo/sdk/process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeClaudeQuery } from "./fake-claude";

for (const flavor of ["codex", "acp", "ahp"]) test(`fake ${flavor} JSONL backend substitutes IDs and emits scripted native frames`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness fixture ")); const fixture = join(directory, "script.json");
  await writeFile(fixture, JSON.stringify([{ waitForMethod: "custom/test", emit: [{ id: "$requestId", result: { value: "$params.value" } }] }]));
  const child = await spawnHarnessProcess({ command: process.execPath, args: [fileURLToPath(new URL(`../scripts/fake-${flavor}.ts`, import.meta.url))], env: { ...process.env, HARNESS_FIXTURE_SCRIPT: fixture, HARNESS_FIXTURE_READY: "1" } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let output = "", diagnostics = "";
  const decoder = new TextDecoder(); const stderrDecoder = new TextDecoder();
  let ready!: () => void; const listening = new Promise<void>((resolve) => { ready = resolve; });
  const read = (async () => { for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true }); })();
  const readErrors = (async () => { for await (const chunk of child.stderr) { diagnostics = (diagnostics + stderrDecoder.decode(chunk, { stream: true })).slice(-2048); if (diagnostics.includes("HARNESS_FIXTURE_READY")) ready(); } })();
  try {
    const completion = (async () => {
      await listening;
      await child.write(`${JSON.stringify({ id: 7, method: "custom/test", params: { value: "correct" } })}\n`); await child.closeInput(); const exit = await child.exited; await read; await readErrors;
      if (exit.code !== 0 || !output.trim()) throw new Error(`Fake ${flavor} exited ${exit.code} without a valid frame: ${diagnostics}`);
    })();
    void completion.catch(() => {});
    await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Fake ${flavor} did not complete its JSONL exchange`)), 4000); })]);
    expect(JSON.parse(output)).toMatchObject({ id: 7, result: { value: "correct" } });
    expect(JSON.parse(output).jsonrpc).toBe(flavor === "codex" ? undefined : "2.0");
  } finally { if (timer) clearTimeout(timer); await child.dispose(); await Promise.allSettled([read, readErrors]); await rm(directory, { recursive: true, force: true }); }
});
test("fake Claude query streams typed messages and records control calls without a real SDK", async () => {
  const query = createFakeClaudeQuery({ messages: [{ type: "system", subtype: "init" }], canRewind: true, onInput: async (_, emit) => { await emit({ type: "result", subtype: "success" }); } });
  const reader = query[Symbol.asyncIterator](); expect((await reader.next()).value).toMatchObject({ type: "system" });
  await query.streamInput((async function* () { yield { type: "user", content: "hello" }; })());
  expect((await reader.next()).value).toMatchObject({ type: "result" }); await query.setModel("fake-model"); await query.interrupt(); expect(await query.rewindFiles("checkpoint")).toEqual({ canRewind: true });
  query.close(); expect((await reader.next()).done).toBe(true); expect(query.calls.map((call) => call.method)).toEqual(["input", "setModel", "interrupt", "rewindFiles", "close"]);
});
