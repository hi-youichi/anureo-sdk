// Opt-in host policy shared by application clients that intentionally approve native requests.
import type { InteractionRequested, InteractionResponse } from '@anureo/protocol';

/**
 * Select an advertised grant for unattended approval. Prefer allow-once, then session, then
 * rule grants. When several options have the same scope, return the first advertised option.
 * Reject with Error when the request offers none of these grants.
 *
 * Opt in through ClientOptions.interactions.approval, as createReviewClient and
 * createRefactorClient do. The returned promise completes when the answer is selected.
 * Session.startInteractionHandler invokes the registered policy and awaits native delivery
 * separately. If selection rejects while the signal is active, Session attempts cancellation.
 */
export async function approveWithNarrowestScope(
  request: Extract<InteractionRequested, { kind: 'approval' }>,
): Promise<Extract<InteractionResponse, { kind: 'approval' }>> {
  const allow = request.options.find(option => option.semantic === 'allowOnce')
    ?? request.options.find(option => option.semantic === 'allowSession')
    ?? request.options.find(option => option.semantic === 'allowWithRule')
  if (!allow) throw new Error('Approval request has no allow option')
  return { kind: 'approval', optionId: allow.id }
}
