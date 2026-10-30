# Anureo SDK：从 cowork monorepo 抽取并开源的方案

> 状态：**草案 v1**（2026-10-29，基于当日讨论整理）
> 作者：Yoichi（@hi_youichi）
> 关联：cowork 仓库 `docs/cowork-harness-protocol-design.md`、`docs/harness-sdk-distribution.md`
> 本目录独立于 cowork 仓库，是 anureo-sdk 项目的孵化与规划空间。
> **开发进展（2026-10-29）**：已先在本目录迁入独立七包快照并改为 `@anureo/*`，上游保持原样。该落地顺序与原 P2→P3 计划有差异，Git 历史迁移与上游切换未完成。详见 [开发记录](docs/development.md)；下文保留原方案作为迁移基线。

## 0. 一句话

把 cowork 里已经按开源边界切好的 Harness SDK 七包族（protocol / core / conformance / codex / claude / acp / chp）抽成独立仓库 `anureo-sdk`，以 **anureo** 品牌按 **事实标准** 路线运营：AHP 协议 + 多后端适配器 + 一致性认证。

## 1. 背景与现状盘点

### 1.1 三层概念与边界（沿用既有设计）

| 层 | 现名 → 新名 | 位置 | 去留 |
|---|---|---|---|
| 协议（CHP→AHP） | `@cowork/harness-protocol` → `@anureo/protocol` | `packages/harness-sdk/protocol` | **随迁** |
| SDK（core + 6 适配器） | → `@anureo/sdk` 等 | `packages/harness-sdk/*` | **随迁** |
| Harness Host | `@cowork/harness-host` | `packages/server/harness-host` | **留在 cowork**（依赖 `@cowork/hx-contracts`，耦合业务编排/存储/RPC） |

SDK 七包对外依赖仅 `ajv@8.20.0`、`@anthropic-ai/claude-agent-sdk@0.3.257`、`@agentclientprotocol/sdk@1.4.0`，**零 cowork workspace 依赖**；`pack.ts` 的 `safeDependencyField` 守卫已在强制这一点（发现外部 `@cowork/` 依赖直接报错）。

### 1.2 已就位资产

- 七包完整实现：协议 + JSON Schema（`protocol/schema/v1`）、core 运行时、conformance runner 与 fake-codex/acp/chp 夹具、四个适配器。
- 打包验证链 `scripts/harness-sdk/pack.ts --verify`：产 tgz、`workspace:*`→精确版本、干净目录 npm 安装、Node+Bun 双运行时 conformance、TS strict 导入校验、vanilla ACP agent 与 CHP reference harness 真实 stdio 对话。
- 独立示例：`standalone.ts`、`acp-agent.mjs`、`reference.mjs`（无凭据可跑）。
- 安全卖点已实现：标记 secret 的多级脱敏（事件/历史/diff 材料）、材料限额、交互审批语义。

### 1.3 已验证证据与空白

- **已验证**：macOS / Node 22.20.0 / Bun 1.3.6（`harness-sdk-distribution.md` 记载）。
- **空白**：Windows、Linux 从未跑过 `pack.ts --verify` 全链路。开源前必须补三平台 CI。作者主力机为 Windows，可先本地手跑一次摸底。

## 2. 定位：事实标准路线

### 2.1 生态位

AHP 的定位是 **host ↔ harness 的语义层**：会话、turn、item、事件流、交互审批、能力协商、一致性。与相邻协议错位且互补：

| 协议 | 层 | 关系 |
|---|---|---|
| MCP | 工具/资源层 | AHP item 流中可承载 MCP 工具调用 |
| ACP | editor ↔ agent 协议 | `@anureo/adapter-acp` 把 ACP agent 接入 AHP —— 互操作证明，不是竞品 |
| AG-UI 等 | UI 事件流 | AHP 语义更全（审批/goal/fork/revert/steer/history） |

README 第一段叙事：**"用 anureo SDK 接任何 harness —— 包括 anureo 自己。"**

### 2.2 四个支柱

