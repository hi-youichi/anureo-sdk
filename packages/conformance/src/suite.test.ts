import { expect, test } from "bun:test";
import { HarnessSdkError } from "@anureo/sdk";
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
      const { submissionId } = call.params;
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

test("matching execution errors cannot substitute for source loss", async () => {
  const base = createScriptedConformanceFactory();
  const report = await runConformance(async scenario => {
    const driver = await base(scenario);
    if (scenario === "backpressure") {
      const adapter = driver.adapter as ReturnType<typeof createScriptedAdapter>;
      adapter.options.execute = async call => {
        if (call.method === "input/submit") throw new HarnessSdkError("FRAME_TOO_LARGE");
        return undefined;
      };
    } else {
      driver.afterStart = async () => { throw new HarnessSdkError("CONNECTION_CLOSED"); };
    }
    return driver;
  }, { scenarios: ["backpressure", "disconnect"], timeoutMs: 50 });
  expect(report.cases).toEqual([
    { scenario: "backpressure", status: "failed", message: "Conformance timed out" },
    { scenario: "disconnect", status: "failed", message: "Conformance timed out" },
  ]);
});

test("interaction cases require the selected kind and a delivered response", async () => {
  const report = await runConformance(scenario => {
    const factory = lifecycleDriver(async (call, sink) => {
      if (call.method !== "input/submit") return undefined;
      const turnId = "interaction-turn";
      await sink.emit({ type: "turn/started", payload: { turnId } });
      await sink.requestInteraction({
        interactionId: "approval", kind: "approval", turnId, options: [{ id: "allow", label: "Allow" }],
      }, async () => {}).catch(() => {});
      await sink.emit({ type: "turn/completed", payload: { turnId, status: "completed" } });
      return { submissionId: call.params.submissionId, accepted: true, disposition: "started", turnId };
    });
    return {
      ...factory(),
      ...(scenario === "approval" ? { answer: () => { throw new Error("Fixture answer failed"); } } : {}),
    };
  }, { scenarios: ["userInput", "approval"] });
  expect(report.cases).toEqual([
    { scenario: "userInput", status: "failed", message: "Interaction not exercised" },
    { scenario: "approval", status: "failed", message: "Interaction not exercised" },
  ]);
});

test("session-only interruption works for the scripted held turn", async () => {
  const factory = createScriptedConformanceFactory({ input: { delivery: ["native"], interrupt: { targets: ["session"], reportsPendingInputs: true } } });
  const report = await runConformance(factory, { scenarios: ["interrupt"] });
  expect(report.cases).toEqual([{ scenario: "interrupt", status: "passed" }]);
});

for (const readiness of ["start event", "fixture signal"] as const) {
  test(`session-only interruption waits for a ${readiness} before association`, async () => {
    const ready = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const turnId = "delayed-admission";
    const start = { type: "turn/started", payload: { turnId } } as const;
    let admitted = false;
    const factory = lifecycleDriver(async (call, sink) => {
      if (call.method === "session/interrupt") {
        expect(admitted).toBe(true);
        interrupted.resolve();
        return { accepted: true };
      }
      if (call.method !== "input/submit") return undefined;
      await new Promise(resolve => setTimeout(resolve, 5));
      admitted = true;
      if (readiness === "start event") await sink.emit(start);
      else ready.resolve();
      await interrupted.promise;
      if (readiness === "fixture signal") await sink.emit(start);
      await sink.emit({ type: "turn/completed", payload: { turnId, status: "interrupted" } });
      return { submissionId: call.params.submissionId, accepted: true, disposition: "started", turnId };
    }, { input: { delivery: ["native"], interrupt: { targets: ["session"], reportsPendingInputs: false } } });
    const report = await runConformance(() => ({
      ...factory(),
      ...(readiness === "fixture signal" ? { waitForInterruptReady: () => ready.promise } : {}),
    }), { scenarios: ["interrupt"] });
    expect(report.cases).toEqual([{ scenario: "interrupt", status: "passed" }]);
  });
}

test("history conformance rejects a page that omits the completed turn", async () => {
  const factory = lifecycleDriver(async call => {
    if (call.method !== "history/read") return undefined;
    const entry = adapter.backends.get(call.params.sessionId)!.history[0]!;
    return { items: [{ ...entry, turnId: "unrelated-turn" }] };
  });
  const driver = factory();
  const adapter = driver.adapter as ReturnType<typeof createScriptedAdapter>;
  const report = await runConformance(() => driver, { scenarios: ["history"] });
  expect(report.cases).toEqual([{
    scenario: "history", status: "failed", message: "Completed execution identity missing from history",
  }]);
});

test("revert conformance dispatches every scope with a fresh target", async () => {
  const base = createScriptedConformanceFactory();
  const driver = await base("revert");
  const adapter = driver.adapter as ReturnType<typeof createScriptedAdapter>;
  const report = await runConformance(() => driver, { scenarios: ["revert"] });
  expect(report.cases).toEqual([{ scenario: "revert", status: "passed" }]);
  const requests = adapter.calls.flatMap(call => call.method === "session/revert" ? [call.params] : []);
  expect(requests.map(request => request.scope)).toEqual(["conversation", "files", "both"]);
  expect(new Set(requests.map(request => request.boundary.turnId)).size).toBe(3);
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
function lifecycleDriver(execute: NonNullable<FakeAdapterOptions["execute"]>, capabilities?: FakeAdapterOptions["capabilities"]): () => ConformanceDriver {
  return () => ({
    adapter: createScriptedAdapter({ execute, capabilities }),
    openParams: { requestId: "open", mode: "new", cwd: "/tmp", binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" } },
  });
}
