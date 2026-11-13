/** Owns version profiles and advertised capabilities; it must not probe binaries or mutate live support. */
import type { Capabilities } from '@anureo/protocol'
import { PERMISSION_MODES } from './settings'

/**
 * Native method policy consumed by adapter initialization and session request builders, without I/O.
 * A version uses the newest profile whose `since` it reaches so patch and newer releases keep working.
 * Profile selection and exact-schema verification are separate; consumers must not mutate templates.
 */
export type CodexProfile = {
  /** Lowest normalized binary version that uses this profile. */
  since: string
  /** Supported fork boundary relations advertised by this native line. */
  fork: Array<'before' | 'through'>
  /** thread/read (0.148) or thread/turns/list (0.164+) for full turn snapshots. */
  turns: 'thread/read' | 'thread/turns/list'
  /** thread/rollback(numTurns) or thread/revert(beforeTurnId). */
  revert: 'thread/rollback' | 'thread/revert'
  /** Paged thread/items/list, or history rebuilt from turns. */
  history: 'thread/items/list' | 'turns'
  /** Live session settings: thread/settings/update, or per-turn overrides applied to the next turn. */
  settings: 'thread/settings/update' | 'per-turn'
}
/** Ascending native compatibility profiles shared by capability selection and session fallback; callers must not mutate these templates. */
export const CODEX_PROFILES: CodexProfile[] = [
  { since: '0.148.0', fork: ['through'], turns: 'thread/read', revert: 'thread/rollback', history: 'turns', settings: 'per-turn' },
  { since: '0.164.0', fork: ['before', 'through'], turns: 'thread/turns/list', revert: 'thread/revert', history: 'thread/items/list', settings: 'thread/settings/update' },
]
/** Exact versions checked against the pinned native schema; other versions stay unverified even when a compatibility profile matches. */
const VERIFIED_VERSIONS: readonly string[] = ['0.148.0', '0.164.0']
/**
 * For profile selection, compare dotted numeric components with absent components treated as zero;
 * return a signed ordering or NaN without I/O or validation. Unmatched probe text deliberately follows
 * JavaScript's numeric/NaN comparison behavior to retain the existing profile fallback.
 */
const compareVersions = (a: string, b: string) => {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const leftPart = left[i] ?? 0
    const rightPart = right[i] ?? 0
    if (leftPart !== rightPart) return leftPart - rightPart
  }
  return 0
}
/**
 * For adapter/session initialization and capability advertisement, return the newest compatible profile
 * and exact-schema verification flag. Versions below the baseline have no profile; unmatched probe text
 * retains numeric comparison fallback. No I/O or validation errors; returned templates must not be mutated.
 */
export function resolveCodexProfile(version: string): { profile?: CodexProfile; verified: boolean } {
  const profile = [...CODEX_PROFILES].reverse().find(item => compareVersions(version, item.since) >= 0)
  return { profile, verified: profile !== undefined && VERIFIED_VERSIONS.includes(version) }
}

/**
 * For initialization and session opening, return advertised capabilities for a binary version, with a
 * conservative baseline when no profile matches. No I/O or validation errors; session owners must clone
 * the result before mutation because fork relations share the profile template.
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
  // The baseline and the optional native methods are open for any profiled version. A method the
  // runtime rejects as method-not-found is closed by CodexBackendSession.optional at call time, not by version number.
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
