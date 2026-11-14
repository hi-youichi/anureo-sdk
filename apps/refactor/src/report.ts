import { join } from 'node:path'
import type { RefactorReport, StepResult } from './results'

/** Render a report from refactorCode as newline-terminated text, the format executeRefactor
 * prints in CLI text mode. Design appears before module results in plan order. The text includes
 * check statuses and observer errors. For check output and raw failure codes, read the report
 * fields directly. Formatting a valid report performs no I/O or mutation. */
export function formatReport(report: RefactorReport): string {
  const lines = [
    `Refactor: ${report.status}${report.reviewOnly ? ' (review only)' : ''}`,
    `Directory: ${report.cwd}`,
    `Report: ${join(report.directory, 'report.json')}`,
  ]
  if (report.design) {
    lines.push('', 'Cross-module design')
    appendStep(lines, report.design)
  }
  for (const graph of report.graphCoverage ?? []) {
    const missing = graph.filesWithoutSymbols
    lines.push('', `Graph (${graph.phase}): ${graph.status}${graph.error ? ` — ${graph.error}` : ''}`)
    if (missing.length) lines.push(`Files without indexed symbols: ${missing.join(', ')}`)
  }
  lines.push('', report.plan?.summary ?? 'Module planning did not complete.')
  for (const item of report.modules) {
    lines.push('', `${item.module.id}: ${item.module.name}`)
    if (item.step) appendStep(lines, item.step)
  }
  for (const error of report.errors) lines.push('', `Error: ${error}`)
  for (const error of report.progressErrors) lines.push('', `Progress reporting error: ${error}`)
  return `${lines.join('\n')}\n`
}

/** Append a design or module result to formatReport's text buffer. Call out execution uncertainty
 * explicitly because the error text alone cannot tell a reader whether edits ran. */
function appendStep(lines: string[], step: StepResult): void {
  lines.push(`Result: ${step.status}. ${step.error ?? step.summary}`)
  if (step.failure?.outcomeUnknown) lines.push('Agent execution outcome is unknown; inspect source and backend execution before starting another run.')
  for (const change of step.changes) lines.push(`- ${change}`)
  if (step.changedFiles.length) lines.push(`Changed files: ${step.changedFiles.join(', ')}`)
  if (step.status === 'failed' && step.patch) lines.push(`Patch: ${step.patch}`)
  for (const item of step.deferred) lines.push(`Deferred ${item.title}: ${item.reason}`)
  for (const check of step.checks) lines.push(`Check ${check.status}: ${check.command}`)
  if (step.status === 'applied' && !step.checks.length) lines.push('No validation commands ran; runtime behavior was not tested.')
}
