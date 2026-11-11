import type { DesignReport } from './review'

export function renderDesignReport(report: DesignReport): string {
  const planned = report.plan.discovery.status === 'planned'
  const planning = report.plan.planning
  const lines = [
    '# 多维度代码设计审查', '', '<!-- reportKind: design-review; formatVersion: 2 -->', '',
    `完成状态：${report.complete ? '完整' : '存在覆盖缺口'}。完成仅表示审查范围与证据流程完整，不表示没有设计缺陷。`, '',
    `选定输入文件 ${report.plan.primaryFiles.length}，上下文清单 ${report.plan.inventoryFiles.length}。`,
    planned ? `本次审查维度：${report.plan.selectedDimensions.join('、')}。未选维度不计入本次覆盖。` : '规划尚未通过宿主校验；模块、角度与任务覆盖尚未建立。',
    planned ? `模块：${report.coverage.modules.reviewed} 已审／${report.coverage.modules.notApplicable} 不适用／${report.coverage.modules.incomplete} 未完成。每个模块与角度由独立任务负责。` : '分析、复核与汇总未启动；零发现不表示没有设计缺陷。',
    `本次模型调用 ${report.calls.actual}，复用任务 ${report.calls.reusedTasks}。`, '',
    ...(planned ? [`原始候选 ${report.findingCounts.candidates}，采纳 ${report.findingCounts.accepted}，待验证 ${report.findingCounts.pending}，驳回 ${report.findingCounts.rejected}，未复核 ${report.findingCounts.unverified}；有效根因去重后 ${report.findingCounts.uniqueActionable}。`, ''] : []),
    '## 首个 agent 的模块与角度规划', '',
    `规划状态：${report.plan.discovery.status}。${report.plan.discovery.summary}`, '',
    `已解析导航 ${report.plan.navigation.filter(n => n.adapter !== 'text-v1').length} 个文本文件；原文导航 ${report.plan.navigation.filter(n => n.adapter === 'text-v1').length} 个。原文导航仍支持完整源码、逐字检索和行号证据；空符号和调用表表示未索引。`, '',
  ]
  for (const attempt of planning.attempts) lines.push(`- 规划响应 ${attempt.callId}：${attempt.outcome}；校验问题 ${attempt.validationIssues.length} 项。原始提议及快照归属：${attempt.artifact}`)
  if (!planned && planning.proposedPlan) {
    lines.push('', '### 未接受的最新规划提议', '', '以下内容仅供诊断，未通过宿主校验，不计入审查覆盖。', '')
    for (const module of planning.proposedPlan.modules) lines.push(`- 提议模块 ${module.id}：${module.name}。${module.purpose}`, `  文件：${module.paths.join('、')}`)
    for (const angle of planning.proposedPlan.angles) lines.push(`- 提议角度 ${angle.id}：${angle.title}。${angle.question}`)
    for (const issue of planning.validationIssues) lines.push(`- 校验错误 ${issue.path}：${issue.message}`)
    lines.push('')
  }
  for (const module of report.plan.modules) lines.push(`- 模块 ${module.id}：${module.name}。${module.purpose}`, `  源码：${module.paths.join('、')}`, '')
  for (const angle of report.plan.angles) lines.push(`- 角度 ${angle.id}（${report.plan.selectedDimensions.includes(angle.id) ? '本次选中' : '未选，不计入覆盖'}）：${angle.title}。${angle.question}`, `  规划依据：${angle.reason}`, '')
  for (const reference of report.plan.referenceCoverage) lines.push(`- 参考角度 ${reference.id}：${reference.decision} → ${reference.angleIds.join('、') || '不适用'}。${reference.reason}`)
  for (const file of report.plan.discovery.excludedFiles) lines.push(`- 非文本输入排除：${file.path}。${file.reason}`)
  lines.push('', '## 系统责任与整体取舍', '')
  if (report.changedPaths.length) lines.push('源码基线已变化；以下结论属于已保存的历史快照，须重新审查后再规划修复。', '')
  for (const summary of report.summaries) {
    lines.push(`### ${summary.id}`, '', summary.value?.summary ?? `汇总失败：${summary.error}`, '')
    for (const group of summary.value?.groups ?? []) lines.push(
      `- **${group.priority}: ${group.title}**`, `  ${group.proposal}`, `  权衡：${group.tradeoffs}`,
      `  来源：${group.findingIds.map(id => `\`${id}\``).join('、')}`, '',
    )
    for (const gap of summary.value?.gaps ?? []) lines.push(`- 覆盖缺口：${gap}`)
    lines.push('')
  }
  lines.push('## 分维度结论', '')
  for (const [id, title] of report.plan.dimensions) {
    const c = report.coverage.dimensions.find(c => c.dimension === id)!
    lines.push(`### ${id} ${title}`, '',
      `已审 ${c.reviewed}，不适用 ${c.notApplicable}，未完成 ${c.incomplete}；适用项完成率：${c.completionRate === null ? '不适用' : `${(c.completionRate * 100).toFixed(1)}%`}。`, '')
    const findings = report.findings.filter(f => f.primaryDimension === id)
    if (!findings.length) lines.push('本维度没有候选发现；具体覆盖与保持现状的依据见下方任务观察。', '')
    for (const f of findings) {
      lines.push(`#### ${f.id}`, '', `**${f.priority} · ${f.category} · ${f.review?.verdict ?? '未复核'}${f.stale ? ' · 源码过期' : ''}**：${f.title}`, '',
        `设计决策：${f.decision}；关联维度：${f.relatedDimensions.join('、') || '无'}。`,
        `当前协作：${f.collaboration}`, `问题：${f.problem}`, `原因：${f.cause}`, `影响：${f.impact}`,
        `契约或不变量：${f.contract}`, `变化场景／触发／负载：${f.scenario}`,
        `责任：${f.currentOwner} → ${f.targetOwner}`, `消费者：${f.consumers.join('、') || '未建立真实消费者证据'}`,
        `局部方案：${f.localAlternative}`, `替代方案：${f.alternative}`, `推荐：${f.proposal}`, `收益：${f.benefit}`,
        `代价：${f.cost}`, `兼容性：${f.compatibility}`, `验证方法（不代表已执行）：${f.verification}`, '',
      )
      if (f.pattern) lines.push(`模式专题：${f.pattern.decision} · ${f.pattern.names.join('、')}。${f.pattern.rationale}`, '')
      if (f.review) lines.push(`独立复核：${f.review.reason}`, `证据等级：${f.review.evidenceLevel}`,
        `改善：${f.review.improves.join('、') || '无'}；可能退化：${f.review.regresses.join('、') || '无'}。`,
        `保留的不变量：${f.review.invariants.join('；') || '未确认'}`, '')
      if (f.canonicalId !== f.id) lines.push(`同一根因归并至：\`${f.canonicalId}\`。原始候选与复核保留，不重复计算。`, '')
      for (const e of f.evidence) lines.push(`证据：${e.path}:${e.startLine}–${e.endLine} ${e.symbol}（${e.role}）`,
        `快照：\`${e.snapshotId}\`，SHA-256：\`${e.sha256}\`。`, '', ...e.quote.split('\n').map(line => `> ${line}`), '')
    }
  }
  lines.push('## 应保持的设计与逐任务观察', '')
  for (const result of report.tasks) {
    lines.push(`### ${result.task.id}`, '', `状态：${result.status}。${result.error ?? result.analysis?.summary ?? ''}`, '')
    for (const model of result.analysis?.designContext ?? []) lines.push(
      `协作形式：${model.form}；参与者：${model.participants.join('、')}。`,
      `协作：${model.collaboration}`, `状态与效应：${model.stateAndEffects}`,
      `不变量：${model.invariants.join('；') || '当前范围未确认'}`,
      `边界与未知：${model.uncertainties.join('；') || '未额外声明'}`,
      `模型依据：${model.evidence.map(e => `${e.path}:${e.startLine}（${e.snapshotId}）`).join('、')}`, '',
    )
    for (const observation of result.analysis?.observations ?? []) lines.push(
      `- 保持现状（${observation.dimensions.join('、')}）：${observation.reason}`,
      `  依据：${observation.evidence.map(e => `${e.path}:${e.startLine}`).join('、')}`, '',
    )
    for (const c of result.analysis?.coverage ?? []) lines.push(`- ${c.dimension} ${c.status}：${c.reason}`)
    lines.push('')
  }
  lines.push('## 覆盖缺口与证据索引', '')
  for (const path of report.changedPaths) lines.push(`- 基线变化：${path}`)
  for (const error of report.errors) lines.push(`- ${error}`)
  for (const result of report.tasks.filter(t => t.status !== 'completed')) lines.push(`- ${result.task.id}：${result.error}`)
  lines.push('', '完整任务、规划提议及校验、原始候选、复核和快照索引见同目录 report.json、planning/、tasks/、calls/、index.json、snapshots/。calls/*.timing.json 保存调用起止时间、耗时和终态。', '')
  return `${lines.join('\n')}\n`
}
