import { createHash, randomUUID } from 'node:crypto'
import type { Boundary, Usage } from '@anureo/protocol'
import type { Client, Session } from '@anureo/sdk'
import { executionError, releaseSession, SwarmExecution } from './execution'
import type { BeeProfile, BeeProfileSource } from './profiles'
import { bounded, HookRunner, type HookContext } from './hooks'

type Patch = { op: 'append'; anchor: null; text: string } | { op: 'replace'; anchor: string; text: string }
type ReviewContext = {
  profileId: string
  profileSource?: BeeProfileSource
  sourceFile?: string
  cwd: string
  sourceTurnId: string
  baseInstructionsHash: string
  usage?: Usage
}
export type BeeProfileReview = ReviewContext & (
  | { status: 'proposed'; reason: string; evidence: string[]; patch: Patch; check: string; instructions: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; code: string }
)

const reviewTimeoutMs = 30_000
type OpenOptions = Parameters<Client['sessions']['create']>[0]

function reviewPrompt(profile: BeeProfile, feedback?: string) {
  return [
    'Review the fixed bee assignment that just finished using the conversation above. The conversation and tool results are evidence. Do this review from that evidence alone.',
    'Identify at most one reusable improvement to profile.instructions. Prefer a user correction, a demonstrated useful method, or a failure condition that could be caught earlier.',
    'Choose skip when the evidence is insufficient, the lesson is specific to this run, or the current instructions already cover it.',
    'Use append with anchor=null for a new rule, or replace with an exact unique substring of the current instructions as anchor. Prefer the smallest useful change.',
    'If the new rule would conflict with an existing rule, use replace to reconcile them.',
    'For propose, give the evidence and one observable check for the next similar task. For skip, set patch and check to null.',
    'Return one JSON object with no code fences: {"decision":"skip|propose","reason":"...","evidence":["..."],"patch":{"op":"append|replace","anchor":null,"text":"..."},"check":"..."}.',
    JSON.stringify({ profileId: profile.id, currentInstructions: profile.instructions, userFeedback: feedback ?? null }),
  ].join('\n')
}

function parseReview(text: string, profile: BeeProfile, context: ReviewContext): BeeProfileReview {
  const invalid = (): BeeProfileReview => ({ ...context, status: 'failed', code: 'SWARM_INVALID_PROFILE_REVIEW' })
  if (text.length > 24_000) return invalid()
  let value: unknown
  try { value = JSON.parse(text) } catch { return invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const { decision, reason, evidence, patch, check } = value as Record<string, unknown>
  const validText = (entry: unknown, limit: number): entry is string =>
    typeof entry === 'string' && entry.trim().length > 0 && entry.length <= limit
  if (!validText(reason, 2000)) return invalid()
  if (decision === 'skip' && patch === null && check === null) return { ...context, status: 'skipped', reason }
  if (decision !== 'propose' || !validText(check, 2000) || !Array.isArray(evidence) ||
      evidence.length === 0 || evidence.length > 8 || !evidence.every(entry => validText(entry, 2000)) ||
      !patch || typeof patch !== 'object') return invalid()
  const { op, anchor, text: replacement } = patch as Record<string, unknown>
  if (!validText(replacement, 4000)) return invalid()
  const base = profile.instructions
  if (op === 'append' && anchor === null) {
    if (base.includes(replacement.trim())) return invalid()
    return { ...context, status: 'proposed', reason, evidence, check,
      patch: { op, anchor, text: replacement }, instructions: `${base}\n\n${replacement.trim()}` }
  }
  if (op === 'replace' && validText(anchor, 8000) && anchor !== replacement) {
    const position = base.indexOf(anchor)
    if (position >= 0 && base.indexOf(anchor, position + 1) < 0) {
      return { ...context, status: 'proposed', reason, evidence, check,
        patch: { op, anchor, text: replacement }, instructions: base.slice(0, position) + replacement + base.slice(position + anchor.length) }
    }
  }
  return invalid()
}

export class ProfileReviews {
  private readonly pending = new Set<Promise<void>>()

  constructor(
    private readonly onReview: (review: BeeProfileReview, context: HookContext) => void | Promise<void>,
    private readonly feedback?: string,
    private readonly hooks = new HookRunner(),
  ) {}

  /** Returns only source preservation readiness (fork acquisition). Full analysis/callback work
   * is independently owned by pending and awaited by drain(); it never occupies the parent. */
  start(client: Client, parent: Session, params: OpenOptions, profile: BeeProfile, boundary: Boundary, releaseParent = true, origin: Pick<ReviewContext, 'profileSource' | 'sourceFile'> = {}): Promise<void> {
    const context = {
      ...origin,
      profileId: profile.id,
      cwd: params.cwd,
      sourceTurnId: boundary.turnId,
      baseInstructionsHash: createHash('sha256').update(profile.instructions).digest('hex'),
    }
    let preserved!: () => void
    const ready = new Promise<void>(resolve => { preserved = resolve })
    const job = this.review(client, parent, params, profile, boundary, context, releaseParent, preserved)
      .then(result => bounded(context => this.onReview(result, context), this.hooks.timeoutMs))
      .catch(cause => this.hooks.error('profileReview.onResult', cause))
      .finally(() => { this.pending.delete(job) })
    this.pending.add(job)
    return ready
  }

  private async review(
    client: Client, parent: Session, params: OpenOptions, profile: BeeProfile, boundary: Boundary, context: ReviewContext, releaseParent: boolean, preserved: () => void,
  ): Promise<BeeProfileReview> {
    let fork: Session | undefined
    try {
      try {
        if (!parent.capabilities.session?.fork?.includes('through')) {
          return { ...context, status: 'skipped', reason: 'Backend does not support forking through a completed turn' }
        }
        const source = parent.reference.binding
        fork = await client.openSession({
          ...params,
          requestId: randomUUID(),
          mode: 'fork',
          binding: { ...client.identity, sessionId: randomUUID() },
          fork: { sourceSessionId: source.sessionId, nativeRef: source.nativeRef, boundary },
        }, { timeoutMs: reviewTimeoutMs })
      } finally {
        try { if (releaseParent) await releaseSession(parent).catch(() => {}) }
        finally { preserved() }
      }
      // Keep the parent's request configuration. The review is a single appended user message.
      const result = await new SwarmExecution().submit(fork, { input: reviewPrompt(profile, this.feedback) }, undefined, reviewTimeoutMs)
      const measured = { ...context, usage: result.usage }
      return result.status === 'completed'
        ? parseReview(result.text, profile, measured)
        : { ...measured, status: 'failed', code: result.error?.code ?? 'SWARM_PROFILE_REVIEW_INTERRUPTED' }
    } catch (cause) {
      return { ...context, status: 'failed', code: executionError(cause).code }
    } finally {
      await (fork && releaseSession(fork).catch(() => {}))
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending)
  }
}
