// Opt-in host policy shared by application clients that intentionally approve native requests.
import type { InteractionRequested, InteractionResponse } from '@anureo/protocol';

/**
 * Automatically answer an approval request using its narrowest advertised grant: allow once,
 * then allow for the session, then allow with a rule; ties use the first advertised option.
 * Register explicitly as ClientOptions.interactions.approval only when the host intends unattended
 * approval; the SDK never installs this policy by default. Reject with Error when no known allow
 * option exists. Session.startInteractionHandler delivers the returned answer through the registry
 * or attempts cancellation on rejection while the handler signal remains active. This policy neither
 * prompts a user nor acquires resources.
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
