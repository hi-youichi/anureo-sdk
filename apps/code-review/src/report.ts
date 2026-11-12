import type { ReviewFailure } from './errors'
import type { FixReport } from './fix'
import type { AngleReview, ModuleReview, ReviewReport } from './review'

function appendIssues(lines: string[], error: ReviewFailure): void {
  for (const issue of error.issues ?? []) {
    lines.push(`Validation issue: ${JSON.stringify(issue.path)} [${issue.code}]`)
  }
}

function appendAngleReviews(lines: string[], angles: readonly AngleReview[], heading: (title: string) => string): void {
  for (const result of angles) {
    lines.push('', heading(result.angle.title))
    if (result.status === 'failed') {
      lines.push(`Review failed: ${result.error.message}${result.error.code ? ` [${result.error.code}]` : ''}`)
      appendIssues(lines, result.error)
      if (result.error.outcomeUnknown) lines.push('Agent execution outcome is unknown.')
    } else if (result.findings.length === 0) {
      lines.push('No findings.')
    } else {
      const indent = (text: string) => text.replace(/\n/g, '\n  ')
      for (const finding of result.findings) {
        lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}:${finding.lineStart}-${finding.lineEnd})`, `  ${indent(finding.body)}`,
          `  Suggestion: ${indent(finding.suggestion)}`)
      }
    }
  }
}

function appendModuleReview(lines: string[], review: ModuleReview): void {
  lines.push('', `## ${review.module.name} (${review.module.id})`)
  appendAngleReviews(lines, review.angles, title => `### ${title}`)
}

function appendFix(lines: string[], fix: FixReport): void {
  lines.push('', `### Fix: ${fix.status}`, fix.summary)
  if (fix.changedFiles.length > 0) lines.push(`Changed files: ${fix.changedFiles.join(', ')}`)
  if (fix.error) {
    lines.push(`Fix failed: ${fix.error.message}${fix.error.code ? ` [${fix.error.code}]` : ''}`)
    appendIssues(lines, fix.error)
    if (fix.error.outcomeUnknown) lines.push('Fix execution outcome is unknown; the working tree may contain partial changes.')
  }
}

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
      lines.push(`- ${error.message}${error.code ? ` [${error.code}]` : ''}`)
      appendIssues(lines, error)
    }
  }
  return `${lines.join('\n')}\n`
}
