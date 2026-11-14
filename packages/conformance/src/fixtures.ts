import type { AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap } from "@anureo/protocol";

/** Native peer protocol used to select a fixture. The JSONL runners accept Codex, ACP and AHP. */
export type WireFlavor = "codex" | "claude" | "acp" | "ahp";
/** One step in the JSONL peer script. The peer considers only the next step for each parsed message. */
export interface NativeFixtureFrame {
  /** Match this method exactly. Omit to match any parsed message, including a response without a method. */
  waitForMethod?: string;
  /**
   * Messages written in order after a match. The peer substitutes "$requestId" and
   * "$params.<key>" string values recursively, using a single top-level parameter key.
   * ACP and AHP default jsonrpc to "2.0". Codex leaves that field as authored.
   */
  emit: ReadonlyArray<Record<string, unknown>>;
  /**
   * Require an exact ID and JSON.stringify-equal result after the method filter matches.
   * A mismatch suppresses emission, stops script processing, writes FIXTURE_RESPONSE_MISMATCH
   * to stderr and sets exit code 2.
   */
  expectedResponse?: { id: string | number; result: unknown };
}
/** Describe a named native exchange and the AHP event payloads the consuming test should assert. */
export interface ConformanceFixture {
  name: string;
  flavor: WireFlavor;
  /** Ordered peer steps. For JSONL peers, point HARNESS_FIXTURE_SCRIPT at a file containing this array. */
  script: readonly NativeFixtureFrame[];
  /** Expected observations for the consuming test to compare with the adapter's emitted payloads. */
  expectedEvents: readonly AhpEventPayload[];
}
/** Pair an AHP request and expected result under their method key for a typed test fixture. */
export type MethodFixture<M extends AhpMethod> = { method: M; request: AhpRequestMap[M]; result: AhpResultMap[M] };
