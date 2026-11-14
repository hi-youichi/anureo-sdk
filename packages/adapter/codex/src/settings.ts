/** Translates SDK configuration values into Codex request settings. */
import type { JsonObject } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'

/** Permission modes advertised by codexCapabilities and recognized by CodexBackendSession.threadOptions. Treat the list as read-only. */
export const PERMISSION_MODES = ['read-only', 'agent', 'agent-full-access'] as const
/**
 * Translate a configured mode before native dispatch. threadOptions uses the string sandbox, while
 * startInput and setConfig use the fresh sandbox policy object. Omitted mode returns undefined.
 * Unsupported values throw INVALID_PARAMS before the caller dispatches its thread, turn or settings request.
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
 * Translate true to priority and other values to null, the native instruction to use the thread
 * default. threadOptions and startInput omit the field when fastMode is absent. setConfig checks
 * the patch is boolean before translating a provided value.
 */
export const serviceTierFor = (fast: unknown): 'priority' | null => fast === true ? 'priority' : null
