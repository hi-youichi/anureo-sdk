import type { ReviewReport } from './review'

export function formatReport(report: ReviewReport): string {
  const lines = [`Code review: ${report.status}`, `Run: ${report.runId}`, `Workflow storage: ${report.workflowDirectory}`,
    `Directory: ${report.cwd}`,
    `Scope: ${report.scope.moduleIds.length} of ${report.plan.modules.length} planned modules; angles: ${report.scope.angleIds.join(', ')}`,
    '', report.plan.summary]
  for (const { module, angles } of report.modules) {
    lines.push('', `## ${module.name} (${module.id})`)
    for (const result of angles) {
      lines.push('', `### ${result.angle.title}`)
      if (result.status === 'failed') {
        lines.push(`Review failed: ${result.error.message}${result.error.code ? ` [${result.error.code}]` : ''}`)
        if (result.error.outcomeUnknown) lines.push('Agent execution outcome is unknown.')
      } else if (result.findings.length === 0) {
        lines.push('No findings.')
      } else {
        for (const finding of result.findings) {
          lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}:${finding.lineStart}-${finding.lineEnd})`, `  ${finding.body}`)
        }
      }
    }
  }
  return `${lines.join('\n')}\n`
}
