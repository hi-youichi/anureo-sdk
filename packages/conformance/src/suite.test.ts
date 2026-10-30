import { expect, test } from "bun:test";
import { runConformance } from "./suite";
import { createScriptedAdapter, createScriptedConformanceFactory } from "./fake";
import type { TurnStartParams } from "@anureo/protocol";

test("public factory-driven conformance exercises every advertised capability", async () => {
  const report = await runConformance(createScriptedConformanceFactory());
  expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
  expect(report.passed).toBe(true); expect(report.cases).toHaveLength(15);
  expect(report.cases.every((entry) => entry.status === "passed")).toBe(true);
});
test("undeclared optional abilities are not applicable, but a declared broken capability fails", async () => {
  const base = createScriptedConformanceFactory({});
  const report = await runConformance(base, { scenarios: ["fork", "steer"] });
  expect(report.cases.every((entry) => entry.status === "not-applicable")).toBe(true);
  const broken = await runConformance(() => ({ adapter: createScriptedAdapter({ capabilities: { session: { fork: ["before"], history: true } }, onOpen: async (params) => { if (params.mode === "fork") throw new Error("Fork not implemented"); } }), openParams: { requestId: "open", mode: "new", cwd: "/tmp", binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" } } }), { scenarios: ["fork"] });
  expect(broken.passed).toBe(false); expect(broken.cases[0]).toMatchObject({ scenario: "fork", status: "failed" });
});
test("a source that never emits a terminal event fails the case instead of hanging", async () => {
  const report = await runConformance(() => ({
    adapter: createScriptedAdapter({ execute: async (call, sink) => {
      if (call.method !== "turn/start") return undefined;
      const { turnId } = call.params as unknown as TurnStartParams;
      await sink.emit({ type: "turn/started", payload: { turnId } });
      for (let index = 0; index < 10_001; index++) await sink.emit({ type: "notice", payload: { severity: "info", code: "FLOOD", message: "no terminal event" } });
      return { accepted: true, turnId };
    } }),
    openParams: { requestId: "open", mode: "new", cwd: "/tmp", binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" } },
  }), { scenarios: ["lifecycle"] });
  expect(report.passed).toBe(false);
  expect(report.cases[0]).toMatchObject({ scenario: "lifecycle", status: "failed", message: "Too many events without completion" });
});

test("a hanging source is bounded by the conformance deadline", async () => {
  const report = await runConformance(() => ({
    adapter: createScriptedAdapter({ execute: async (call, sink) => {
      if (call.method !== "turn/start") return undefined;
      const { turnId } = call.params as unknown as TurnStartParams;
      await sink.emit({ type: "turn/started", payload: { turnId } });
      return await new Promise(() => {});
    } }),
    openParams: { requestId: "open", mode: "new", cwd: "/tmp", binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" } },
  }), { scenarios: ["lifecycle"], timeoutMs: 50 });
  expect(report.passed).toBe(false);
  expect(report.cases[0]).toMatchObject({ scenario: "lifecycle", status: "failed", message: "Conformance timed out" });
});

test("a rejected startTurn fails the case with the native cause", async () => {
  const report = await runConformance(() => ({
    adapter: createScriptedAdapter({ execute: async (call, sink) => {
      if (call.method !== "turn/start") return undefined;
      const { turnId } = call.params as unknown as TurnStartParams;
      await sink.emit({ type: "turn/started", payload: { turnId } });
      throw new Error("Native start failed");
    } }),
    openParams: { requestId: "open", mode: "new", cwd: "/tmp", binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" } },
  }), { scenarios: ["lifecycle"] });
  expect(report.passed).toBe(false);
  expect(report.cases[0]).toMatchObject({ scenario: "lifecycle", status: "failed", message: "Native start failed" });
});