1. **Spec 文档化**：独立、带版本号、可引用的英文协议规范（不是让人读 TS 类型）。
2. **Conformance 即认证**：实现 AHP → 跑 `@anureo/conformance` → 通过即可被所有 host 使用。学 LSP，做徽章 / CI action。
3. **治理成文**：GOVERNANCE 一页：版本协商、`x-<vendor>/` 扩展注册、breaking change 流程（RFC issue）。早期作者裁决，规则先写出来，第三方才敢押注。
4. **Why-not 页面**：正面回答"为什么不直接用 ACP/MCP/AG-UI"，附互操作矩阵。

### 2.3 非目标

- Harness Host 不开源（cowork 业务编排层）。
- 不做云服务、不做 host 托管。
- 不承诺首个版本覆盖全部原生能力（Codex 实时语音等仍走扩展通道）。

## 3. 命名（待 §9 拍板确认）

### 3.1 包名映射

| 现名 | 新名 |
|---|---|
| `@cowork/harness-protocol` | `@anureo/protocol` |
| `@cowork/harness-sdk`（core） | `@anureo/sdk` |
| `@cowork/harness-sdk-conformance` | `@anureo/conformance` |
| `@cowork/harness-sdk-codex` | `@anureo/adapter-codex` |
| `@cowork/harness-sdk-claude` | `@anureo/adapter-claude` |
| `@cowork/harness-sdk-acp` | `@anureo/adapter-acp` |
| `@cowork/harness-sdk-chp` | `@anureo/adapter-ahp`（协议改名后语义即"外部 AHP harness 适配器"） |

### 3.2 协议名：CHP → AHP（Anureo Harness Protocol）

协议 schema（`protocol/schema/v1`）实测**零 cowork 字符串**，改名只涉及文档与叙事，schema 内容不动。

### 3.3 扩展前缀：`x-cowork/` → `x-anureo/`

实测 5 处，全部在实现层：
`chp/src/index.ts:15,48,49`、`core/src/file-change-limits.ts:50`（+ 对应测试 `core/src/file-change-limits.test.ts:25`）。
趁 0.x 无外部用户，此 breaking 零成本；发布后再改则昂贵。

### 3.4 品牌双关与化解

anureo 同时是（a）作者个人品牌、 Rust harness 真身的产品名、 SDK/协议的库名。裁判与选手同名。
化解方式：文档明示"anureo（产品）与 anureo SDK（中立库）互不为依赖；SDK 对 anureo 后端与对 Codex/Claude/ACP 一视同仁，conformance 套件面前人人平等"。将其转为开放性证明而非偏袒信号。

## 4. 仓库形态与 monorepo 消费

### 4.1 为什么只有 split repo

in-repo publish（代码留 monorepo、CI 发 npm）要求 monorepo 本身开源；cowork 是闭源产品，该选项不可行。**唯一方向：`git filter-repo` 抽出独立仓库，cowork 变为普通下游。**

### 4.2 dev channel 机制

- anureo-sdk 仓库 CI：合入 main 自动发预发布版 `0.2.0-dev.<run>` 至 npm，打 dist-tag `dev`。
- cowork monorepo：依赖 dev 版本；Renovate（或等价 bot）自动开 bump PR。
- 正式版仍走 semver 0.x 节奏（`latest` tag）。

### 4.3 跨仓库联动工作流（日常代价）

改 SDK + server 联动的场景，从 1 个 PR 变 2 个：

```
① anureo-sdk：改 SDK + conformance 测试 → merge → CI 发 0.2.0-dev.42
② cowork：Renovate 已开 bump PR → 在该 PR 内配合改 server → merge
```

过渡期兜底：紧急修复可用 `npm i @anureo/sdk@<git-sha>` 临时钉住，事后归位。

## 5. 迁移序列（P0–P7）

> 原则：**先在 monorepo 内完成改名（P2），再抽仓库（P3）**——改名时 server/web/harness-host 引用与 CI 兜底同仓完成，比抽仓后再改少一轮跨仓库折腾。

