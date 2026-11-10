import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { validateJsonSchema, type JsonSchema } from '@anureo/protocol'

export interface Source { file: string; hash: string; text: string }
export interface Finding {
  id: string
  symbol: string
  startLine: number
  endLine: number
  quote: string
  problem: string
  suggestion: string
  reason: string
  priority: 'high' | 'medium' | 'low'
}
export interface Draft { file: string; hash: string; reviewed: boolean; reason: string; findings: Finding[] }
export interface Decision { id: string; status: 'accepted' | 'rejected' | 'uncertain'; reason: string }
export interface Verification { file: string; hash: string; decisions: Decision[] }
export interface Analysis {
  view: string
  prompt: string
  response?: string
  draft?: Draft
  error?: string
}
export interface FileReview {
  source: Source
  analyses: Analysis[]
  candidates: Finding[]
  verification?: { prompt: string; response: string; value?: Verification }
  failure?: string
  stale?: boolean
}

const text = { type: 'string', minLength: 1 }
export const draftSchema: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['file', 'hash', 'reviewed', 'reason', 'findings'],
  properties: {
    file: text, hash: text, reviewed: { type: 'boolean' }, reason: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'symbol', 'startLine', 'endLine', 'quote', 'problem', 'suggestion', 'reason', 'priority'],
      properties: {
        id: text, symbol: text, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
        quote: text, problem: text, suggestion: text, reason: text, priority: { enum: ['high', 'medium', 'low'] },
      },
    } },
  },
}
export const verificationSchema: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['file', 'hash', 'decisions'],
  properties: {
    file: text, hash: text,
    decisions: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'status', 'reason'],
      properties: { id: text, status: { enum: ['accepted', 'rejected', 'uncertain'] }, reason: text },
    } },
  },
}

export const sourceHash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Directory discovery excludes generated/dependency/test files; explicit test paths are honored. */
export async function collectSources(cwd: string, targets: readonly string[]): Promise<Source[]> {
  const root = await realpath(cwd), files = new Set<string>()
  const excluded = new Set(['.git', '.anureo', 'node_modules', 'dist', 'artifacts', 'coverage'])
  const isCode = (file: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !/\.d\.[cm]?ts$/.test(file)
  async function visit(filename: string, explicit: boolean): Promise<void> {
    const canonical = await realpath(filename)
    const relative = path.relative(root, canonical)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`目标不在当前项目内：${filename}`)
    const info = await stat(canonical)
    if (info.isDirectory()) {
      for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (excluded.has(entry.name) || entry.isSymbolicLink()) continue
        await visit(path.join(canonical, entry.name), false)
      }
    } else if (info.isFile() && isCode(canonical) && (explicit || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(canonical))) files.add(canonical)
    else if (explicit) throw new Error(`目标不是可审查的 JS/TS 源码：${filename}`)
  }
  for (const target of targets) await visit(path.resolve(root, target), true)
  if (!files.size) throw new Error('没有找到可审查的源码')
  return await Promise.all([...files].sort().map(async filename => {
    const text = await readFile(filename, 'utf8')
    return { file: path.relative(root, filename).split(path.sep).join('/'), hash: sourceHash(text), text }
  }))
}

