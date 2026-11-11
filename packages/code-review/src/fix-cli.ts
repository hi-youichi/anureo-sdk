import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chooseOutput, progress, withClient, withOutputClaim } from './cli-shared'
import { fileHash, fixReadability, parseReport, writeOwnership } from './fix'
import { createGate, errorText, saveJson } from './io'
import { readDesignConfig } from './project'

const help = `Usage: anureo-review fix [project] --report <report.json> [options]

Apply accepted, fresh, file-level readability/local_refactor findings from a unified JSON report.
This command edits source files. Other findings remain recorded as skipped.

Options:
  --report <file>              Required readability report, relative to the launching directory
  --config <json>              Optional project configuration containing writeGroups
  --output <directory>         New or empty artifact directory (default: <project>/.anureo/fixes/<run>)
  --concurrency <1..16>        Shared limit for independent write groups (default: 4)
  --model <model>              Defaults to ANUREO_REVIEW_MODEL, then the backend default
  --format markdown|json       Report written to stdout (default: markdown)
  --max-output-bytes <bytes>   SDK result budget (default: 1048576)
  --dry-run                   Print findings and ownership without starting a model or editing
  --help                      Show this help

Same-file findings run sequentially. Explicit writeGroups also serialize related files.
No tests, project commands or automatic retries are run by this command.
`

export async function fixMain(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    report: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, model: { type: 'string' },
    concurrency: { type: 'string', default: '4' }, format: { type: 'string', default: 'markdown' },
    'max-output-bytes': { type: 'string', default: '1048576' },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } })
  if (values.help) { process.stdout.write(help); return }
  if (!values.report) throw new Error('fix requires --report <report.json>')
  if (positionals.length > 1) throw new Error('Provide one project directory')
  if (!['markdown', 'json'].includes(values.format!)) throw new Error('format must be markdown or json')
  const cwd = await realpath(resolve(positionals[0] ?? process.cwd()))
  const concurrency = Number(values.concurrency)
  createGate(concurrency)
  const maxOutputBytes = Number(values['max-output-bytes'])
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error('max-output-bytes must be an integer >= 1024')
  const config = values.config ? await readDesignConfig(resolve(values.config)) : undefined
  const reportPath = await realpath(resolve(values.report))
  const { cwd: reportCwd, findings, skipped, coverageGaps } = parseReport(await readFile(reportPath, 'utf8'))
  if (await realpath(reportCwd) !== cwd) throw new Error('Report belongs to a different project')
  const { outputDir } = await chooseOutput(cwd, values.output, 'fixes')
  const writeGroups = config?.writeGroups ?? []
  const ownedFiles = writeOwnership(writeGroups)
  const paths = [...new Set(findings.flatMap(ownedFiles))]
  const hashes = new Map<string, string>()
  for (const path of paths) hashes.set(path, await fileHash(cwd, path))
  const driftedFiles = [...new Set(findings.filter(f => hashes.get(f.path) !== f.sha256).map(f => f.path))]
  const plan = { cwd, reportPath, outputDir, agents: findings.length, files: paths.length, concurrency, coverageGaps, driftedFiles, writeGroups, skipped,
    findings: findings.map(finding => ({ ...finding, ownedFiles: ownedFiles(finding) })),
  }
  if (values['dry-run']) { console.log(JSON.stringify(plan, null, 2)); return }
  if (driftedFiles.length) throw new Error(`Report source changed before repair: ${driftedFiles.join(', ')}`)
  if (!findings.length) throw new Error('No eligible local readability findings; use --dry-run to inspect skipped findings')
  await withOutputClaim(outputDir, async () => {
    let result: Awaited<ReturnType<typeof fixReadability>> | undefined
    let stopped = () => false
    let failed = false
    let failure: unknown
    try {
      await withClient(cwd, maxOutputBytes, true, async (client, shouldStop) => {
        stopped = shouldStop
        result = await fixReadability({ client, cwd, findings, writeGroups, outputDir, concurrency, shouldStop, progress,
          model: values.model ?? process.env.ANUREO_REVIEW_MODEL,
        })
      })
    } catch (error) { failed = true; failure = error }
    if (!result) {
      if (failed) throw failure
      throw new Error('Repair finished without a result')
    }
    const complete = !failed && !stopped() && !result.stopReason && result.results.every(item => ['changed', 'already_satisfied'].includes(item.status))
    const report = { ...result, ...plan, complete, errors: failed ? [errorText(failure)] : [], validation: 'Static review only; no tests or project commands were run by the host.' }
    const markdown = ['# 可读性修复结果', '', `完成状态：${complete ? '选定局部建议已处理' : '本次修复未完整结束'}；跳过 ${skipped.length} 条其他发现。`,
      '仅记录源码修改与静态核对；未执行测试或项目命令。', '',
      ...result.results.flatMap(item => [`## ${item.id}`, '', `状态：${item.status}。${item.summary}`,
        `修改文件：${item.changesKnown ? item.changedFiles.join('、') || '无' : `未知；已观察到的修改：${item.changedFiles.join('、') || '未确认'}`}`, ...item.unknownFiles.map(file => `- 未观察：${file.path}。${file.error}`), ...item.checks.map(check => `- ${check}`), '']),
      '## 未进入本次修复的发现', '', ...skipped.map(item => `- ${item.id}：${item.reason}`), '',
      '## 原审查覆盖缺口', '', ...coverageGaps.map(gap => `- ${gap}`), '',
      ...report.errors.flatMap(error => ['## 运行错误', '', error, '']),
    ].join('\n')
    try {
      await saveJson(join(outputDir, 'report.json'), report)
      await writeFile(join(outputDir, 'report.md'), `${markdown}\n`)
      console.error(`Artifacts: ${outputDir}`)
      process.stdout.write(values.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${markdown}\n`)
    } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Client cleanup and report publication failed')
      throw error
    }
    if (failed) throw failure
    if (!stopped() && !complete) process.exitCode = 1
  })
}
