import { expect, test } from "bun:test";
import { InteractionRegistry } from "./interactions";
import { approveWithNarrowestScope } from "./approval";
import { deferred } from "./deferred";
import { HarnessSdkError } from "../errors";
import type { InteractionRequested, InteractionResponse, InteractionResult } from "@anureo/protocol";

/**
 * Settlement tests use this recorder with optional publication/privacy hooks to gate or fail a phase.
 * The registry invokes publication hooks during settlement and privacy hooks before response
 * admission. Tests own gates and must settle requests or cancelAll to release expiry timers.
 */
function harness(overrides: Partial<ConstructorParameters<typeof InteractionRegistry>[1]> = {}, hooks: {
  publish?: ConstructorParameters<typeof InteractionRegistry>[0];
  beforeResponse?: ConstructorParameters<typeof InteractionRegistry>[2];
} = {}) {
  const published: InteractionResult[] = [];
  const registry = new InteractionRegistry(
    /** The registry calls this publisher before settling waiters; record attempts before the test hook. */
    async (result) => { published.push(result); await hooks.publish?.(result); },
    { maxPending: 4, timeoutMs: 60_000, responseTimeoutMs: 2_000, ...overrides },
    hooks.beforeResponse,
  );
  return { published, registry };
}
/** Settlement tests register this approval request; choosing an identity allocates no registry state. */
function approval(interactionId: string): InteractionRequested {
  return { kind: "approval", interactionId, turnId: "turn", title: "Approve?", options: [
    { id: "allow", label: "Allow", semantic: "allowOnce" }, { id: "deny", label: "Deny", semantic: "deny" },
  ] };
}
/** A valid response reused across retries so tests can distinguish request identity from payload conflicts. */
const answer: InteractionResponse = { kind: "approval", optionId: "allow" };

/** Enumeration must return detached actionable requests; successful settlement publishes and releases capacity. */
test("pending reports only actionable requests and empties after resolution", async () => {
  const { registry, published } = harness();
  const observed = registry.begin(approval("i1"), async () => {});
  expect(registry.pending().map((request) => request.interactionId)).toEqual(["i1"]);
  for (const request of registry.pending()) request.title = "Changed copy";
  expect(registry.pending()[0]?.title).toBe("Approve?");
  expect(registry.pendingCount).toBe(1);
  await expect(registry.respond("i1", "r1", answer)).resolves.toMatchObject({ outcome: "responded" });
  expect(published.at(-1)?.outcome).toBe("responded");
  expect(registry.pending()).toEqual([]);
  expect(registry.pendingCount).toBe(0);
  await expect(observed).resolves.toEqual(answer);
});

/** Let the owned expiry timer notify native and publish expired before rejecting the adapter waiter. */
test("an expired interaction cancels itself through its timer", async () => {
  const { registry, published } = harness({ timeoutMs: 15 });
  const observed = registry.begin(approval("i1"), async () => {});
  await expect(observed).rejects.toMatchObject({ code: "INTERACTION_CANCELLED" });
  expect(published.at(-1)).toMatchObject({ interactionId: "i1", outcome: "expired" });
});

/** Exceed the replay bound; admission must evict the oldest resolved identity while retaining recent retries. */
test("resolving many sequential interactions leaves no pending requests", async () => {
  const { registry } = harness({ maxPending: 1, timeoutMs: 60_000 });
  for (let index = 0; index < 1_026; index++) {
    const interactionId = `i${index}`;
    const observed = registry.begin(approval(interactionId), async () => {});
    await registry.respond(interactionId, `r${index}`, answer);
    await observed.catch(() => {});
  }
  expect(registry.pendingCount).toBe(0);
  await expect(registry.respond("i0", "r0", answer)).rejects.toMatchObject({ code: "INTERACTION_EXPIRED" });
  await expect(registry.respond("i1025", "r1025", answer)).resolves.toMatchObject({ outcome: "responded" });
  expect(() => registry.begin(approval("i1025"), async () => {})).toThrow("INTERACTION_ALREADY_EXISTS");
});

/** Peer settlement supplies no response value, so even responded rejects the local waiter without native delivery. */
test("external resolution rejects the local waiter and publishes the peer outcome", async () => {
  const { registry, published } = harness();
  const observed = registry.begin(approval("i1"), async () => {});
  await registry.resolveExternally({ interactionId: "unknown", outcome: "responded" });
  await registry.resolveExternally({ interactionId: "i1", outcome: "responded" });
  await expect(observed).rejects.toThrow("Interaction was resolved by the native peer");
  expect(published.at(-1)).toMatchObject({ interactionId: "i1", outcome: "responded" });
  expect(registry.pendingCount).toBe(0);
});

