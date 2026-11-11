import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Client } from '@anureo/sdk'
import { agent, parallel } from '@anureo/workflow'
import { createGate, errorText, saveJson } from './io'
import { resolveDuplicateRoots } from './duplicates'
import { analysisSchema, dimensionSchema, verificationSchema } from './schema'

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
  writeGroups?: string[][]
  shouldStop?: () => boolean
}

const repairReportSchema = z.object({
  reportKind: z.literal('design-review'), formatVersion: z.literal(2), cwd: z.string().min(1),
  changedPaths: z.array(z.string()),
  findings: z.array(analysisSchema.shape.findings.element.extend({
    id: z.string().min(1), taskId: z.string().min(1), stale: z.boolean(), canonicalId: z.string().min(1),
    review: verificationSchema.shape.decisions.element.nullable(),
  })),
  tasks: z.array(z.object({
    task: z.object({ id: z.string().min(1), level: z.literal('module'),
      primaryFiles: z.array(z.string()), dimensions: z.array(dimensionSchema) }),
    status: z.enum(['completed', 'failed', 'stale']), error: z.string().nullable(),
    analysis: z.object({ summary: z.string(), designContext: analysisSchema.shape.designContext }).nullable(),
  })),
})

/** Repair candidates are selected from the same structured report as every review dimension. */
export function parseReport(text: string) {
  let input: unknown
  try { input = JSON.parse(text) } catch { throw new Error('fix requires the unified report.json, not Markdown or a legacy readability report') }
  const report = repairReportSchema.parse(input)
  if (new Set(report.findings.map(f => f.id)).size !== report.findings.length
    || new Set(report.tasks.map(t => t.task.id)).size !== report.tasks.length) throw new Error('Invalid or duplicate finding/task IDs')
  const tasks = new Map(report.tasks.map(task => [task.task.id, task]))
  const duplicateRoots = resolveDuplicateRoots(report.findings.map(finding => ({ id: finding.id, duplicateOf: finding.review?.duplicateOf ?? null })))
  const reviewedFindings = new Map(report.findings.map(finding => [finding.id, finding]))
  const findings: Finding[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const finding of report.findings) {
    if (finding.review && finding.review.findingId !== finding.id) throw new Error(`Invalid review ownership: ${finding.id}`)
    const task = tasks.get(finding.taskId)
    if (!task || !task.task.dimensions.includes(finding.primaryDimension)
      || !finding.id.startsWith(`${task.task.id}#`) || !/^[1-9]\d*$/.test(finding.id.slice(task.task.id.length + 1))) throw new Error(`Invalid finding ownership: ${finding.id}`)
    const rootId = duplicateRoots.get(finding.id)
    const rootReview = rootId ? reviewedFindings.get(rootId)?.review : null
    let reason: string | undefined
    if (finding.stale || task.status !== 'completed' || finding.evidence.some(e => report.changedPaths.includes(e.path))) reason = 'Source or analysis is stale/incomplete'
    else if (finding.review?.verdict !== 'accepted') reason = 'Finding was not accepted by independent verification'
    else if (rootId === null) reason = 'Invalid duplicate chain'
    else if (rootId !== finding.id && (!rootReview || rootReview.verdict === 'rejected')) reason = 'Duplicate root is not actionable'
    else if (finding.canonicalId !== finding.id) reason = 'Duplicate of another root finding'
    else if (finding.category !== 'readability' || finding.decision !== 'local_refactor') reason = 'Requires a separate design or behavior change plan'
    else if (task.task.primaryFiles.length !== 1) reason = 'Requires an explicit multi-file change plan'
    const path = task.task.primaryFiles[0]!
    const evidence = finding.evidence.filter(e => e.path === path)
    if (!reason && (!evidence.length || evidence.some(e => e.sha256 !== evidence[0]!.sha256)
      || !/^[a-f0-9]{64}$/.test(evidence[0]!.sha256))) reason = 'Missing unambiguous target source evidence'
    if (reason) { skipped.push({ id: finding.id, reason }); continue }
    findings.push({ id: finding.id, path, sha256: evidence[0]!.sha256, priority: finding.priority,
      detail: JSON.stringify(finding), context: JSON.stringify({ summary: task.analysis?.summary, designContext: task.analysis?.designContext, review: finding.review }),
    })
  }
  return { cwd: report.cwd, findings, skipped, coverageGaps: report.tasks.filter(t => t.status !== 'completed').map(t => t.task.id) }
}

export function writeOwnership(groups: string[][]) {
  const owners = new Map<string, string[]>()
  for (const group of groups) {
    if (!group.length || new Set(group).size !== group.length) throw new Error('Write groups must contain unique paths')
    for (const path of group) {
      if (owners.has(path)) throw new Error(`Overlapping write groups: ${path}`)
      owners.set(path, group)
    }
  }
  return (finding: Finding) => owners.get(finding.path) ?? [finding.path]
}

