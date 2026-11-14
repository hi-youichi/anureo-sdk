import type { ReviewFailure } from './errors'
import type { AngleReview, FixReport, ModuleOutcome, ReviewReport } from './results'

/** Render a ReviewReport as text with a trailing newline. Sections follow the report's module and
 * angle order and retain failed coverage, fix outcomes and observer errors. The caller owns output.
 * The CLI's reviewAndPrintReport writes this text to stdout when JSON output is disabled. */
export function formatReport(report: ReviewReport): string {
  const lines = [
    `Code review: ${report.status}`,
    `Run: ${report.runId}`,
    `Workflow storage: ${report.workflowDirectory}`,
    `Directory: ${report.cwd}`,
    `Scope: ${report.scope.moduleIds.length} of ${report.plan.modules.length} planned modules; angles: ${report.scope.angleIds.join(', ')}`,
    '', report.plan.summary,
  ]
  for (const outcome of report.modules) {
    appendModuleOutcome(lines, outcome)
  }
  if (report.progressErrors.length > 0) {
    lines.push('', '## Progress reporting errors')
    for (const error of report.progressErrors) {
      appendFailure(lines, { error, prefix: '- ' })
    }
  }
  return `${lines.join('\n')}\n`
}

/** Keep the original review, fix and final verification together under the module heading. */
function appendModuleOutcome(lines: string[], outcome: ModuleOutcome): void {
  const { review } = outcome
  lines.push('', `## ${review.module.name} (${review.module.id})`)
  appendAngleReviews(lines, review.angles, '###')
  if (outcome.fix) appendFix(lines, outcome.fix)
  if (outcome.verification) {
    lines.push('', '### Review after fixes')
    appendAngleReviews(lines, outcome.verification.angles, '####')
  }
}

/** Render angle outcomes in report order with caller-selected heading depth, retaining failures. */
function appendAngleReviews(lines: string[], angles: readonly AngleReview[], headingPrefix: string): void {
  for (const result of angles) {
    lines.push('', `${headingPrefix} ${result.angle.title}`)
    appendAngleResult(lines, result)
  }
}

/** Distinguish failed coverage from a completed angle with no findings. Indent continuation
 * lines so multiline finding bodies and suggestions stay under their finding. */
function appendAngleResult(lines: string[], result: AngleReview): void {
  if (result.status === 'failed') {
    appendFailure(lines, { error: result.error, prefix: 'Review failed: ',
      unknownOutcomeMessage: 'Agent execution outcome is unknown.' })
    return
  }
  if (result.findings.length === 0) {
    lines.push('No findings.')
    return
  }
  const indent = (text: string) => text.replace(/\n/g, '\n  ')
  for (const finding of result.findings) {
    lines.push(
      `- [${finding.severity}] ${finding.title} (${finding.file}:${finding.lineStart}-${finding.lineEnd})`,
      `  ${indent(finding.body)}`,
      `  Suggestion: ${indent(finding.suggestion)}`,
    )
  }
}

/** Show recorded edits even if a later failure made the fix incomplete. */
function appendFix(lines: string[], fix: FixReport): void {
  lines.push('', `### Fix: ${fix.status}`, fix.summary)
  if (fix.changedFiles.length > 0) lines.push(`Changed files: ${fix.changedFiles.join(', ')}`)
  if (fix.error) {
    appendFailure(lines, { error: fix.error, prefix: 'Fix failed: ',
      unknownOutcomeMessage: 'The backend could not confirm the fix agent outcome.' })
  }
}

/** Append a failure's message, optional code and validation issues in that order. Review and fix
 * sections supply their own uncertainty notices. The progress section leaves the notice unset. */
function appendFailure(lines: string[], input: {
  error: ReviewFailure
  prefix: string
  unknownOutcomeMessage?: string
}): void {
  const { error, prefix, unknownOutcomeMessage } = input
  lines.push(`${prefix}${error.message}${error.code ? ` [${error.code}]` : ''}`)
  for (const issue of error.issues ?? []) {
    lines.push(`Validation issue: ${JSON.stringify(issue.path)} [${issue.code}]`)
  }
  if (error.outcomeUnknown && unknownOutcomeMessage) lines.push(unknownOutcomeMessage)
}
