/** Maps binary versions to native request policies and initial capability advertisements. */
import type { Capabilities } from '@anureo/protocol'
import { PERMISSION_MODES } from './settings'

/**
 * Native methods and fork relations for a compatible line of Codex releases. Treat a profile
 * returned by resolveCodexProfile as read-only because sessions share its template.
 */
export type CodexProfile = {
  /** Lowest normalized binary version that uses this profile. */
  since: string
  /** Supported fork boundary relations advertised by this native line. */
  fork: Array<'before' | 'through'>
  /** Native method for a complete turn list. */
  turns: 'thread/read' | 'thread/turns/list'
  /** Revert strategy. The thread/revert profile resolves through boundaries to the next turn. */
  revert: 'thread/rollback' | 'thread/revert'
  /** Paged thread/items/list, or history rebuilt from turns. */
  history: 'thread/items/list' | 'turns'
  /** Apply settings through a native update RPC or retain them for subsequent turns. */
  settings: 'thread/settings/update' | 'per-turn'
}
/** Internal compatibility profiles in ascending order. openSession uses the oldest template for pre-profile session requests. Treat the templates as read-only. */
export const CODEX_PROFILES: [CodexProfile, ...CodexProfile[]] = [
  { since: '0.148.0', fork: ['through'], turns: 'thread/read', revert: 'thread/rollback', history: 'turns', settings: 'per-turn' },
  { since: '0.164.0', fork: ['before', 'through'], turns: 'thread/turns/list', revert: 'thread/revert', history: 'thread/items/list', settings: 'thread/settings/update' },
]
/**
 * Check which profile a binary version reaches and whether that exact version was verified against
 * a pinned schema. Use the numeric version text as input. Below-baseline versions have no profile.
 * The returned profile is a shared template and must be treated as read-only.
 */
export function resolveCodexProfile(version: string): { profile?: CodexProfile; verified: boolean } {
  const profile = [...CODEX_PROFILES].reverse().find(item => compareVersions(version, item.since) >= 0)
  return { profile, verified: profile !== undefined && VERIFIED_VERSIONS.includes(version) }
}

/**
 * Preview capabilities advertised for a numeric binary version without launching it. Versions below
 * the oldest profile get a conservative baseline. A live session can revoke optional capabilities
 * after a native method-not-found response. Copy the result before mutation because fork relations
 * share the profile template.
 */
export function codexCapabilities(version: string): Capabilities {
  const { profile } = resolveCodexProfile(version)
  // Below the oldest profile nothing is known about the native schema: publish only the safe baseline.
  if (!profile) return {
    session: { resume: false, fork: [], revert: [], history: false },
    input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
    turn: { outputSchema: false, inputModalities: ['text', 'image', 'file'], overrides: [] },
    interactions: ['approval'],
    config: { options: [] },
  }
  // CodexBackendSession.optional revokes a capability when its native method reports method-not-found.
  return {
    session: { resume: true, fork: profile.fork, revert: ['conversation'], history: true },
    input: { delivery: ['native'], steer: { target: 'turn', atomicMatch: true }, interrupt: { targets: ['turn'], reportsPendingInputs: false } },
    turn: { outputSchema: true, inputModalities: ['text', 'image', 'file'], overrides: ['model','effort','summary','approvalPolicy','sandboxPolicy','serviceTier'] },
    goal: { actions: ['set','clear'] as ['set','clear'] }, compact: true, review: true, subagents: { events: 'nested' as const },
    interactions: ['approval','userInput','elicitation','dynamicTool'],
    config: { options: [
      { id: 'permissionMode', title: 'Permissions', scope: 'session', schema: { type: 'string', enum: [...PERMISSION_MODES] } },
      ...['model','effort','summary','approvalPolicy'].map(id => ({ id, scope: 'session' as const, schema: { type: 'string' } })),
      { id: 'fastMode', title: 'Fast mode', scope: 'session' as const, schema: { type: 'boolean', default: false } },
    ] },
  }
}

/** Exact versions checked against the pinned native schema; other versions stay unverified even when a compatibility profile matches. */
const VERIFIED_VERSIONS: readonly string[] = ['0.148.0', '0.164.0']
/**
 * Compare dotted components for resolveCodexProfile, treating missing components as zero.
 * A nonnumeric component at the first differing position yields NaN, so that candidate fails the
 * minimum-version check and an older profile can still match on an earlier numeric component.
 */
function compareVersions(version: string, minimum: string): number {
  const left = version.split('.').map(Number)
  const right = minimum.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const leftPart = left[i] ?? 0
    const rightPart = right[i] ?? 0
    if (leftPart !== rightPart) return leftPart - rightPart
  }
  return 0
}
