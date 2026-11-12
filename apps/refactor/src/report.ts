import type { RefactorReport, StepResult } from './refactor'

function appendStep(lines: string[], step: StepResult): void {
  lines.push(`Result: ${step.status}. ${step.error ?? step.summary}`)
  if (step.failure?.outcomeUnknown) lines.push('Agent execution outcome is unknown; inspect source and backend execution before starting another run.')
  for (const change of step.changes) lines.push(`- ${change}`)
  if (step.changedFiles.length) lines.push(`Changed files: ${step.changedFiles.join(', ')}`)
  for (const item of step.deferred) lines.push(`Deferred ${item.title}: ${item.reason}`)
  for (const check of step.checks) lines.push(`Check ${check.status}: ${check.command}`)
  if (step.status === 'applied' && !step.checks.length) lines.push('No validation commands ran; runtime behavior was not tested.')
}

export function formatReport(report: RefactorReport): string {
  const lines = [
    `Refactor: ${report.status}${report.reviewOnly ? ' (read-only prompt)' : ''}`,
    `Directory: ${report.cwd}`,
    `Report: ${report.directory}/report.json`,
  ]
  if (report.design) { lines.push('', 'Cross-module design'); appendStep(lines, report.design) }
  lines.push('', report.plan?.summary ?? 'Module planning did not complete.')
  for (const item of report.modules) {
    lines.push('', `${item.module.id}: ${item.module.name}`)
    if (item.step) appendStep(lines, item.step)
  }
  for (const error of report.errors) lines.push('', `Error: ${error}`)
  for (const error of report.progressErrors) lines.push('', `Progress reporting error: ${error}`)
  return `${lines.join('\n')}\n`
}
