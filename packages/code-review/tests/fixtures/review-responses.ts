import type { Analysis, DesignTask, Evidence, Finding } from '../../src/schema'
import { dimensions } from '../../src/schema'

export type Source = { id: string; path: string; sha256: string; kind: string; source: string }
export type Request = {
  task: string; primaryFiles?: string[]; kind?: string; id?: string; assignment?: DesignTask; round?: number
  sources?: Source[]; findings?: Finding[]; candidates?: Finding[]; knownFindings?: Finding[]
  dependencies?: Array<{ status: string }>
  contextResolution?: { candidates: string[] }
  validationFeedback?: Array<{ path: string; message: string }>
  previous?: unknown
  previousResponse?: unknown
}
export function evidence(source: Source): Evidence {
  return { path: source.path, snapshotId: source.id, sha256: source.sha256, symbol: '',
    startLine: 1, endLine: 1, quote: source.source.split('\n')[0]!.replace(/^1: /, ''), role: '原始实现' }
}
export function candidate(dimension: DesignTask['dimensions'][number], sources: Source[]): Analysis['findings'][number] {
  return {
    primaryDimension: dimension, relatedDimensions: [], category: 'structural_design', priority: 'medium',
    title: '状态归属重复', decision: 'structural_refactor', collaboration: '入口与消费者共同维护同一事实。',
    problem: '规则分散。', cause: '状态写入分属两个所有者。', impact: '增加状态时需要同步修改两个实现。',
    contract: '一个事实有一个权威所有者。', scenario: '新增一个阶段时必须修改两处。', currentOwner: 'a 与 b', targetOwner: 'a',
    consumers: ['b'], evidence: sources.filter(s => s.kind === 'text').map(evidence),
    localAlternative: '保持当前结构，集中一处写入。', alternative: '调整状态归属。', proposal: '消费者读取权威状态。',
    benefit: '减少重复决策。', cost: '调用方需要传入权威状态。', compatibility: '保留公开接口。', verification: '验证增加状态只修改一个所有者。', pattern: null,
  }
}
export function defaultOutput(input: Request): unknown {
  if (input.task === 'design-planning') {
    const sources = input.sources!.filter(s => input.primaryFiles!.includes(s.path))
    return { status: 'planned', summary: '按源码职责分为两个模块，按项目选择两个角度。',
      modules: sources.map((source, i) => ({ id: `m${i}`, name: source.path, purpose: '独立源码职责', paths: [source.path], evidence: [evidence(source)] })),
      angles: [{ id: 'D3', title: '契约', question: '输入输出与承诺一致吗？', reason: '公开函数边界' },
        { id: 'D12', title: '可读性', question: '能否直接理解意图？', reason: '代码表达' }],
      referenceCoverage: dimensions.map(d => ({ id: d[0], decision: ['D3', 'D12'].includes(d[0]) ? 'included' : 'not_applicable', angleIds: ['D3', 'D12'].includes(d[0]) ? [d[0]] : [], reason: 'Fixture applicability only' })),
      reviewedFiles: sources.map(s => s.path), excludedFiles: [], contextRequests: [], gaps: [] }
  }
  if (input.task === 'design-preflight') {
    if (input.kind === 'analysis') return { status: 'incomplete', summary: '预检', contextRequests: [], coverage: [], designContext: [], observations: [], findings: [], gaps: [] }
    if (input.kind === 'verification') return { status: 'incomplete', summary: '预检', contextRequests: [], decisions: [], gaps: [] }
    return { summary: '预检', groups: [], gaps: [] }
  }
  if (input.task === 'design-analysis') {
    const text = input.sources!.filter(s => s.kind === 'text')
    return { status: text.length ? 'reviewed' : 'not_applicable', summary: '实际源码已审查，零候选。', contextRequests: [],
      designContext: text.length ? [{ form: '直接模块协作', participants: text.map(s => s.path), collaboration: '按给定源代码表达转换与依赖。', stateAndEffects: '仅对本次源码中的可见读写作判断。', invariants: ['输入输出以源码为边界'], evidence: [evidence(text[0]!)], uncertainties: ['运行时行为未执行'] }] : [],
      coverage: input.assignment!.dimensions.map(dimension => ({ dimension, status: text.length ? 'reviewed' : 'not_applicable',
        reason: text.length ? '已检查源码。' : '非文本资产。', evidence: text.length ? [evidence(text[0]!)] : [] })),
      observations: [], findings: [], gaps: [] }
  }
  if (input.task === 'design-verification') return { status: 'reviewed', summary: '独立源码复核完成。', contextRequests: [],
    decisions: input.findings!.map(f => ({ findingId: f.id, verdict: 'accepted', reason: '源码和消费者支持责任调整。',
      evidence: f.evidence, improves: [f.primaryDimension], regresses: [], invariants: ['保留公开契约'], evidenceLevel: 'contract_analysis', duplicateOf: null })), gaps: [] }
  if (input.task === 'design-summary') return { summary: '汇总已复核结论。', groups: input.candidates!.length ? [{
    title: '集中权威状态', findingIds: input.candidates!.map(f => f.id), priority: 'medium', proposal: '按已复核方案实施。', tradeoffs: '保留后端差异。',
  }] : [], gaps: [] }
  throw new Error(`Unexpected task: ${input.task}`)
}
