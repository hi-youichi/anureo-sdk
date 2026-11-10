import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ReadabilityReport, SourceRef } from './types'

const escape = (text: string): string => text.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&')
function reference(ref: SourceRef): string {
  return `${escape(ref.path)}:${ref.startLine}–${ref.endLine} (SHA-256 ${ref.sha256})`
}

export function renderReport(report: ReadabilityReport): string {
  const lines = ['# Readability rules', '', `Generated: ${report.createdAt}`, '',
    `Coverage: ${report.coverage.reviewedFiles.length}/${report.files.length} files. Run complete: ${report.complete}.`, '',
    'Rules are source-backed agent assessments. Review applicability before adopting them.', '']
  for (const rule of report.rules) {
    lines.push(`## ${escape(rule.id)}: ${escape(rule.title)} [${rule.status}]`, '', escape(rule.guidance), '',
      `**Reading cost:** ${escape(rule.rationale)}`, '', '**Applies when:**', '',
      ...rule.appliesWhen.map(condition => `- ${escape(condition)}`), '', '**Exceptions:**', '',
      ...(rule.exceptions.length ? rule.exceptions.map(exception => `- ${escape(exception)}`) : ['- None identified; this is not proof there are none.']), '',
      `**Check method:** ${rule.checkMethod}`, '', `**Review:** ${escape(rule.explanation)}`, '', '**Evidence:**', '')
    for (const observation of report.observations.filter(value => rule.observationIds.includes(value.id))) {
      lines.push(`- ${escape(observation.id)}: ${escape(observation.obstacle)}`)
      for (const ref of observation.evidence) lines.push(`  - ${reference(ref)}`)
    }
    if (rule.counterexamples.length) lines.push('', '**Counterexamples:**', '', ...rule.counterexamples.map(ref => `- ${reference(ref)}`))
    lines.push('')
  }
  if (!report.rules.length) lines.push('No rules were produced. Consult coverage and failures before interpreting this result.', '')
  if (report.coverage.unreviewedFiles.length) lines.push('## Unreviewed files', '',
    ...report.coverage.unreviewedFiles.map(file => `- ${escape(file.path)}: ${escape(file.reason)}`), '')
  if (report.changedFiles.length) lines.push('## Changed source files', '', ...report.changedFiles.map(file => `- ${escape(file)}`), '')
  if (report.failures.length) lines.push('## Task failures', '',
    ...report.failures.map(failure => `- ${failure.phase}/${escape(failure.taskId)}: ${escape(failure.message)}`), '')
  return lines.join('\n')
}

/** Write only host-owned report artifacts. Agent tasks never write reports themselves. */
export async function writeReport(report: ReadabilityReport, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'rules.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(directory, 'rules.md'), renderReport(report))
}
