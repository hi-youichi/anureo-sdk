import { assertRequest, supportsCapability, validateJsonSchema, type AhpRequestMap, type Capabilities } from "@anureo/protocol";
import { HarnessSdkError } from "./errors";
import type { SessionMethod } from "./ports";

/** Validates a request against the session binding and advertised capabilities before dispatch. */
export function guardRequest<M extends SessionMethod>(method: M, params: AhpRequestMap[M], sessionId: string, capabilities: Capabilities): void {
  assertRequest(method, params);
  if (params.sessionId !== sessionId) throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
  const unsupported = () => { throw new HarnessSdkError("CAPABILITY_UNSUPPORTED"); };
  if (method === "turn/steer" && !capabilities.input?.steer?.atomicMatch) unsupported();
  if (method === "turn/interrupt" && !capabilities.input?.interrupt?.targets.includes("turn")) unsupported();
  if (method === "session/revert" && !supportsCapability(capabilities, "session.revert", (params as AhpRequestMap["session/revert"]).scope)) unsupported();
  if (method === "history/read" && !supportsCapability(capabilities, "session.history")) unsupported();
  if ((method === "goal/set" || method === "goal/clear") && !supportsCapability(capabilities, "goal.actions", method.split("/")[1])) unsupported();
  if (method === "compact/start" && !capabilities.compact) unsupported();
  if (method === "review/start" && !capabilities.review) unsupported();
  if (method === "session/interrupt") {
    if (!capabilities.input?.interrupt?.targets.includes('session')) unsupported();
    if ((params as AhpRequestMap['session/interrupt']).cancelQueued && !capabilities.input?.interrupt?.cancelQueued) unsupported();
  }
  if (method === "input/submit") {
    if (!capabilities.input?.delivery.includes((params as AhpRequestMap['input/submit']).delivery)) unsupported();
    const start = params as AhpRequestMap["input/submit"];
    if (start.outputSchema !== undefined && !capabilities.turn?.outputSchema) unsupported();
    const modalities = capabilities.turn?.inputModalities ?? ["text"];
    if (start.input.some((block) => !modalities.includes(block.type))) unsupported();
    if (start.overrides && Object.keys(start.overrides).some((key) => !capabilities.turn?.overrides?.includes(key))) unsupported();
  }
  if (method === "session/config/set") {
    const patch = (params as AhpRequestMap["session/config/set"]).patch;
    for (const [key, value] of Object.entries(patch)) {
      const option = capabilities.config?.options.find((entry) => entry.id === key && entry.scope === "session");
      if (!option) unsupported();
      if (option && !validateJsonSchema(option.schema, value)) throw new HarnessSdkError("INVALID_PARAMS", "Config value does not match schema");
    }
  }
}
