/** AHP turn status. Mirrors the `turn/completed` payload union. */
export type TurnStatus = 'completed' | 'interrupted' | 'failed';

export interface StopOutcome {
  status: TurnStatus;
  notice?: { code: string; message: string };
}

/**
 * ACP v1 stop reasons → AHP turn status.
 *
 * `max_tokens` and `max_turn_requests` are terminal success with a caveat: AHP has
 * no truncated status, so the turn completes and a notice carries the caveat rather
 * than misreporting in either direction. Unknown reasons fail closed — a backend
 * that stops for a reason we cannot classify must not be reported as clean success.
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

export function stopOutcome(stopReason: unknown): StopOutcome {
  const key = typeof stopReason === 'string' ? stopReason : '';
  return STOP_REASONS[key] ?? {
    status: 'failed',
    notice: { code: 'ACP_STOP_UNKNOWN', message: 'Backend stopped for an unclassified reason' },
  };
}
