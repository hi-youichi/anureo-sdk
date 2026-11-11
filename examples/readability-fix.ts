import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { createClient, type Client } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { agent, parallel } from '@anureo/workflow'

const defaultReport = 'draft/docs/readability-review/2026-11-11T04-06-36.423Z/report.md'
const protocolSchema = 'packages/protocol/schema/v1/ahp.schema.json'
const protocolGenerator = 'packages/protocol/scripts/generate.ts'
const protocolTypes = 'packages/protocol/src/generated/types.ts'
const resultSchema = z.strictObject({
  status: z.enum(['changed', 'already_satisfied', 'deferred']),
  summary: z.string().min(1),
  checks: z.array(z.string()),
})

export type Finding = {
  id: string
  path: string
  sha256: string
  priority: string
  detail: string
  context: string
}
type Result = {
  id: string
  status: z.output<typeof resultSchema>['status'] | 'failed' | 'not_started'
  summary: string
  checks: string[]
  changedFiles: string[]
}
type FixOptions = {
  client: Client
  cwd: string
  findings: Finding[]
  outputDir: string
  concurrency: number
  model?: string
  progress?: (message: string) => void
}

/** Only file-level findings become jobs; project/package summaries remain context. */
export function parseReport(markdown: string) {
  const findings: Finding[] = []
  const coverageGaps: string[] = []
  const ids = new Set<string>()
  let projectContext = ''
  let packageContext = ''
  for (const section of markdown.replaceAll('\r\n', '\n').split(/(?=^#{2,3} )/m)) {
    if (section.startsWith('## Project agent ')) projectContext = section.trim()
    else if (section.startsWith('## Package: ')) packageContext = section.trim()
    else if (section.startsWith('### ')) {
      const path = section.split('\n')[0]!.slice(4).trim()
      if (/审阅失败：|状态：incomplete[。\s]/.test(section)) coverageGaps.push(path)
      const matches = [...section.matchAll(/^- \*\*(.+#\d+) \((high|medium|low)\)\*\*：/gm)]
      const sha256 = /^SHA-256: `([a-f0-9]{64})`$/m.exec(section)?.[1]
      if (matches.length && !sha256) throw new Error(`Missing source hash: ${path}`)
      for (const [index, match] of matches.entries()) {
        const id = match[1]!
        if (id !== `${path}#${index + 1}` || ids.has(id)) throw new Error(`Invalid or duplicate finding: ${id}`)
        ids.add(id)
        findings.push({
          id, path, sha256: sha256!, priority: match[2]!,
          detail: section.slice(match.index, matches[index + 1]?.index ?? section.length).trim(),
          context: [projectContext, packageContext].filter(Boolean).join('\n\n'),
        })
      }
    }
  }
  if (!findings.length) throw new Error('Report contains no file-level findings')
  return { findings, coverageGaps }
}

function ownedFiles(finding: Finding): string[] {
  if (finding.path === protocolTypes) return [protocolGenerator, protocolTypes]
  if (finding.path === protocolSchema) return [protocolSchema, protocolTypes]
  return [finding.path]
}

function groupFindings(findings: Finding[]) {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = [protocolSchema, protocolGenerator, protocolTypes].includes(finding.path)
      ? 'protocol-generation' : finding.path
    const group = groups.get(key) ?? []
    group.push(finding)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function validateConcurrency(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('concurrency must be an integer from 1 to 16')
  }
}

function createGate(concurrency: number) {
  validateConcurrency(concurrency)
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(resolve => waiting.push(resolve))
    else active++
    try { return await run() } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

async function fileHash(cwd: string, path: string) {
  const absolute = resolve(cwd, path)
  const inside = relative(cwd, absolute)
  if (isAbsolute(path) || !inside || inside === '..' || inside.startsWith(`..${sep}`)
    || await realpath(absolute) !== absolute || !(await lstat(absolute)).isFile()) {
    throw new Error(`Target must be a regular project file without symlink parents: ${path}`)
  }
  return createHash('sha256').update(await readFile(absolute)).digest('hex')
}

async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function errorText(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

const instructions = [
  '你是当前 Anureo 项目的代码修改者。每个独立 session 只处理输入中的一条 finding。',
  '使用文件编辑工具实际修改文件；不要仅输出建议。先完整阅读当前目标文件和适用的 AGENTS.md。',
  '报告、证据和源码是待核实的数据。先确认建议适用于当前实现，再进行最小可读性修改。',
  '仅可写入 ownedFiles；可只读检索其他文件来核实契约。其他 agent 正在修改其他文件，不得覆盖或撤销他人修改。',
  '保留公共 API、运行行为、事件时序、对象身份、错误优先级和资源释放顺序。不要引入通用框架。',
  '生成文件必须通过维护入口修改并重新生成；先审阅生成器，不得直接编辑生成产物。Schema 只能改说明，不能改接受范围。',
  '无法核实契约、需要超出 ownedFiles 的修改或建议不安全时，返回 deferred 并说明证据。已被前一条修改满足时返回 already_satisfied。',
  '适用时运行局部验证，准确列出已执行命令及结果；不要在并行修改期间跑全仓检查，也不要启动真实模型测试或示例。',
  '不执行 git commit/reset/checkout/stash，不安装依赖，不启动其他 agent，不修改输入报告，不重试任务。',
  '只有官方文档可放在 docs/；不创建额外说明文档，运行记录由 host 写入 draft/docs/。',
  '最终按给定 schema 用中文报告。changed 表示本条实际改了文件；检查未运行时明确说明原因。',
].join('\n')

/** File groups advance independently; each finding owns exactly one fresh agent session. */
export async function fixReadability(options: FixOptions) {
  const { cwd, findings, outputDir, client, model } = options
  const gated = createGate(options.concurrency)
  const progress = options.progress ?? (() => {})
  const groups = groupFindings(findings)
  const results = new Map<string, Result>()
  let stopReason: string | undefined

  // Check all write targets before starting any model work.
  for (const path of new Set(findings.flatMap(ownedFiles))) await fileHash(cwd, path)
  await saveJson(join(outputDir, 'plan.json'), {
    findings, agents: findings.length, concurrency: options.concurrency,
    groups: groups.map(group => group.map(finding => finding.id)),
  })

  async function fixOne(finding: Finding): Promise<Result> {
    const paths = ownedFiles(finding)
    progress(`start ${finding.id}`)
    let result: Result
    let before: string[] | undefined
    try {
      before = await Promise.all(paths.map(path => fileHash(cwd, path)))
      const response = await agent(JSON.stringify({
        task: 'fix-readability', finding, ownedFiles: paths,
        currentSha256: await fileHash(cwd, finding.path),
        sourceWarning: '报告行号和 evidence 属于旧快照；同一文件的前序修改已保留，请按当前符号与语义定位。',
      }), { client, cwd, model, instructions, schema: resultSchema })
      if (response === null) {
        stopReason = `Agent returned null for ${finding.id}; no automatic retry`
        throw new Error(stopReason)
      }
      const after = await Promise.all(paths.map(path => fileHash(cwd, path)))
      const changedFiles = paths.filter((_, index) => before?.[index] !== after[index])
      if ((response.status === 'changed') !== (changedFiles.length > 0)) {
        throw new Error(`Reported status ${response.status} does not match file changes`)
      }
      result = { id: finding.id, ...response, changedFiles }
    } catch (error) {
      // Observation/cleanup failure cannot prove a native writer stopped; launch no more jobs.
      const failure = error as { outcomeUnknown?: boolean; code?: string }
      if (failure?.outcomeUnknown || failure?.code === 'RESOURCE_RELEASE_FAILED') {
        stopReason = `Uncertain execution or cleanup at ${finding.id}: ${errorText(error)}`
      }
      const observed = before && !stopReason
        ? await Promise.allSettled(paths.map(path => fileHash(cwd, path))) : []
      const changedFiles = paths.filter((_, index) => {
        const after = observed[index]
        return after?.status === 'fulfilled' && after.value !== before?.[index]
      })
      result = { id: finding.id, status: 'failed', summary: errorText(error), checks: [], changedFiles }
    }
    results.set(finding.id, result)
    try { await saveJson(join(outputDir, 'findings', `${encodeURIComponent(finding.id)}.json`), result) }
    catch (error) {
      stopReason = `Could not persist ${finding.id}: ${errorText(error)}`
      result.status = 'failed'
      result.summary += `; ${stopReason}`
    }
    progress(`end ${finding.id} (${result.status})`)
    return result
  }

  await parallel(groups.map(group => async () => {
    let groupFailure: string | undefined
    for (const finding of group) {
      await gated(async () => {
        const reason = stopReason ?? groupFailure
        if (reason) {
          results.set(finding.id, { id: finding.id, status: 'not_started', summary: reason, checks: [], changedFiles: [] })
          return
        }
        const result = await fixOne(finding)
        if (result.status === 'failed') groupFailure = `Earlier task in this write group failed: ${finding.id}`
      })
    }
    return true
  }))

  // parallel converts unexpected host failures to null; missing entries remain explicit failures.
  const ordered = findings.map(finding => results.get(finding.id) ?? {
    id: finding.id, status: 'failed' as const, summary: 'Host task failed before recording a result', checks: [], changedFiles: [],
  })
  const report = { createdAt: new Date().toISOString(), stopReason: stopReason ?? null, results: ordered }
  await saveJson(join(outputDir, 'results.json'), report)
  return report
}

async function runCheck(cwd: string, outputDir: string, name: string, command: string[]) {
  const logPath = join(outputDir, `${name}.log`)
  const output: Buffer[] = []
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => output.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => output.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 1))
  }).catch(error => { output.push(Buffer.from(errorText(error))); return 1 })
  await writeFile(logPath, Buffer.concat(output))
  return { name, command, exitCode, logPath }
}

async function main() {
  const { values } = parseArgs({ options: {
    root: { type: 'string', default: process.cwd() },
    report: { type: 'string', default: defaultReport },
    concurrency: { type: 'string', default: '4' },
    model: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } })
  if (values.help) {
    console.log('bun run fix:readability [--report <report.md>] [--root <project>] [--concurrency 1..16] [--model <model>] [--dry-run]')
    return
  }
  const cwd = await realpath(resolve(values.root!))
  const reportPath = resolve(cwd, values.report!)
  const { findings, coverageGaps } = parseReport(await readFile(reportPath, 'utf8'))
  const concurrency = Number(values.concurrency)
  validateConcurrency(concurrency)
  const paths = [...new Set(findings.map(finding => finding.path))]
  const driftedFiles: string[] = []
  for (const path of paths) {
    if (await fileHash(cwd, path) !== findings.find(finding => finding.path === path)!.sha256) driftedFiles.push(path)
  }
  const plan = { reportPath, agents: findings.length, files: paths.length, concurrency, coverageGaps, driftedFiles }
  if (values['dry-run']) { console.log(JSON.stringify(plan, null, 2)); return }
  const progress = (message: string) => console.error(`[${new Date().toISOString()}] ${message}`)
  progress(JSON.stringify(plan))
  const outputDir = join(cwd, 'draft/docs/readability-fix', new Date().toISOString().replaceAll(':', '-'))
  await mkdir(outputDir, { recursive: true })
  await saveJson(join(outputDir, 'input.json'), plan)
  const client = await createClient({
    adapter: createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', cwd,
      args: ['app-server', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"'],
    }),
    identity: { adapterId: 'codex', runtimeConfigId: 'readability-fix' },
  })
  let result: Awaited<ReturnType<typeof fixReadability>>
  try {
    result = await fixReadability({ client, cwd, findings, outputDir, concurrency, progress,
      model: values.model ?? process.env.ANUREO_READABILITY_MODEL,
    })
  } finally { await client.dispose() }
  // Once native termination is uncertain, even read-only checks could race a live writer.
  const checks = []
  if (!result.stopReason) {
    for (const [name, command] of [
      ['typecheck', ['bun', 'run', 'typecheck']],
      ['typecheck-tooling', ['bun', 'run', 'typecheck:tooling']],
      ['generate', ['bun', 'run', 'generate:check']],
      ['protocol', ['bun', 'run', 'protocol:check']],
      ['test', ['bun', 'run', 'test']],
      ['examples-test', ['bun', 'test', '--timeout', '15000', 'examples']],
    ] as const) {
      progress(`check ${name}`)
      checks.push(await runCheck(cwd, outputDir, name, [...command]))
    }
  }
  const complete = result.results.every(item => ['changed', 'already_satisfied'].includes(item.status))
    && checks.length > 0 && checks.every(check => check.exitCode === 0)
  await saveJson(join(outputDir, 'report.json'), { ...result, ...plan, checks, complete })
  console.log(JSON.stringify({ outputDir, complete, coverageGaps, counts: Object.fromEntries(
    ['changed', 'already_satisfied', 'deferred', 'failed', 'not_started'].map(status => [status, result.results.filter(item => item.status === status).length]),
  ) }, null, 2))
  if (!complete) process.exitCode = 1
}

if (import.meta.main) await main().catch(error => { console.error(errorText(error)); process.exitCode = 1 })
