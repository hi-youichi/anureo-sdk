import { expect, test } from "bun:test";
import type { InputSubmitParams } from "@anureo/protocol";
import { runConformance, type ConformanceDriver } from "./suite";
import { createScriptedAdapter, createScriptedConformanceFactory, type FakeAdapterOptions } from "./fake";

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
  const brokenForkReport = await runConformance(
    () => ({
      adapter: createScriptedAdapter({
        capabilities: {
          input: { delivery: ["native"] },
          session: { fork: ["before"], history: true },
        },
        onOpen: async (params) => {
          if (params.mode === "fork") {
            throw new Error("Fork not implemented");
          }
        },
      }),
      openParams: {
        requestId: "open",
        mode: "new",
        cwd: "/tmp",
        binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" },
      },
    }),
    { scenarios: ["fork"] },
  );
  expect(brokenForkReport.passed).toBe(false);
  expect(brokenForkReport.cases[0]).toMatchObject({ scenario: "fork", status: "failed" });
});
test("a source that never emits a terminal event fails the case instead of hanging", async () => {
  const report = await runConformance(
    lifecycleDriver(async (call, sink) => {
      if (call.method !== "input/submit") return undefined;
      const { submissionId } = call.params as InputSubmitParams;
      const turnId = "actual-execution";
      await sink.emit({ type: "turn/started", payload: { turnId } });
      for (let index = 0; index < 10_001; index++) await sink.emit({ type: "notice", payload: { severity: "info", code: "FLOOD", message: "no terminal event" } });
      return { submissionId, accepted: true, disposition: "started", turnId };
    }),
    { scenarios: ["lifecycle"] },
  );
  expect(report.passed).toBe(false);
  expect(report.cases[0]).toMatchObject({ scenario: "lifecycle", status: "failed", message: "Too many events without completion" });
});

test("a hanging source is bounded by the conformance deadline", async () => {
  const report = await runConformance(
    lifecycleDriver(async (call, sink) => {
      if (call.method !== "input/submit") return undefined;
      await sink.emit({ type: "turn/started", payload: { turnId: "actual-execution" } });
      return await new Promise(() => {});
    }),
    { scenarios: ["lifecycle"], timeoutMs: 50 },
  );
  expect(report.passed).toBe(false);
  expect(report.cases[0]).toMatchObject({ scenario: "lifecycle", status: "failed", message: "Conformance timed out" });
});

test("a rejected input submission fails the case with the native cause", async () => {
  const report = await runConformance(
    lifecycleDriver(async (call, sink) => {
      if (call.method !== "input/submit") return undefined;
      await sink.emit({ type: "turn/started", payload: { turnId: "actual-execution" } });
      throw new Error("Native start failed");
    }),
    { scenarios: ["lifecycle"] },
  );
  expect(report.passed).toBe(false);
  expect(report.cases[0]).toMatchObject({ scenario: "lifecycle", status: "failed", message: "Native start failed" });
});

for (const scenario of ['lifecycle', 'fork', 'history'] as const) {
  test(`client release failure replaces the ${scenario} verdict and later cases still run`, async () => {
    const base = createScriptedConformanceFactory(scenario === 'fork' ? { input: { delivery: ['native'] } } : undefined);
    const adapters: ReturnType<typeof createScriptedAdapter>[] = [];
    const report = await runConformance(async selected => {
      const driver = await base(selected);
      const adapter = driver.adapter as ReturnType<typeof createScriptedAdapter>;
      adapters.push(adapter);
      if (adapters.length === 1) {
        adapter.dispose = async () => { adapter.disposeCount++; throw new Error('release failed'); };
        if (scenario === 'history') driver.afterStart = async () => { throw new Error('fixture failed'); };
      }
      return driver;
    }, { scenarios: [scenario, 'identity'] });
    expect(report.cases).toEqual([
      { scenario, status: 'failed', message: 'RESOURCE_RELEASE_FAILED' },
      { scenario: 'identity', status: 'passed' },
    ]);
    expect(report.passed).toBe(false);
    expect(adapters.map(adapter => adapter.disposeCount)).toEqual([1, 1]);
    expect(adapters.map(adapter => adapter.backends.get('conformance-session')?.disposeCount)).toEqual([1, 1]);
  });
}

/** Supply a fresh adapter per case with a test-owned execution hook to control failure timing. */
function lifecycleDriver(execute: NonNullable<FakeAdapterOptions["execute"]>): () => ConformanceDriver {
  return () => ({
    adapter: createScriptedAdapter({ execute }),
    openParams: { requestId: "open", mode: "new", cwd: "/tmp", binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" } },
  });
}