function decode<T>(response: string, schema: JsonSchema): T {
  let value: unknown
  try { value = JSON.parse(response) } catch { throw new Error('代理未返回纯 JSON') }
  if (!validateJsonSchema(schema, value)) throw new Error('代理结果不符合约定的 JSON 格式')
  return value as T
}
export function parseDraft(response: string, source: Source): Draft {
  const draft = decode<Draft>(response, draftSchema)
  if (draft.file !== source.file || draft.hash !== source.hash) throw new Error('审查结果的文件或源码 hash 不匹配')
  if (!draft.reviewed && (!draft.reason.trim() || draft.findings.length)) throw new Error('未完成审查必须解释原因，且不能携带审查结论')
  const ids = new Set<string>(), lines = source.text.split('\n')
  for (const finding of draft.findings) {
    if (ids.has(finding.id)) throw new Error(`重复的审查意见 ID：${finding.id}`)
    ids.add(finding.id)
    if (finding.startLine > finding.endLine || finding.endLine > lines.length) throw new Error(`行号越界：${finding.id}`)
    if (!lines.slice(finding.startLine - 1, finding.endLine).join('\n').includes(finding.quote)) throw new Error(`引用与源码不一致：${finding.id}`)
  }
  return draft
}
export function parseVerification(response: string, source: Source, candidates: readonly Finding[]): Verification {
  const result = decode<Verification>(response, verificationSchema)
  if (result.file !== source.file || result.hash !== source.hash) throw new Error('复核结果的文件或源码 hash 不匹配')
  const remaining = new Set(candidates.map(finding => finding.id))
  if (remaining.size !== candidates.length) throw new Error('候选意见 ID 重复')
  for (const decision of result.decisions) {
    if (!remaining.delete(decision.id)) throw new Error(`复核引用不存在或重复：${decision.id}`)
  }
  if (remaining.size) throw new Error(`复核遗漏意见：${[...remaining].join(', ')}`)
  return result
}

export function sourceContext(source: Source): string {
  return `文件：${source.file}\nSHA-256：${source.hash}\n以下行号前缀不是源码的一部分：\n${source.text.split('\n').map((line, index) => `${index + 1} | ${line}`).join('\n')}`
}

/** Stable text snapshots are the review inputs; changed files cannot retain accepted findings. */
export async function markStale(cwd: string, files: FileReview[]): Promise<void> {
  for (const file of files) {
    try { file.stale = sourceHash(await readFile(path.resolve(cwd, file.source.file), 'utf8')) !== file.source.hash }
    catch { file.stale = true }
  }
}

export function renderReport(files: readonly FileReview[], model: string, backend: string): string {
  const healthy = files.filter(file => !file.failure && !file.stale && file.verification?.value)
  const accepted = healthy.reduce((count, file) => count + (file.verification?.value?.decisions.filter(decision => decision.status === 'accepted').length ?? 0), 0)
  const lines = [
    '# 代码易读性审查', '', `后端：${backend}；模型：${model}。`,
    `范围：${files.length} 个文件；完成并保持源码一致：${healthy.length}；已复核建议：${accepted} 条。`,
    '仅依据输入源码快照审查；引用检查不等于建议正确性的程序化证明。未自动修改代码。', '',
  ]
  for (const file of files) {
    lines.push(`## ${file.source.file}`, '', `源码 SHA-256：\`${file.source.hash}\``, '')
    if (file.stale) { lines.push('**源码已变化，以下审查结果失效，需要重跑此文件。**', ''); continue }
    if (file.failure) { lines.push(`**审查未完成：** ${file.failure}`, ''); continue }
    if (!file.verification?.value) { lines.push('**审查未完成：** 缺少复核结果。', ''); continue }
    const decisions = file.verification.value.decisions
    if (!decisions.some(decision => decision.status === 'accepted')) lines.push('本次未形成已复核的改进建议；不代表证明该文件不存在问题。', '')
    for (const status of ['accepted', 'uncertain', 'rejected'] as const) {
      const selected = decisions.filter(decision => decision.status === status)
      if (!selected.length) continue
      lines.push(`### ${{ accepted: '已复核建议', uncertain: '待确认', rejected: '未采纳意见' }[status]}`, '')
      for (const decision of selected) {
        const finding = file.candidates.find(finding => finding.id === decision.id)!
        lines.push(`- **${{ high: '高', medium: '中', low: '低' }[finding.priority]} · ${finding.symbol} · L${finding.startLine}–L${finding.endLine}**：${finding.problem}`,
          `  - 阅读成本：${finding.reason}`, `  - 建议：${finding.suggestion}`, `  - 复核：${decision.reason}`, '')
        for (const line of finding.quote.split('\n')) lines.push(`  > ${line}`)
        lines.push('')
      }
    }
  }
  return lines.join('\n') + '\n'
}