test("peer settlement supersedes an in-flight answer and retries replay the failure", async () => {
  const native = deferred<void>();
  const { registry, published } = harness();
  let deliveries = 0;
  const observed = registry.begin(approval("i1"), async () => {
    deliveries++;
    await native.promise;
  });
  const operation = registry.respond("i1", "r1", answer);
  const peerResult = { interactionId: "i1", outcome: "expired" } as const;
  try {
    await registry.resolveExternally(peerResult);
    await expect(observed).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
    expect(registry.pendingCount).toBe(0);

    native.resolve();
    await expect(operation).rejects.toMatchObject({ code: "RESULT_UNKNOWN", outcomeUnknown: true });
    const error = await operation.catch(cause => cause);
    await expect(registry.respond("i1", "r1", answer)).rejects.toBe(error);
    expect(deliveries).toBe(1);
    expect(published).toEqual([peerResult]);
  } finally {
    native.resolve();
    await operation.catch(() => {});
    await registry.cancelAll("test_cleanup");
  }
});

/** Hold native delivery to verify replay/conflict rules and capacity, then release all owned work. */
test("response retries share native delivery while settling retains capacity", async () => {
  const native = deferred<void>();
  const { registry, published } = harness({ maxPending: 1 });
  let deliveries = 0;
  const observed = registry.begin(approval("i1"), async () => { deliveries++; await native.promise; });
  const operation = registry.respond("i1", "r1", answer);
  try {
    const replay = registry.respond("i1", "r1", { ...answer });
    expect(registry.pending()).toEqual([]);
    expect(registry.pendingCount).toBe(1);
    expect(() => registry.begin(approval("i2"), async () => {})).toThrow("Pending interaction limit exceeded");
    await expect(registry.respond("i1", "r1", { kind: "approval", optionId: "deny" })).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
    await expect(registry.respond("i1", "r2", answer)).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
    native.resolve();
    const result = await operation;
    expect(await replay).toBe(result);
    expect(await registry.respond("i1", "r1", answer)).toBe(result);
    expect(await observed).toEqual(answer);
    expect(deliveries).toBe(1);
    expect(published).toEqual([{ interactionId: "i1", outcome: "responded" }]);
  } finally { native.resolve(); await operation.catch(() => {}); await registry.cancelAll("test_cleanup"); }
});

/** Validation precedes privacy registration; privacy failure leaves the request actionable for a later answer. */
test("validation and privacy checks precede admission and run again on replay", async () => {
  let checks = 0, deliveries = 0;
  let refuse = true;
  const failure = new HarnessSdkError("SECRET_PERSISTENCE_FAILED");
  const { registry } = harness({}, {
    /** respond invokes this hook for every valid attempt, even a retry that would otherwise use the cache. */
    beforeResponse: () => { checks++; if (refuse) throw failure; },
  });
  const observed = registry.begin(approval("i1"), async () => { deliveries++; });
  try {
    await expect(registry.respond("i1", "r1", { kind: "approval", optionId: "missing" })).rejects.toThrow();
    expect(checks).toBe(0);
    await expect(registry.respond("i1", "r1", answer)).rejects.toBe(failure);
    expect(registry.pending()).toHaveLength(1);
    expect(deliveries).toBe(0);
    refuse = false;
    await registry.respond("i1", "r1", answer);
    await observed;
    refuse = true;
    await expect(registry.respond("i1", "r1", answer)).rejects.toBe(failure);
    expect(checks).toBe(3);
    expect(deliveries).toBe(1);
  } finally { await registry.cancelAll("test_cleanup"); }
});

/** Gate publication after native delivery: capacity is released, but the adapter waiter must still wait. */
test("successful response publication precedes waiter settlement", async () => {
  const publishing = deferred<void>(), release = deferred<void>();
  const { registry } = harness({}, {
    /** The registry invokes publication after delivery; signal entry and hold completion for the assertion. */
    publish: async () => { publishing.resolve(); await release.promise; },
  });
  let settled = false;
  const observed = registry.begin(approval("i1"), async () => {});
  void observed.then(() => { settled = true; });
  const operation = registry.respond("i1", "r1", answer);
  try {
    await publishing.promise;
    expect(registry.pendingCount).toBe(0);
    expect(settled).toBe(false);
    release.resolve();
    await operation;
    expect(await observed).toEqual(answer);
    expect(settled).toBe(true);
  } finally { release.resolve(); await operation; }
});

