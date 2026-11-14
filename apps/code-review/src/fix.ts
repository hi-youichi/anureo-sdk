// Executes eligible fixes and reports outcomes using fix-tree's Git reconciliation.
import { HarnessSdkError, type Client } from '@anureo/sdk'
import { agent } from '@anureo/workflow'
import { reviewFailure } from './errors'
import { fixResultSchema } from './schema'
import { buildFixPrompt } from './prompts'
import type { FixReport, ModuleReview } from './results'
import { captureWorkingTreeBaseline, inspectWorkingTreeChanges, type WorkingTreeBaseline } from './fix-tree'

export type { FixReport } from './results'

/** Apply findings from complete reviews, or skip agent work for incomplete/no-finding inputs.
 * Internal entry called by createFixRunner in reviewCode's writer queue; it uses failed reports to
 * stop later writers. Resolves after agent cleanup and tree reconciliation, retaining partial edits
 * on failure. The caller owns the client, writer serialization and any subsequent verification or
 * rollback. Baseline/agent/scope failures become failed reports; observer exceptions can reject. */
export async function fixFindings(options: FixOptions): Promise<FixReport> {
  const { modules } = options
  if (modules.some(module => module.angles.some(angle => angle.status !== 'completed'))) {
    options.onProgress?.('skipped')
    return { status: 'skipped', summary: 'Fix skipped because the selected review is incomplete.', changedFiles: [], error: null }
  }
  const findings = modules.flatMap(module => module.angles.flatMap(angle => angle.status === 'completed'
    ? angle.findings.map(finding => ({ moduleId: module.module.id, angleId: angle.angle.id, ...finding })) : []))
  if (findings.length === 0) {
    options.onProgress?.('skipped')
    return { status: 'not-needed', summary: 'No findings to fix.', changedFiles: [], error: null }
  }
  const files = modules.flatMap(module => module.module.files)
  const prompt = buildFixPrompt({ sourceVersion: options.sourceVersion, findings, files })
  options.onProgress?.('started')
  return applyFix(options, prompt, files)
}

/** Inputs supplied by createFixRunner after it acquires writer and agent capacity. */
interface FixOptions {
  /** Source fingerprint embedded in the fix prompt; null outside git. */
  sourceVersion: string | null
  client: Client
  /** Canonical absolute review directory; module file paths are validated relative to it. */
  cwd: string
  /** Absolute workflow storage directory, excluded from Git change discovery. */
  directory: string
  modules: readonly ModuleReview[]
  model?: string
  /** Forwarded to session creation; omission selects the session default. */
  permissionMode?: string
  /** Invoked synchronously. 'not-needed' and 'skipped' reports both emit 'skipped'.
   * createFixRunner forwards these to reviewCode's protected progress observer. */
  onProgress?: (status: 'started' | 'completed' | 'failed' | 'skipped') => void
}

type ReconciledFix = Pick<FixReport, 'summary' | 'changedFiles'>

/** Establish the baseline before agent dispatch; setup failure leaves no usable baseline for recovery. */
async function applyFix(options: FixOptions, prompt: string, files: readonly string[]): Promise<FixReport> {
  let baseline: WorkingTreeBaseline
  try {
    baseline = await captureWorkingTreeBaseline(options.cwd, files, options.directory)
  } catch (cause) {
    return recoverFixFailure({ options, cause })
  }
  return executeFix(options, prompt, baseline)
}

/** Await agent execution/cleanup and reconcile before publishing success. Keep the reconciled
 * outcome for recovery if a terminal observer throws and a later tree read also fails. */
async function executeFix(options: FixOptions, prompt: string, baseline: WorkingTreeBaseline): Promise<FixReport> {
  let outcome: ReconciledFix | undefined
  try {
    const output = await agent(prompt, {
      client: options.client, cwd: options.cwd, model: options.model,
      // An absent permissionMode selects the session default.
      ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      schema: fixResultSchema,
    })
    if (output === null) throw new HarnessSdkError('REVIEW_AGENT_INCOMPLETE', 'Fix agent returned no result')
    outcome = await reconcileFix(baseline, output.summary)
    if (outcome.changedFiles.length === 0) {
      options.onProgress?.('skipped')
      return { status: 'skipped', ...outcome, error: null }
    }
    options.onProgress?.('completed')
    return { status: 'applied', ...outcome, error: null }
  } catch (cause) {
    return recoverFixFailure({ options, cause, baseline, outcome })
  }
}

/** Accept only observed allowed modifications, ignoring the agent's advisory changedFiles list.
 * Scope violations reject without undoing edits; executeFix routes them through failure recovery. */
async function reconcileFix(baseline: WorkingTreeBaseline, summary: string): Promise<ReconciledFix> {
  const { changedFiles, violations } = await inspectWorkingTreeChanges(baseline)
  if (violations.length > 0) {
    throw new HarnessSdkError('REVIEW_FIX_SCOPE',
      `Fix changed paths outside the selected source files; inspect the working tree and revert with git: ${violations.join(', ')}`)
  }
  return { summary, changedFiles }
}

/** Preserve the original fix failure while best-effort reconciliation reports partial allowed edits
 * and scope violations. Read failures leave earlier observations intact; this never rolls back files.
 * Emit 'failed' after reconciliation; an exception from that observer rejects instead of returning. */
async function recoverFixFailure({ options, cause, baseline, outcome }: {
  options: FixOptions
  cause: unknown
  baseline?: WorkingTreeBaseline
  outcome?: ReconciledFix
}): Promise<FixReport> {
  let error = reviewFailure(cause)
  // Report partial edits after failure, but never replace the original execution error.
  const changes = baseline ? await inspectWorkingTreeChanges(baseline).catch(() => null) : null
  if (changes && changes.violations.length > 0 && cause instanceof HarnessSdkError && cause.code !== 'REVIEW_FIX_SCOPE') {
    error = { ...error, message: `${error.message}; out-of-scope changes: ${changes.violations.join(', ')}` }
  }
  const result: FixReport = { status: 'failed', summary: outcome?.summary || 'Fix failed.',
    changedFiles: changes?.changedFiles ?? outcome?.changedFiles ?? [], error }
  options.onProgress?.('failed')
  return result
}