### P0 决策拍板（§9 清单确认，半天）

### P1 占位（并行可做）

- [ ] 注册 npm org `anureo`（防抢注；先确认 npmjs 上 `anureo` 裸名与 scope 可用性）
- [ ] 建 GitHub 仓库（org 或个人账号下，建议 `anureo/sdk` 或 `anureo-sdk`）
- [ ] 清理 cowork 里 `packages/anureo-agent-sdk/` 残留空目录（仅剩 node_modules 的历史痕迹）

### P2 monorepo 内改名（一个 PR，CI 兜底）

- [ ] 七包 `package.json`：`name` 与包间 `workspace:*` 依赖名（含 `packages/server/harness-host/package.json` 的 6 项 SDK 依赖）
- [ ] `scripts/harness-sdk/pack.ts`：`leaves` 不动；`safeDependencyField` 守卫前缀 `@cowork/` → `@anureo/`；报告/报错文案同步
- [ ] import 路径：cowork-server 侧实测 17 处 `@cowork/harness-*` import；`apps/cowork-hx-cli`（依赖 harness-protocol）；`apps/web` 声明了 harness-protocol 依赖，import 面需在改前复核（含 `**/*.tsx` 深层递归 grep）
- [ ] 字符串：`x-cowork/` → `x-anureo/`（§3.3 的 5 处）+ 全仓 grep 复核（含 conformance 夹具与 `docs/harness-sdk*.md`）
- [ ] 术语：CHP → AHP（代码注释、导出名若含 Chp 则评估改动面；`harness-protocol.md` 规范文档标题与正文）
- [ ] 文档：`docs/harness-sdk*.md`（13 篇）内包名提及处同步；旧名→新名映射表附在 `harness-sdk-distribution.md`
- [ ] 验收：`bun test packages/harness-sdk`、`tsc --noEmit` 各包、`pack.ts --verify`（本机 Windows 摸底一次，顺便补 Windows 证据）

### P3 抽仓库

- [ ] `git filter-repo --path packages/harness-sdk --path scripts/harness-sdk --target ../anureo-sdk`（保留双路径与完整历史；注意 filter-repo 需 fresh clone）
- [ ] 新仓库内目录提升：`packages/harness-sdk/<leaf>` → `packages/<leaf>`（git mv，历史可续）
- [ ] 不随迁：`docs/`（中文内部文档留 monorepo，开源仓库重写英文）、`openspec/`、conformance 之外的一切
- [ ] 新仓库补 LICENSE / README / .github / CI
- [ ] cowork 侧：删除 `packages/harness-sdk/`、`scripts/harness-sdk/`；workspace 依赖改 npm `@anureo/*`（初期指向 dev channel）
- [ ] 验收：cowork `bun install && bun test` 全绿（SDK 以 npm 包身份被消费）

### P4 CI（开源硬前置）

- [ ] GitHub Actions matrix：`[ubuntu, windows, macos] × [node 22, bun]`
- [ ] job：build → 单测 → conformance → `pack.ts --verify`（进 PR 必跑）
- [ ] Windows 首跑预期会暴露路径/npm-cli 假设问题：`npm-runner` 已处理 `npm.cmd` 不直接执行，但 verify 全链路未在 Windows 验证过

### P5 dev channel

- [ ] CI workflow：main 合入 → 版本 `0.2.0-dev.<run>` → `npm publish --tag dev`
- [ ] cowork 加 Renovate 配置，仅对 `@anureo/*` 开 dev 跟踪
- [ ] 演练一次完整两步联动（§4.3）

### P6 文档与许可

- [ ] LICENSE：代码 **Apache-2.0**（含专利授权，适合带协议实现的库）；协议规范文本 **CC-BY-4.0** 单列
- [ ] 英文 README（定位叙事 + 快速上手 + 互操作矩阵）
- [ ] spec：`spec/ahp-v1.md` 起步，GitHub Pages 站后续
- [ ] GOVERNANCE.md / SECURITY.md（secret redaction 设计值得单列）/ CONTRIBUTING.md
- [ ] conformance 徽章与 CI action

