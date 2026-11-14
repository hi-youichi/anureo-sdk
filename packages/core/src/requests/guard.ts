// Enforces request shape, binding and capability policy; must not dispatch native operations.
import { assertRequest, supportsCapability, validateJsonSchema, type AhpRequestMap, type Capabilities } from "@anureo/protocol";
import { HarnessSdkError } from "../errors";
import type { SessionMethod } from "../ports";

/**
 * Synchronously admit a typed session request in precedence order: protocol shape, session binding,
 * operation capability, submission policy, then config values. Return void on admission; propagate
 * assertRequest failures, throw SESSION_BINDING_MISMATCH for a foreign session, or throw
 * CAPABILITY_UNSUPPORTED/INVALID_PARAMS for capability/config violations. No dispatch or state change.
 * Session.submitExecution checks before allocating submission records; Session.request checks close
 * requests before shared teardown; dispatchOperation checks before replay/capacity bookkeeping. They
 * expose failures as rejected caller promises. OutputSession.execute checks transformed fallback
 * requests against native capabilities and cleans up definite submission failures before propagating
 * them (adding safe diagnostics if that cleanup also fails).
 * Callers still own lifecycle/wait admission, dispatch deduplication and resource cleanup.
 */
export function guardRequest<M extends SessionMethod>(method: M, params: AhpRequestMap[M], sessionId: string, capabilities: Capabilities): void {
  assertRequest(method, params);
  if (params.sessionId !== sessionId) throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
  if (!supportsOperation(method, params, capabilities)) throwCapabilityUnsupported();
  if (method === "input/submit") guardSubmissionCapability(params as AhpRequestMap["input/submit"], capabilities);
  if (method === "session/config/set") guardSessionConfigCapability((params as AhpRequestMap["session/config/set"]).patch, capabilities);
}

/**
 * guardRequest, guardSubmissionCapability and guardSessionConfigCapability throw through
 * this shared policy to guardRequest. Always throw a code-only SDK failure without exposing rejected
 * capability details; the calling admission path owns propagation and any prior resource cleanup.
 */
function throwCapabilityUnsupported(): never {
  throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
}

/**
 * guardRequest checks operation support after shape and binding, before submission or config policy.
 * Unrestricted methods pass. Session interruption also requires opt-in support for cancelling queued
 * inputs when the caller requests it. A false result becomes CAPABILITY_UNSUPPORTED in guardRequest.
 */
function supportsOperation<M extends SessionMethod>(method: M, params: AhpRequestMap[M], capabilities: Capabilities): boolean {
  switch (method) {
    case "turn/steer":
      return Boolean(capabilities.input?.steer?.atomicMatch);
    case "turn/interrupt":
      return capabilities.input?.interrupt?.targets.includes("turn") ?? false;
    case "session/revert":
      return supportsCapability(capabilities, "session.revert", (params as AhpRequestMap["session/revert"]).scope);
    case "history/read":
      return supportsCapability(capabilities, "session.history");
    case "goal/set":
    case "goal/clear":
      return supportsCapability(capabilities, "goal.actions", method.split("/")[1]);
    case "compact/start":
      return Boolean(capabilities.compact);
    case "review/start":
      return Boolean(capabilities.review);
    case "session/interrupt":
      return Boolean(capabilities.input?.interrupt?.targets.includes("session")
        && (!(params as AhpRequestMap["session/interrupt"]).cancelQueued || capabilities.input?.interrupt?.cancelQueued));
    default:
      return true;
  }
}

/**
 * guardRequest checks input/submit delivery, output schema, modalities and override names in that
 * order. Omitted input modalities allow text only. An unsupported option throws CAPABILITY_UNSUPPORTED.
 */
function guardSubmissionCapability(submission: AhpRequestMap["input/submit"], capabilities: Capabilities): void {
  if (!capabilities.input?.delivery.includes(submission.delivery)) throwCapabilityUnsupported();
  if (submission.outputSchema !== undefined && !capabilities.turn?.outputSchema) throwCapabilityUnsupported();
  const modalities = capabilities.turn?.inputModalities ?? ["text"];
  if (submission.input.some((block) => !modalities.includes(block.type))) throwCapabilityUnsupported();
  if (submission.overrides && Object.keys(submission.overrides).some((key) => !capabilities.turn?.overrides?.includes(key))) throwCapabilityUnsupported();
}

/**
 * guardRequest calls this last. For session/config/set, visit patch entries in property order and
 * require a session-scoped advertised option before validating its value. Throw CAPABILITY_UNSUPPORTED
 * for an unknown/non-session option or INVALID_PARAMS for a schema mismatch; the first failing entry
 * wins. Applying the validated patch remains the responsibility of the request implementation.
 */
function guardSessionConfigCapability(patch: AhpRequestMap["session/config/set"]["patch"], capabilities: Capabilities): void {
  for (const [key, value] of Object.entries(patch)) {
    const option = capabilities.config?.options.find((entry) => entry.id === key && entry.scope === "session");
    if (!option) throwCapabilityUnsupported();
    if (!validateJsonSchema(option.schema, value)) throw new HarnessSdkError("INVALID_PARAMS", "Config value does not match schema");
  }
}
