import type { ReviewFailure } from './errors'
import type { ModuleReview, ReviewReport } from './review'

function appendIssues(lines: string[], error: ReviewFailure): void {
  for (const issue of error.issues ?? []) {
    lines.push(`Validation issue: ${JSON.stringify(issue.path)} [${issue.code}]`)
  }
}

function appendReviews(lines: string[], modules: readonly ModuleReview[]): void {
  for (const { module, angles } of modules) {
    lines.push('', `## ${module.name} (${module.id})`)
    for (const result of angles) {
      lines.push('', `### ${result.angle.title}`)
      if (result.status === 'failed') {
        lines.push(`Review failed: ${result.error.message}${result.error.code ? ` [${result.error.code}]` : ''}`)
        appendIssues(lines, result.error)
        if (result.error.outcomeUnknown) lines.push('Agent execution outcome is unknown.')
      } else if (result.findings.length === 0) {
        lines.push('No findings.')
      } else {
        for (const finding of result.findings) {
          lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}:${finding.lineStart}-${finding.lineEnd})`, `  ${finding.body}`,
            `  Suggestion: ${finding.suggestion}`)
        }
      }
    }
  }
}

export function formatReport(report: ReviewReport): string {
  const lines = [`Code review: ${report.status}`, `Run: ${report.runId}`, `Workflow storage: ${report.workflowDirectory}`,
    `Directory: ${report.cwd}`,
    `Scope: ${report.scope.moduleIds.length} of ${report.plan.modules.length} planned modules; angles: ${report.scope.angleIds.join(', ')}`,
    '', report.plan.summary]
  appendReviews(lines, report.modules)
  if (report.fix) {
    lines.push('', `## Fix: ${report.fix.status}`, report.fix.summary)
    if (report.fix.changedFiles.length > 0) lines.push(`Changed files: ${report.fix.changedFiles.join(', ')}`)
    if (report.fix.error) {
      lines.push(`Fix failed: ${report.fix.error.message} [${report.fix.error.code ?? 'UNKNOWN'}]`)
      appendIssues(lines, report.fix.error)
    }
    if (report.fix.verification) {
      lines.push('', '## Review after fixes')
      appendReviews(lines, report.fix.verification)
    }
  }
  return `${lines.join('\n')}\n`
}