### P7 首发官宣

- [ ] publish `0.2.0`（latest tag；从 monorepo 的 0.1.0 起步，改名记为 0.2.0）
- [ ] 公告渠道：X（@hi_youichi）、相关社区（HN / Reddit r/LocalLLaMA / ACP 生态）
- [ ] cowork monorepo 切 latest 或继续 dev

## 6. 治理与规范发布（P6 展开，P7 后持续）

- 版本协商：握手协商双方版本与能力，未声明能力不支持（沿用现行规则，写入 spec）
- 扩展注册：`x-<vendor>/<feature>` + 独立 version，GOVERNANCE 附注册表
- Breaking：语义破坏必须新主版本；0.x 期间 minor 可破，CHANGELOG 必须显著标注
- 一致性：所有能力声明以 `@anureo/conformance` 通过为准；"实现者列表"页收录过测方

## 7. 风险登记

| # | 风险 | 级别 | 缓解 |
|---|---|---|---|
| 1 | anureo 品牌双关（裁判=选手） | 中 | §3.4 叙事 + conformance 面前一视同仁 |
| 2 | 0.x 高频破坏劝退早期用户 | 中 | export 面分级（承诺面/演进面）；CHANGELOG 纪律 |
| 3 | 跨仓库原子性丧失，日常变两步 | 高（体验） | dev channel + Renovate；紧急 git dep 兜底 |
| 4 | ACP/MCP 演进吞掉语义层定位 | 中 | 持续差异化（conformance 认证是护城河）；保持与 ACP 互操作 |
| 5 | 脱敏/安全代码开源后被审视 | 中（机会） | 开源前自查一遍 redaction 边界；SECURITY.md 与负责任披露通道 |
| 6 | Windows/Linux CI 首跑暴露问题 | 低 | 作者本机 Windows 先摸底；P4 早做 |
| 7 | npm scope 被抢注 | 低 | P1 立即注册 |

## 8. 里程碑与时间线（建议）

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M1 | P0–P2 完成（改名落地，monorepo 全绿） | 1–2 周 |
| M2 | P3–P4 完成（独立仓库 + 三平台 CI 绿） | 1 周 |
| M3 | P5–P6 完成（dev channel + 英文文档） | 1–2 周 |
| M4 | P7 首发 0.2.0 官宣 | 0.5 天 |

事实标准是长线：首发只是起点，conformance 认证生态与治理成熟度以季度计。

## 9. 待拍板项（P0 清单）

1. 包名映射表 §3.1（含 `adapter-ahp` 命名）
2. 协议名 AHP + `x-anureo/` 前缀
3. License：Apache-2.0（代码）+ CC-BY-4.0（规范文本）
4. GitHub 仓库归属（个人账号 or org `anureo`）与仓库名
5. 首发版本号 0.2.0
6. spec 站域名（可后置，GitHub Pages 起步）

## 附录 A：改名影响面实测（2026-10-29，cowork 仓库）

- 七包 manifest：全部 private、v0.1.0；对外依赖 ajv@8.20.0 / @anthropic-ai/claude-agent-sdk@0.3.257 / @agentclientprotocol/sdk@1.4.0
- `@cowork/harness-*` import：cowork-server src 内 17 处；apps/cowork-hx-cli 依赖 1 项；apps/web 声明依赖（import 面待复核）
- `x-cowork/`：5 处（chp/src/index.ts:15,48,49；core/src/file-change-limits.ts:50 + test:25）
- 协议 schema：`protocol/schema/v1` 零 cowork 字符串
- pack.ts：`leaves` 七项硬编码；`safeDependencyField` 以 `@cowork/` 前缀做禁止依赖守卫，需同步
- 不随迁：`packages/server/harness-host`（依赖 `@cowork/hx-contracts`）、`packages/rpc/hx-*`、cowork 全部业务代码
- 历史痕迹：`packages/anureo-agent-sdk/` 仅剩 node_modules，可清理