/** Fail native delivery or responded publication; cache the normalized error and never send a second answer. */
for (const phase of ["delivery", "publication"] as const) test(`response ${phase} failure is cached without retrying native work`, async () => {
  let deliveries = 0;
  const { registry, published } = harness({}, {
    publish: async () => { if (phase === "publication") throw new Error("private publication detail"); },
  });
  const observed = registry.begin(approval("i1"), async () => {
    deliveries++;
    if (phase === "delivery") throw new Error("private native detail");
  });
  const operation = registry.respond("i1", "r1", answer);
  await expect(operation).rejects.toMatchObject({ code: "RESULT_UNKNOWN", outcomeUnknown: true, message: "RESULT_UNKNOWN" });
  const error = await operation.catch(cause => cause);
  await expect(observed).rejects.toBe(error);
  await expect(registry.respond("i1", "r1", answer)).rejects.toBe(error);
  expect(deliveries).toBe(1);
  expect(published).toEqual([phase === "delivery"
    ? { interactionId: "i1", outcome: "unknown", reason: "RESULT_UNKNOWN" }
    : { interactionId: "i1", outcome: "responded" }]);
});

/** Preserve the response path's distinct failure boundary: failed unknown publication never reaches waiter rejection. */
test("failed unknown publication is cached while the original waiter remains unresolved", async () => {
  const failure = new Error("publication failed");
  let deliveries = 0, settled = false;
  const { registry, published } = harness({}, { publish: async () => { throw failure; } });
  const observed = registry.begin(approval("i1"), async () => {
    deliveries++;
    throw new Error("native delivery failed");
  });
  void observed.then(() => { settled = true; }, () => { settled = true; });
  await expect(registry.respond("i1", "r1", answer)).rejects.toBe(failure);
  await expect(registry.respond("i1", "r1", answer)).rejects.toBe(failure);
  expect(settled).toBe(false);
  expect(deliveries).toBe(1);
  expect(registry.pendingCount).toBe(0);
  expect(published).toEqual([{ interactionId: "i1", outcome: "unknown", reason: "RESULT_UNKNOWN" }]);
});

/** A response deadline abandons observation, publishes unknown and preserves capacity until that deadline. */
test("response timeout is unknown and late native rejection stays observed", async () => {
  const native = deferred<void>();
  const { registry, published } = harness({ responseTimeoutMs: 10 });
  const observed = registry.begin(approval("i1"), () => native.promise);
  const operation = registry.respond("i1", "r1", answer);
  try {
    expect(registry.pendingCount).toBe(1);
    await expect(operation).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", outcomeUnknown: true });
    await expect(observed).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", outcomeUnknown: true });
    expect(published).toEqual([{ interactionId: "i1", outcome: "unknown", reason: "REQUEST_TIMEOUT" }]);
    expect(registry.pendingCount).toBe(0);
  } finally { native.reject(new Error("late native failure")); await operation.catch(() => {}); }
});

/** A default cancellation cannot interrupt delivery; teardown can end it as unknown without a second native call. */
test("teardown during response delivery publishes once and suppresses late success", async () => {
  const native = deferred<void>();
  const { registry, published } = harness();
  let deliveries = 0;
  const observed = registry.begin(approval("i1"), async () => { deliveries++; await native.promise; });
  const operation = registry.respond("i1", "r1", answer);
  try {
    await expect(registry.cancel("i1")).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
    await expect(registry.cancel("i1", "runtime_disposed")).resolves.toEqual({ interactionId: "i1", outcome: "unknown", reason: "runtime_disposed" });
    await expect(observed).rejects.toMatchObject({ code: "RESULT_UNKNOWN", outcomeUnknown: true });
    native.resolve();
    await expect(operation).rejects.toMatchObject({ code: "RESULT_UNKNOWN", outcomeUnknown: true });
    expect(deliveries).toBe(1);
    expect(published).toHaveLength(1);
  } finally { native.resolve(); await operation.catch(() => {}); await registry.cancelAll("test_cleanup"); }
});

/** Cancellation notification holds capacity and maps native failure to unknown before rejecting the waiter. */
test("cancellation retains capacity until native notification fails", async () => {
  const native = deferred<void>();
  const { registry, published } = harness({ maxPending: 1 });
  const notifications: unknown[] = [];
  const observed = registry.begin(approval("i1"), async (response, reason) => {
    notifications.push({ response, reason }); await native.promise;
  });
  const operation = registry.cancel("i1");
  try {
    expect(registry.pendingCount).toBe(1);
    expect(registry.pending()).toEqual([]);
    expect(() => registry.begin(approval("i2"), async () => {})).toThrow("Pending interaction limit exceeded");
    await expect(registry.cancel("i1")).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
    native.reject(new Error("notification failed"));
    expect(await operation).toEqual({ interactionId: "i1", outcome: "unknown", reason: "cancelled" });
    await expect(observed).rejects.toMatchObject({ code: "RESULT_UNKNOWN", outcomeUnknown: true });
    expect(notifications).toEqual([{ response: null, reason: "cancelled" }]);
    expect(published).toHaveLength(1);
    expect(registry.pendingCount).toBe(0);
  } finally { native.resolve(); await operation; }
});

