import type { AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap } from "@anureo/protocol";

/** Native peer protocol represented by a fixture; Claude uses an in-memory query rather than JSONL. */
export type WireFlavor = "codex" | "claude" | "acp" | "ahp";
/** One ordered JSONL script step, consumed only when the next step's method filter matches. */
export interface NativeFixtureFrame {
  /** Omit to match any parsed message, including a response without a method. */
  waitForMethod?: string;
  /**
   * Messages written in order after a match. Recursively replace "$requestId" and
   * "$params.<key>" values using the triggering message; parameter lookup is one level deep.
   * ACP/AHP messages receive a default jsonrpc field; Codex messages are written as supplied.
   */
  emit: ReadonlyArray<Record<string, unknown>>;
  /**
   * Require an exact ID and JSON.stringify-equal result before emitting. A mismatch
   * stops script processing, writes FIXTURE_RESPONSE_MISMATCH to stderr and sets exit code 2.
   */
  expectedResponse?: { id: string | number; result: unknown };
}
/** Bundle native script data with the AHP events a conformance consumer should assert. */
export interface ConformanceFixture {
  name: string;
  flavor: WireFlavor;
  /** Ordered peer steps; JSONL executables load this array alone via HARNESS_FIXTURE_SCRIPT. */
  script: readonly NativeFixtureFrame[];
  /** Expected adapter observations; the fake peer does not validate these events. */
  expectedEvents: readonly AhpEventPayload[];
}
/** Keep an AHP method's request and expected result paired under the same protocol key. */
export type MethodFixture<M extends AhpMethod> = { method: M; request: AhpRequestMap[M]; result: AhpResultMap[M] };
