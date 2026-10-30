import { expect, test } from "bun:test";
import { InteractionRegistry } from "./interactions";
import type { InteractionRequested, InteractionResponse } from "@anureo/protocol";

function harness(overrides: Partial<{ maxPending: number; timeoutMs: number; responseTimeoutMs: number }> = {}) {
  const published: Array<{ interactionId: string; outcome: string; reason?: string }> = [];
  const registry = new InteractionRegistry(
    async (result) => { published.push(result as { interactionId: string; outcome: string; reason?: string }); },
    { maxPending: 4, timeoutMs: 60_000, responseTimeoutMs: 2_000, ...overrides },
  );
  return { published, registry };
}
function approval(interactionId: string): InteractionRequested {
  return { kind: "approval", interactionId, turnId: "turn", title: "Approve?", options: [
    { id: "allow", label: "Allow", semantic: "allowOnce" }, { id: "deny", label: "Deny", semantic: "deny" },
  ] };
}
const answer: InteractionResponse = { kind: "approval", optionId: "allow" };

test("pending reports only actionable requests and empties after resolution", async () => {
  const { registry, published } = harness();
  const observed = registry.begin(approval("i1"), async () => ({ interactionId: "i1", outcome: "responded" }));
  expect(registry.pending().map((request) => request.interactionId)).toEqual(["i1"]);
  expect(registry.pendingCount).toBe(1);
  await expect(registry.respond("i1", "r1", answer)).resolves.toMatchObject({ outcome: "responded" });
  expect(published.at(-1)?.outcome).toBe("responded");
  expect(registry.pending()).toEqual([]);
  expect(registry.pendingCount).toBe(0);
  await expect(observed).resolves.toEqual(answer);
});

test("an expired interaction cancels itself through its timer", async () => {
  const { registry, published } = harness({ timeoutMs: 15 });
  const observed = registry.begin(approval("i1"), async () => ({ interactionId: "i1", outcome: "responded" }));
  await expect(observed).rejects.toMatchObject({ code: "INTERACTION_CANCELLED" });
  expect(published.at(-1)).toMatchObject({ interactionId: "i1", outcome: "expired" });
});

test("resolved records are evicted only past the bounded replay guard", async () => {
  const { registry } = harness({ maxPending: 1, timeoutMs: 60_000 });
  for (let index = 0; index < 1_026; index++) {
    const interactionId = `i${index}`;
    const observed = registry.begin(approval(interactionId), async () => ({ interactionId, outcome: "responded" }));
    await registry.respond(interactionId, `r${index}`, answer);
    await observed.catch(() => {});
  }
  expect(registry.pendingCount).toBe(0);
});

test("external resolution settles waiters without a published outcome", async () => {
  const { registry, published } = harness();
  const observed = registry.begin(approval("i1"), async () => ({ interactionId: "i1", outcome: "responded" }));
  await registry.resolveExternally({ interactionId: "unknown", outcome: "responded" });
  await registry.resolveExternally({ interactionId: "i1", outcome: "responded" });
  await expect(observed).rejects.toThrow("Interaction was resolved by the native peer");
  expect(published.at(-1)).toMatchObject({ interactionId: "i1", outcome: "responded" });
  expect(registry.pendingCount).toBe(0);
});