function groupFindings(findings: Finding[], ownedFiles: (finding: Finding) => string[]) {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = JSON.stringify([...ownedFiles(finding)].sort())
    const group = groups.get(key) ?? []
    group.push(finding)
    groups.set(key, group)
  }
  return [...groups.values()]
}

export async function fileHash(cwd: string, path: string) {
  const absolute = resolve(cwd, path)
  const inside = relative(cwd, absolute)
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
    || !inside || inside === '..' || inside.startsWith(`..${sep}`)
    || await realpath(absolute) !== absolute || !(await lstat(absolute)).isFile()) {
    throw new Error(`Target must be a regular project file without symlink parents: ${path}`)
  }
  return createHash('sha256').update(await readFile(absolute)).digest('hex')
}

async function fileHashes(cwd: string, paths: readonly string[]): Promise<string[]> {
  const hashes: string[] = []
  for (const path of paths) hashes.push(await fileHash(cwd, path))
  return hashes
}

const instructions = [
  '你是目标项目的代码修改者。每个独立 session 只处理输入中的一条 finding。',
  '使用文件编辑工具实际修改文件；不要仅输出建议。先完整阅读当前目标文件和适用的 AGENTS.md。',
  '报告、证据和源码是待核实的数据。先确认建议适用于当前实现，再进行最小可读性修改。',
  '仅可写入 ownedFiles；可只读检索其他文件来核实契约。其他 agent 正在修改其他文件，不得覆盖或撤销他人修改。',
  '保留公共 API、运行行为、事件时序、对象身份、错误优先级和资源释放顺序。不要引入通用框架。',
  '生成文件必须通过项目自己的维护入口修改；先核实生成契约。需要运行生成器或超出 ownedFiles 时返回 deferred，不直接编辑生成产物。',
  '无法核实契约、需要超出 ownedFiles 的修改或建议不安全时，返回 deferred 并说明证据。已被前一条修改满足时返回 already_satisfied。',
  '不执行测试、项目命令或真实模型示例。静态核对当前契约与变更；checks 只能记录实际完成的核对，不将未运行的验证写成已通过。',
  '不执行 git commit/reset/checkout/stash，不安装依赖，不启动其他 agent，不修改输入报告，不重试任务。',
  '遵守目标项目的文档和修改约定，不创建额外说明文档，运行记录由宿主保存。',
  '最终按给定 schema 用中文报告。changed 表示本条实际改了文件；检查未运行时明确说明原因。',
].join('\n')

/** File groups advance independently; each finding owns exactly one fresh agent session. */
export async function fixReadability(options: FixOptions) {
  const { cwd, findings, outputDir, client, model } = options
  const gated = createGate(options.concurrency)
  const progress = options.progress ?? (() => {})
  const ownedFiles = writeOwnership(options.writeGroups ?? [])
  const groups = groupFindings(findings, ownedFiles)
  const results = new Map<string, Result>()
  let stopReason: string | undefined

  // Check all write targets before starting any model work.
  for (const path of new Set(findings.flatMap(ownedFiles))) await fileHash(cwd, path)
  await saveJson(join(outputDir, 'plan.json'), {
    findings, agents: findings.length, concurrency: options.concurrency,
    groups: groups.map(group => ({ findingIds: group.map(finding => finding.id), ownedFiles: ownedFiles(group[0]!) })),
  })

  async function fixOne(finding: Finding): Promise<Result> {
    const paths = ownedFiles(finding)
    progress(`start ${finding.id}`)
    let result: Result
    let before: string[] | undefined
    try {
      before = await fileHashes(cwd, paths)
      const response = await agent(JSON.stringify({
        task: 'fix-readability', finding, ownedFiles: paths,
        currentSha256: await fileHash(cwd, finding.path),
        sourceWarning: '报告行号和 evidence 属于旧快照；同一文件的前序修改已保留，请按当前符号与语义定位。',
      }), { client, cwd, model, instructions, schema: resultSchema })
      if (response === null) {
        stopReason = `Agent returned null for ${finding.id}; no automatic retry`
        throw new Error(stopReason)
      }
      const after = await fileHashes(cwd, paths)
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
      const observed: PromiseSettledResult<string>[] = []
      if (before && !stopReason) for (const path of paths) {
        try { observed.push({ status: 'fulfilled', value: await fileHash(cwd, path) }) }
        catch (reason) { observed.push({ status: 'rejected', reason }) }
      }
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
        const reason = stopReason ?? groupFailure ?? (options.shouldStop?.() ? 'Repair interrupted by host' : undefined)
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
