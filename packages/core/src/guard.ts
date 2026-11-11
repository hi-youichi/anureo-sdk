import { assertRequest, supportsCapability, validateJsonSchema, type AhpRequestMap, type Capabilities } from "@anureo/protocol";
import { HarnessSdkError } from "./errors";
import type { SessionMethod } from "./ports";

/** Validates a request against the session binding and advertised capabilities before dispatch. */
export function guardRequest<M extends SessionMethod>(method: M, params: AhpRequestMap[M], sessionId: string, capabilities: Capabilities): void {
  assertRequest(method, params);
  if (params.sessionId !== sessionId) throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
  function throwCapabilityUnsupported(): never {
    throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
  }
  if (method === "turn/steer" && !capabilities.input?.steer?.atomicMatch) throwCapabilityUnsupported();
  if (method === "turn/interrupt" && !capabilities.input?.interrupt?.targets.includes("turn")) throwCapabilityUnsupported();
  if (method === "session/revert" && !supportsCapability(capabilities, "session.revert", (params as AhpRequestMap["session/revert"]).scope)) throwCapabilityUnsupported();
  if (method === "history/read" && !supportsCapability(capabilities, "session.history")) throwCapabilityUnsupported();
  if ((method === "goal/set" || method === "goal/clear") && !supportsCapability(capabilities, "goal.actions", method.split("/")[1])) throwCapabilityUnsupported();
  if (method === "compact/start" && !capabilities.compact) throwCapabilityUnsupported();
  if (method === "review/start" && !capabilities.review) throwCapabilityUnsupported();
  if (method === "session/interrupt") {
    if (!capabilities.input?.interrupt?.targets.includes('session')) throwCapabilityUnsupported();
    if ((params as AhpRequestMap['session/interrupt']).cancelQueued && !capabilities.input?.interrupt?.cancelQueued) throwCapabilityUnsupported();
  }
  if (method === "input/submit") {
    const submission = params as AhpRequestMap["input/submit"];
    if (!capabilities.input?.delivery.includes(submission.delivery)) throwCapabilityUnsupported();
    if (submission.outputSchema !== undefined && !capabilities.turn?.outputSchema) throwCapabilityUnsupported();
    const modalities = capabilities.turn?.inputModalities ?? ["text"];
    if (submission.input.some((block) => !modalities.includes(block.type))) throwCapabilityUnsupported();
    if (submission.overrides && Object.keys(submission.overrides).some((key) => !capabilities.turn?.overrides?.includes(key))) throwCapabilityUnsupported();
  }
  if (method === "session/config/set") {
    const patch = (params as AhpRequestMap["session/config/set"]).patch;
    for (const [key, value] of Object.entries(patch)) {
      const option = capabilities.config?.options.find((entry) => entry.id === key && entry.scope === "session");
      if (!option) throwCapabilityUnsupported();
      if (!validateJsonSchema(option.schema, value)) throw new HarnessSdkError("INVALID_PARAMS", "Config value does not match schema");
    }
  }
}
