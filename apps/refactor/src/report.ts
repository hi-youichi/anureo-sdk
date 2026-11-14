// Renders host-observed reports as text; it must not run refactors or persist their state.
import { join } from 'node:path'
import type { RefactorReport, StepResult } from './results'

/** Render a structured run as newline-terminated text for CLI/library presentation.
 * executeRefactor prints this result for text-mode CLI runs; library consumers may format a report
 * returned by refactorCode. Preserves design-before-module order and includes check statuses and
 * observer errors, but omits check output and raw failure codes. Supply a valid host record;
 * formatting it has no expected errors, I/O or mutation. */
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

/** Append one step's host facts to formatReport's buffer in presentation order, returning void.
 * Mutates only the buffer; valid step records have no expected errors. Unknown outcomes remain
 * explicit because a failure message alone cannot establish whether edits ran. */
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
