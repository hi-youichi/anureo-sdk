import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient, type Client } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { agent, parallel, pipeline, type AgentOptions } from '@anureo/workflow'
import {
  collectSources, draftSchema, verificationSchema, parseDraft, parseVerification,
  sourceContext, markStale, renderReport, type Source, type Analysis, type FileReview,
} from './readability-review-support'

const instructions = `你是代码易读性审查者。只分析提示中提供的源码快照，不调用工具、不执行命令、不修改文件。
用中文给出具体阅读障碍及其改进理由。不要按行数强制拆函数，不为使用设计模式而增加抽象，允许零条意见。
不把命名偏好当作问题；不要将功能缺陷检查替代易读性审查。缺少调用方上下文时明确不确定。
只输出符合指定 JSON Schema 的 JSON，不能加 Markdown 围栏。quote 必须逐字引用，不含行号前缀。`
const views = [
  { id: 'naming', title: '命名与职责', focus: '名称是否表达数据、职责和失败政策；抽象及模块跳转是否帮助理解。' },
  { id: 'flow', title: '控制流与状态', focus: '控制流、await 前后的状态变化、资源所有权和错误处理是否需要反复推断。' },
] as const

export async function reviewReadability(
  client: Client,
  sources: readonly Source[],
  options: { cwd: string; model?: string; progress?: (message: string) => void },
) {
  const agentOptions: AgentOptions = { client, cwd: options.cwd, model: options.model, instructions }
  const progress = options.progress ?? (() => {})
  const probe = sources[0]
  if (!probe) throw new Error('没有可审查的源码')

  // Probe the actual response contracts through the chosen backend before fan-out.
  progress('检查真实后端的 JSON 响应格式（2 次调用）')
  const draftPrompt = `这是格式预检，不是审查任务。按此 Schema 返回 file/hash 与下文相同、reviewed=false、reason="格式预检"、findings=[] 的 JSON：\n${JSON.stringify(draftSchema)}\n${sourceContext(probe)}`
  const draftResponse = await agent(draftPrompt, agentOptions)
  parseDraft(draftResponse, probe)
  const verificationPrompt = `这是格式预检。按此 Schema 返回 file/hash 与下文相同、decisions=[] 的 JSON：\n${JSON.stringify(verificationSchema)}\n${sourceContext(probe)}`
  const verificationResponse = await agent(verificationPrompt, agentOptions)
  parseVerification(verificationResponse, probe, [])

  const files: FileReview[] = await pipeline(
    sources,
    async source => {
      // Each source owns one file job; the two analyses are separate perspectives, not double coverage.
      const analyses = await parallel(views.map(view => async (): Promise<Analysis> => {
        const prompt = `逐函数审查完整文件，视角：${view.title}。${view.focus}
每条意见必须说明具体阅读成本与收益；不要要求每个函数都修改。只引用本文件内的证据。
如果能够审查此文件，reviewed=true；不能完成则 reviewed=false 并说明 reason，不能伪装成零问题。
JSON Schema：${JSON.stringify(draftSchema)}\n${sourceContext(source)}`
        progress(`${source.file}：${view.title}开始`)
        let response: string | undefined
        try {
          response = await agent(prompt, agentOptions)
          const draft = parseDraft(response, source)
          if (!draft.reviewed) throw new Error(draft.reason)
          progress(`${source.file}：${view.title}完成，${draft.findings.length} 条候选`)
          return { view: view.id, prompt, response, draft }
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause)
          progress(`${source.file}：${view.title}失败：${error}`)
          return { view: view.id, prompt, response, error }
        }
      }))
      const candidates = analyses.flatMap(analysis => (analysis.draft?.findings ?? []).map(finding => ({ ...finding, id: `${analysis.view}:${finding.id}` })))
      const failures = analyses.filter(analysis => analysis.error).map(analysis => `${analysis.view}: ${analysis.error}`)
      return { source, analyses, candidates, ...(failures.length ? { failure: failures.join('；') } : {}) } satisfies FileReview
    },
    async (file): Promise<FileReview> => {
      if (file.failure) return file
      progress(`${file.source.file}：独立复核开始`)
      const prompt = `独立复核候选意见，重新阅读源码，判断是否有具体阅读障碍、建议是否保持原有行为、是否只是风格偏好。
accepted=建议有依据且值得采纳；rejected=无依据、错误、纯偏好或重复；uncertain=需要未提供的上下文。
每个候选 ID 恰好决定一次，不得新增意见。不能将引用匹配直接当作结论正确的证明。
JSON Schema：${JSON.stringify(verificationSchema)}\n${sourceContext(file.source)}
候选意见：${JSON.stringify(file.candidates)}`
      let response = ''
      try {
        response = await agent(prompt, agentOptions)
        const value = parseVerification(response, file.source, file.candidates)
        progress(`${file.source.file}：复核完成，${value.decisions.filter(decision => decision.status === 'accepted').length} 条采纳`)
        return { ...file, verification: { prompt, response, value } }
      } catch (cause) {
        const failure = cause instanceof Error ? cause.message : String(cause)
        progress(`${file.source.file}：复核失败：${failure}`)
        return { ...file, failure, verification: { prompt, response } }
      }
    },
  )
  await markStale(options.cwd, files)
  return { preflight: { draftPrompt, draftResponse, verificationPrompt, verificationResponse }, files }
}

async function main() {
  const targets = process.argv.slice(2)
  if (targets.includes('--help')) {
    console.log('用法：bun run example:readability [源码文件或目录 ...]\n默认：三个 workflow 原语实现。目录自动排除测试和生成目录，显式测试文件仍可审查。\n需要已登录的本地 Codex；CODEX_BIN 可指定程序，ANUREO_READABILITY_MODEL 可选模型。\n中文 Markdown 写入 stdout，进度写入 stderr。ANUREO_READABILITY_TRACE 可指定请求/响应 JSON 文件。\n每文件 3 次真实调用，另有 2 次格式预检；源码完整输入，不做截断。')
    return
  }
  const cwd = process.cwd(), model = process.env.ANUREO_READABILITY_MODEL
  const sources = await collectSources(cwd, targets.length ? targets : [
    'packages/workflow/src/agent.ts', 'packages/workflow/src/parallel.ts', 'packages/workflow/src/pipeline.ts',
  ])
  console.error(`审查 ${sources.length} 个文件，预计 ${sources.length * 3 + 2} 次真实代理调用`)
  const client = await createClient({
    adapter: createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', timeoutMs: 60_000 }),
    identity: { adapterId: 'codex', runtimeConfigId: 'readability-example' },
  })
  try {
    const result = await reviewReadability(client, sources, { cwd, model, progress: message => console.error(message) })
    if (process.env.ANUREO_READABILITY_TRACE) {
      const filename = path.resolve(process.env.ANUREO_READABILITY_TRACE)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(filename, JSON.stringify({ backend: 'codex', model: model ?? 'CLI default', ...result }, null, 2) + '\n')
    }
    process.stdout.write(renderReport(result.files, model ?? 'CLI 默认模型', '真实 Codex'))
    if (result.files.some(file => file.failure || file.stale)) process.exitCode = 1
  } finally {
    await client.dispose()
  }
}

if (import.meta.main) {
  await main().catch(cause => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
}
