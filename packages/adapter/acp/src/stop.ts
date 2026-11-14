import type { TurnCompletedEvent } from '@anureo/protocol';

/** Status published in the AHP turn/completed payload. */
export type TurnStatus = TurnCompletedEvent['payload']['status'];

/** Internal prompt outcome with the terminal turn status and any preceding warning. */
export interface StopOutcome {
  status: TurnStatus;
  notice?: { code: string; message: string };
}

/**
 * Classify a prompt stop reason for AcpBackendSession.submitStandardInput, which publishes any
 * warning before turn/completed. A lookup miss or non-string value yields a failed outcome
 * with ACP_STOP_UNKNOWN.
 * Treat returned table entries as read-only because later prompts reuse them.
 */
export function stopOutcome(stopReason: unknown): StopOutcome {
  const key = typeof stopReason === 'string' ? stopReason : '';
  return STOP_REASONS[key] ?? {
    status: 'failed',
    notice: { code: 'ACP_STOP_UNKNOWN', message: 'Backend stopped for an unclassified reason' },
  };
}

/**
 * AHP has no truncated status. Limits complete the turn with a warning so observers
 * can distinguish a response that hit a limit from an ordinary end_turn.
 */
const STOP_REASONS: Readonly<Record<string, StopOutcome>> = {
  end_turn: { status: 'completed' },
  max_tokens: {
    status: 'completed',
    notice: { code: 'ACP_STOP_MAX_TOKENS', message: 'Turn ended at the model output limit; the reply may be truncated' },
  },
  max_turn_requests: {
    status: 'completed',
    notice: { code: 'ACP_STOP_MAX_TURN_REQUESTS', message: 'Turn ended at the agent turn limit' },
  },
  cancelled: { status: 'interrupted' },
  refusal: { status: 'failed' },
};
