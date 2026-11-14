import type { ReviewFailure } from './errors'
import type { AngleReview, FixReport, ModuleReview, ReviewReport } from './results'

/** Render reviewCode's report, including failed coverage, fixes and observer errors, as text with
 * a trailing newline. CLI callers choose output streams; this formatter has no I/O or mutation. */
export function formatReport(report: ReviewReport): string {
  const lines = [`Code review: ${report.status}`, `Run: ${report.runId}`, `Workflow storage: ${report.workflowDirectory}`,
    `Directory: ${report.cwd}`,
    `Scope: ${report.scope.moduleIds.length} of ${report.plan.modules.length} planned modules; angles: ${report.scope.angleIds.join(', ')}`,
    '', report.plan.summary]
  // Each module's section carries its own review, fix, and post-fix verification.
  for (const outcome of report.modules) {
    appendModuleReview(lines, outcome.review)
    if (outcome.fix) appendFix(lines, outcome.fix)
    if (outcome.verification) {
      lines.push('', '### Review after fixes')
      appendAngleReviews(lines, outcome.verification.angles, title => `#### ${title}`)
    }
  }
  if (report.progressErrors.length > 0) {
    lines.push('', '## Progress reporting errors')
    for (const error of report.progressErrors) {
      appendFailure(lines, { error, prefix: '- ' })
    }
  }
  return `${lines.join('\n')}\n`
}

/** Append a normalized failure's diagnostic and issues to the report buffer. The section supplies
 * an uncertainty notice only when an unknown execution outcome affects review or fix interpretation. */
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

/** Render angle outcomes in report order with caller-selected heading depth, retaining failures. */
function appendAngleReviews(lines: string[], angles: readonly AngleReview[], heading: (title: string) => string): void {
  for (const result of angles) {
    lines.push('', heading(result.angle.title))
    appendAngleResult(lines, result)
  }
}

/** Render one angle's coverage independently of its heading depth; preserve multiline finding indentation. */
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
    lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}:${finding.lineStart}-${finding.lineEnd})`, `  ${indent(finding.body)}`,
      `  Suggestion: ${indent(finding.suggestion)}`)
  }
}

/** Add the module heading and original review before its fix/verification sections. */
function appendModuleReview(lines: string[], review: ModuleReview): void {
  lines.push('', `## ${review.module.name} (${review.module.id})`)
  appendAngleReviews(lines, review.angles, title => `### ${title}`)
}

/** Render host-observed edits and failure uncertainty so partial work remains visible to CLI users. */
function appendFix(lines: string[], fix: FixReport): void {
  lines.push('', `### Fix: ${fix.status}`, fix.summary)
  if (fix.changedFiles.length > 0) lines.push(`Changed files: ${fix.changedFiles.join(', ')}`)
  if (fix.error) {
    appendFailure(lines, { error: fix.error, prefix: 'Fix failed: ',
      unknownOutcomeMessage: 'Fix execution outcome is unknown; the working tree may contain partial changes.' })
  }
}
