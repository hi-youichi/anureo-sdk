import { z } from 'zod'

export const dimensions = [
  ['D1', '职责与内聚', '追踪职责、读写集合与决策权，判断共同变化的规则是否归属同一所有者。'],
  ['D2', '抽象与复杂度', '检查真实概念、重复语义、无效包装与调用跳转，比较直接表达。'],
  ['D3', '接口与契约', '检查输入、输出、副作用、能力与失败承诺，以及实现和消费者是否一致。'],
  ['D4', '依赖与耦合', '区分源码依赖与运行调用，追踪真实消费者和变更传播，检查封装边界。'],
  ['D5', '数据与状态', '追踪权威状态、全部写入、快照和索引，检查非法组合、重复事实与迁移不变量。'],
  ['D6', '控制流与并发', '沿可中断、可重入或并发边界检查状态次序与原子范围，包括异步、线程、事务、消息和取消。'],
  ['D7', '错误与恢复', '区分确定失败、部分成功和结果未知，检查超时、错误投影、重试与幂等承诺。'],
  ['D8', '资源与生命周期', '追踪创建、借用、转移、登记与释放；检查失败、重复关闭和父对象长存活。'],
  ['D9', '扩展与设计模式', '还原参与者、职责和状态所有者，以真实变化场景比较直接表达与模式调整的代价。'],
  ['D10', '性能与容量', '检查复杂度、累计复制、缓存淘汰、容量单位与背压；未测量不得声称实测结果。'],
  ['D11', '可测试性与可观察性', '检查是否可控制关键输入、独立验证决策，结果和诊断是否能证明实际完成。'],
  ['D12', '可读性与组织', '沿维护任务检查命名、表达、阅读顺序、控制流、隐含副作用与代码导航；说明具体理解障碍及保留行为的整理，不按行数或模式数量机械拆分。'],
] as const

export const dimensionIds = dimensions.map(item => item[0])
export const dimensionSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
export type Dimension = z.output<typeof dimensionSchema>
export const views: Array<{ id: string; title: string; dimensions: Dimension[] }> = [
  { id: 'structure', title: '结构与契约', dimensions: ['D1', 'D2', 'D3', 'D4'] },
  { id: 'execution', title: '状态与执行', dimensions: ['D5', 'D6', 'D7', 'D8'] },
  { id: 'evolution', title: '演进与成本', dimensions: ['D9', 'D10'] },
  { id: 'understanding', title: '验证与理解', dimensions: ['D11', 'D12'] },
]

const text = z.string().min(1)
export const evidenceSchema = z.strictObject({
  path: text, snapshotId: text, sha256: text, symbol: z.string(),
  startLine: z.number().int().min(1), endLine: z.number().int().min(1), quote: text, role: text,
})
export type Evidence = z.output<typeof evidenceSchema>
const contextRequestSchema = z.strictObject({
  path: text.nullable().describe('Exact repository-relative path from catalog. Prefer explicit paths for bounded reads.'),
  symbol: text.nullable().describe('Exact indexed symbol name; searches definitions and literal candidate consumers. Null when requesting a path.'),
  query: text.nullable().describe('Literal source substring only. NOT a natural-language instruction. Ignored when path or symbol is present.'),
  reason: text,
})
const coverageSchema = z.strictObject({
  dimension: dimensionSchema, status: z.enum(['reviewed', 'not_applicable', 'incomplete']),
  reason: text, evidence: z.array(evidenceSchema),
})
const candidateSchema = z.strictObject({
  primaryDimension: dimensionSchema, relatedDimensions: z.array(dimensionSchema),
  category: z.enum(['readability', 'structural_design', 'behavioral_defect']),
  priority: z.enum(['high', 'medium', 'low']), title: text,
  decision: z.enum(['local_refactor', 'structural_refactor', 'behavior_fix']),
  collaboration: text, problem: text, cause: text, impact: text,
  contract: text, scenario: text, currentOwner: text, targetOwner: text,
  consumers: z.array(text), evidence: z.array(evidenceSchema).min(1),
  localAlternative: text, alternative: text, proposal: text, benefit: text, cost: text,
  compatibility: text, verification: text,
  pattern: z.strictObject({ decision: z.enum(['misused', 'introduce', 'simplify', 'keep']), names: z.array(text), rationale: text }).nullable(),
})
export const analysisSchema = z.strictObject({
  status: z.enum(['reviewed', 'not_applicable', 'incomplete', 'needs_context']), summary: text,
  contextRequests: z.array(contextRequestSchema), coverage: z.array(coverageSchema),
  designContext: z.array(z.strictObject({
    form: text.describe('Observed collaboration form, freely named; may combine paradigms or describe a form outside the supplied examples.'),
    participants: z.array(text).min(1).describe('Actual functions, modules, objects, data, queries, stages or messages; never require classes.'),
    collaboration: text, stateAndEffects: text, invariants: z.array(text),
    evidence: z.array(evidenceSchema).min(1), uncertainties: z.array(text),
  })),
  observations: z.array(z.strictObject({ dimensions: z.array(dimensionSchema).min(1), reason: text, evidence: z.array(evidenceSchema).min(1) })),
  findings: z.array(candidateSchema), gaps: z.array(text),
})
export type Analysis = z.output<typeof analysisSchema>
export type ContextRequest = z.output<typeof contextRequestSchema>
export type Finding = z.output<typeof candidateSchema> & { id: string; taskId: string }

export const verificationSchema = z.strictObject({
  status: z.enum(['reviewed', 'incomplete', 'needs_context']), summary: text,
  contextRequests: z.array(contextRequestSchema),
  decisions: z.array(z.strictObject({
    findingId: text, verdict: z.enum(['accepted', 'rejected', 'pending']), reason: text,
    evidence: z.array(evidenceSchema).min(1),
    improves: z.array(dimensionSchema), regresses: z.array(dimensionSchema), invariants: z.array(text),
    evidenceLevel: z.enum(['source_inference', 'contract_analysis']), duplicateOf: text.nullable(),
  })), gaps: z.array(text),
})
export type Verification = z.output<typeof verificationSchema>
export type ReviewDecision = Verification['decisions'][number]

export const summarySchema = z.strictObject({
  summary: text,
  groups: z.array(z.strictObject({
    title: text, findingIds: z.array(text).min(1), priority: z.enum(['high', 'medium', 'low']), proposal: text, tradeoffs: text,
  })), gaps: z.array(text),
})
export type DesignSummary = z.output<typeof summarySchema>

export type DesignTask = {
  id: string; unitId: string; level: 'module'; view: string; moduleId: string; angleId: string
  dimensions: Dimension[]; primaryFiles: string[]; packagePaths: string[]; purpose: string; dependsOn: string[]
}
