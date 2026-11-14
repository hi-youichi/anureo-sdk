// Selects the Pi version profile and derives the capabilities advertised to the SDK.
import type { Capabilities } from '@anureo/protocol'
import { PERMISSION_MODES } from './mapping'

/** Exact Pi release strings verified for resume, fork and compaction. */
export const VERIFIED_PI_VERSIONS = ['1.5.2'] as const
/** Capabilities selected from a trusted Pi version, before persistence settings are applied. */
export interface PiProfile {
  /** Minimum release for this capability set; `0.0.0` denotes the baseline. */
  since: string
  /** Allows the adapter to open a previously persisted session. */
  resume: boolean
  /** Allows the adapter to branch from a verified turn boundary when persistence is enabled. */
  fork: boolean
  /** Allows the adapter to request manual compaction. */
  compact: boolean
  /** True only for an exact version in VERIFIED_PI_VERSIONS. */
  verified: boolean
}
/**
 * Select capabilities using the first numeric release triple in the trusted Pi version string.
 * Pi 1.5.2 and later major-1 releases enable resume, fork and compaction. Only exact entries in
 * VERIFIED_PI_VERSIONS are marked verified. Omission or any other version selects the baseline.
 */
export function resolvePiProfile(version?: string): PiProfile {
  if (version && supportsResumeForkAndCompaction(version)) {
    return { since: '1.5.2', resume: true, fork: true, compact: true, verified: (VERIFIED_PI_VERSIONS as readonly string[]).includes(version) }
  }
  return { since: '0.0.0', resume: false, fork: false, compact: false, verified: false }
}

/**
 * Derive the native capabilities that PiAdapter advertises during negotiation and passes to
 * PiBackendSession. Resume and fork require persistence as well as version support. The SDK
 * output wrapper can advertise structured output separately.
 */
export function capabilities(profile: PiProfile, persist: boolean): Capabilities {
  const stored = persist && profile.resume
  return {
    session: { resume: stored, fork: stored && profile.fork ? ['before', 'through'] : [], history: true },
    input: { delivery: ['native', 'afterTurn'], interrupt: { targets: ['session'], reportsPendingInputs: false } },
    turn: { outputSchema: false, overrides: [], inputModalities: ['text', 'image'] },
    ...(profile.compact ? { compact: true } : {}),
    config: { options: [
      { id: 'model', title: 'Model', scope: 'session', schema: { type: 'string', minLength: 1 } },
      { id: 'thinkingLevel', title: 'Thinking level', scope: 'session', schema: { type: 'string', enum: [...THINKING_LEVELS] } },
      { id: 'permissionMode', title: 'Permissions', scope: 'session', schema: { type: 'string', enum: [...PERMISSION_MODES], default: 'agent-full-access' } },
    ] },
  }
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Check the first numeric release triple, ignoring surrounding text and suffixes. */
function supportsResumeForkAndCompaction(version: string): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const [, major, minor, patch] = match
  const minorVersion = Number(minor)
  return Number(major) === 1 && (minorVersion > 5 || (minorVersion === 5 && Number(patch) >= 2))
}
