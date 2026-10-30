import type { AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap } from "@anureo/protocol";

export type WireFlavor = "codex" | "claude" | "acp" | "ahp";
export interface NativeFixtureFrame {
  waitForMethod?: string;
  emit: ReadonlyArray<Record<string, unknown>>;
  expectedResponse?: { id: string | number; result: unknown };
}
export interface ConformanceFixture {
  name: string;
  flavor: WireFlavor;
  script: readonly NativeFixtureFrame[];
  expectedEvents: readonly AhpEventPayload[];
}
export type MethodFixture<M extends AhpMethod> = { method: M; request: AhpRequestMap[M]; result: AhpResultMap[M] };
