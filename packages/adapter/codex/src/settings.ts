/** Owns Codex permission and service-tier policy; it must not dispatch requests or mutate sessions. */
import type { JsonObject } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'

/** Host-facing permission vocabulary shared by capability advertisement and request translation; consumers must not mutate it. */
export const PERMISSION_MODES = ['read-only', 'agent', 'agent-full-access'] as const
/**
 * For thread/turn/settings request builders, translate a host permission mode into fresh native approval
 * and sandbox settings without I/O. Undefined stays absent; every other unsupported value throws
 * INVALID_PARAMS. Both sandbox forms are returned because thread creation and turn/settings requests
 * use different native fields.
 */
export function permissionSettings(value: unknown): { approvalPolicy: string; sandbox: string; sandboxPolicy: JsonObject } | undefined {
  if (value === undefined) return undefined
  switch (value) {
    case 'read-only': return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
    case 'agent': return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }
    case 'agent-full-access': return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    default: throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported Codex permission mode')
  }
}

/**
 * For native request builders, return the priority tier only for true and null otherwise so disabling
 * fast mode restores the thread default. No I/O or errors. CodexBackendSession.setConfig validates
 * booleans before translating; threadOptions and startInput decide whether to omit an absent option.
 */
export const serviceTierFor = (fast: unknown) => fast === true ? FAST_TIER : null

/** Anureo's fastMode boolean maps to Codex's priority service tier; standard speed is the thread default (null). */
const FAST_TIER = 'priority'