/** Cancellation and peer settlement must reject the waiter after publication fails, preserving separate errors. */
for (const mode of ["cancel", "external", "settling"] as const) test(`${mode} settlement rejects the waiter only after failed publication`, async () => {
  const publishing = deferred<void>(), publication = deferred<void>(), native = deferred<void>();
  const failure = new Error("publication failed");
  const { registry } = harness({}, {
    /** Signal when the registry publishes; the test rejects this gate to exercise finally-based waiter rejection. */
    publish: async () => { publishing.resolve(); await publication.promise; },
  });
  let settled = false;
  const observed = registry.begin(approval("i1"), mode === "settling" ? () => native.promise : async () => {});
  void observed.catch(() => { settled = true; });
  const response = mode === "settling" ? registry.respond("i1", "r1", answer) : undefined;
  const operation = mode === "external"
    ? registry.resolveExternally({ interactionId: "i1", outcome: "responded" })
    : registry.cancel("i1", "runtime_disposed");
  try {
    await publishing.promise;
    expect(registry.pendingCount).toBe(0);
    expect(settled).toBe(false);
    publication.reject(failure);
    await expect(operation).rejects.toBe(failure);
    await expect(observed).rejects.toMatchObject({
      code: mode === "external" ? "INTERACTION_ALREADY_RESOLVED" : mode === "settling" ? "RESULT_UNKNOWN" : "INTERACTION_CANCELLED",
      outcomeUnknown: mode === "settling",
    });
  } finally { publication.resolve(); native.resolve(); await operation.catch(() => {}); await response?.catch(() => {}); }
});

/** A filtered teardown waits for every matching notification and suppresses publication errors without touching other turns. */
test("cancelAll filters by turn and awaits all cancellation attempts", async () => {
  const first = deferred<void>(), second = deferred<void>();
  const failure = new Error("publication failed");
  const { registry } = harness({}, { publish: async () => { throw failure; } });
  const firstWait = registry.begin(approval("i1"), () => first.promise);
  const secondWait = registry.begin(approval("i2"), () => second.promise);
  const otherWait = registry.begin({ ...approval("other"), turnId: "other" }, async () => {});
  let settled = false;
  const operation = registry.cancelAll("connection_lost", "turn").then(() => { settled = true; });
  try {
    expect(registry.pendingCount).toBe(3);
    first.resolve();
    await expect(firstWait).rejects.toMatchObject({ code: "RESULT_UNKNOWN", outcomeUnknown: true });
    expect(settled).toBe(false);
    expect(registry.pending().map(request => request.interactionId)).toEqual(["other"]);
    second.resolve();
    await operation;
    await expect(secondWait).rejects.toMatchObject({ code: "RESULT_UNKNOWN", outcomeUnknown: true });
    expect(registry.pendingCount).toBe(1);
  } finally { first.resolve(); second.resolve(); await operation; await registry.cancelAll("test_cleanup"); }
  await expect(otherWait).rejects.toMatchObject({ code: "INTERACTION_CANCELLED" });
});

/** Scope priority beats advertised order; equally scoped grants retain the peer's first choice. */
test("unattended approval selects the narrowest scope and the first matching option", async () => {
  const options: Extract<InteractionRequested, { kind: "approval" }>["options"] = [
    { id: "deny", label: "Deny", semantic: "deny" },
    { id: "rule", label: "Rule", semantic: "allowWithRule" },
    { id: "session", label: "Session", semantic: "allowSession" },
    { id: "once", label: "Once", semantic: "allowOnce" },
    { id: "once-again", label: "Once again", semantic: "allowOnce" },
  ];
  const request = { ...approval("i1"), kind: "approval" as const, options };
  expect(await approveWithNarrowestScope(request)).toEqual({ kind: "approval", optionId: "once" });
  request.options = options.slice(0, 3);
  expect(await approveWithNarrowestScope(request)).toEqual({ kind: "approval", optionId: "session" });
  request.options = options.slice(0, 2);
  expect(await approveWithNarrowestScope(request)).toEqual({ kind: "approval", optionId: "rule" });
  request.options = options.slice(0, 1);
  await expect(approveWithNarrowestScope(request)).rejects.toThrow("Approval request has no allow option");
});
