import { join } from 'node:path'
import type { Failure, RefactorReport, StepResult } from './results'

/** Render a report from refactorCode as newline-terminated text, the format executeRefactor
 * prints in CLI text mode. Design appears before module results in plan order. The text includes
 * check statuses and observer errors. For check output and raw failure codes, read the report
 * fields directly. Formatting a valid report performs no I/O or mutation. */
export function formatReport(report: RefactorReport): string {
  const lines = [
    `Refactor: ${report.status}${report.reviewOnly ? ' (review only)' : ''}`,
    `Directory: ${field(report.cwd)}`,
    `Report: ${field(join(report.directory, 'report.json'))}`,
  ]
  if (report.design) {
    lines.push('', 'Cross-module design')
    appendStep(lines, report.design)
  }
  for (const graph of report.graphCoverage ?? []) {
    const missing = graph.filesWithoutSymbols
    lines.push('', `Graph (${field(graph.phase)}): ${graph.status}${graph.error ? ` — ${field(graph.error)}` : ''}`)
    if (missing.length) lines.push(`Files without indexed symbols: ${missing.map(field).join(', ')}`)
  }
  lines.push('', field(report.plan?.summary ?? 'Module planning did not complete.'))
  for (const item of report.modules) {
    lines.push('', `${field(item.module.id)}: ${field(item.module.name)}`)
    if (item.step) appendStep(lines, item.step)
  }
  for (const error of report.errors) lines.push('', `Error: ${field(error)}`)
  appendFailure(lines, report.failure)
  for (const error of report.progressErrors) lines.push('', `Progress reporting error: ${field(error)}`)
  return `${lines.join('\n')}\n`
}

/** Append a design or module result to formatReport's text buffer. */
function appendStep(lines: string[], step: StepResult): void {
  lines.push(`Result: ${step.status}. ${field(step.error ?? step.summary)}`)
  appendFailure(lines, step.failure)
  for (const change of step.changes) lines.push(`- ${field(change)}`)
  if (step.changedFiles.length) lines.push(`Files changed in the agent worktree: ${step.changedFiles.map(field).join(', ')}`)
  if (step.status === 'failed' && step.patch) lines.push(`Patch: ${field(step.patch)}`)
  for (const item of step.deferred) lines.push(`Deferred ${field(item.title)}: ${field(item.reason)}`)
  for (const check of step.checks) lines.push(`Check ${check.status}: ${field(check.command)}`)
  if (step.status === 'applied' && !step.checks.length) lines.push('No validation commands ran; runtime behavior was not tested.')
}

function appendFailure(lines: string[], failure: Failure | null | undefined): void {
  if (failure?.outcomeUnknown) {
    lines.push('Agent execution outcome is unknown. Inspect source and backend execution before starting another run.')
  }
  for (const { path, code } of failure?.issues ?? []) {
    const location = typeof path === 'string' ? path : JSON.stringify(path)
    lines.push(`Validation issue: ${field(location || '(root)')} [${field(code)}]`)
  }
}

/** Keep controls and embedded line breaks inside their text field. */
function field(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, char =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
}
