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
  guardOperationCapability(method, params, capabilities);
  guardSubmissionCapability(method, params, capabilities);
  guardSessionConfigCapability(method, params, capabilities);
}

/**
 * guardOperationCapability, guardSubmissionCapability and guardSessionConfigCapability throw through
 * this shared policy to guardRequest. Always throw a code-only SDK failure without exposing rejected
 * capability details; the calling admission path owns propagation and any prior resource cleanup.
 */
function throwCapabilityUnsupported(): never {
  throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
}

/**
 * guardRequest calls this after shape/binding checks and before submission/config policy. Return void
 * for supported or unrestricted methods; throw CAPABILITY_UNSUPPORTED for missing method support,
 * including session interruption's optional queued-work cancellation. Never dispatch or mutate state.
 */
function guardOperationCapability<M extends SessionMethod>(method: M, params: AhpRequestMap[M], capabilities: Capabilities): void {
  switch (method) {
    case "turn/steer":
      if (!capabilities.input?.steer?.atomicMatch) throwCapabilityUnsupported();
      return;
    case "turn/interrupt":
      if (!capabilities.input?.interrupt?.targets.includes("turn")) throwCapabilityUnsupported();
      return;
    case "session/revert":
      if (!supportsCapability(capabilities, "session.revert", (params as AhpRequestMap["session/revert"]).scope)) throwCapabilityUnsupported();
      return;
    case "history/read":
      if (!supportsCapability(capabilities, "session.history")) throwCapabilityUnsupported();
      return;
    case "goal/set":
    case "goal/clear":
      if (!supportsCapability(capabilities, "goal.actions", method.split("/")[1])) throwCapabilityUnsupported();
      return;
    case "compact/start":
      if (!capabilities.compact) throwCapabilityUnsupported();
      return;
    case "review/start":
      if (!capabilities.review) throwCapabilityUnsupported();
      return;
    case "session/interrupt":
      if (!capabilities.input?.interrupt?.targets.includes("session")) throwCapabilityUnsupported();
      if ((params as AhpRequestMap["session/interrupt"]).cancelQueued && !capabilities.input?.interrupt?.cancelQueued) throwCapabilityUnsupported();
      return;
  }
}

/**
 * guardRequest calls this after operation policy. For input/submit, check delivery, output schema,
 * modalities (defaulting to text) and override names in that order; other methods need no check here.
 * Return void or throw CAPABILITY_UNSUPPORTED before dispatch, without changing params or capabilities.
 */
function guardSubmissionCapability<M extends SessionMethod>(method: M, params: AhpRequestMap[M], capabilities: Capabilities): void {
  if (method !== "input/submit") return;
  const submission = params as AhpRequestMap["input/submit"];
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
 * wins. Return void for valid patches/other methods, without applying config or dispatching work.
 */
function guardSessionConfigCapability<M extends SessionMethod>(method: M, params: AhpRequestMap[M], capabilities: Capabilities): void {
  if (method !== "session/config/set") return;
  const patch = (params as AhpRequestMap["session/config/set"]).patch;
  for (const [key, value] of Object.entries(patch)) {
    const option = capabilities.config?.options.find((entry) => entry.id === key && entry.scope === "session");
    if (!option) throwCapabilityUnsupported();
    if (!validateJsonSchema(option.schema, value)) throw new HarnessSdkError("INVALID_PARAMS", "Config value does not match schema");
  }
}
