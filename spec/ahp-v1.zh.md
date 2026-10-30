# Anureo Harness Protocol v1（中文参考译本）

> 状态：AHP v1 的中文参考译本。**权威规范是英文版 [ahp-v1.md](ahp-v1.md)**；两者不一致时以英文版为准。
> 当前实现与迁移边界见[开发记录](../docs/development.md)。

会话元数据使用 `SessionState.metadata?: SessionMetadata` 和 `session/metadata` 事件；`title` 缺省表示无更新，字符串替换，null 清除，不携带 turn 生命周期语义。外部 AHP v1 经 `x-anureo/session-metadata@1` 扩展协商后发送。

AHP 是 harness 一侧的独立协议。调用者为 Harness SDK / Host，不是浏览器。浏览器到 Host 使用独立的 `hx.*` 产品协议。规范来源是 `packages/protocol/schema/v1/ahp.schema.json`；TypeScript、方法表和运行校验从它生成或编译。这里描述已实现的合同，不表示所有后端都支持全部可选能力。

## 版本、传输与握手

AHP v1 使用标准 JSON-RPC 2.0。stdio 每行一个 UTF-8 JSON 对象；WebSocket 每个文本帧一个对象。请求 id 为非空字符串或整数，应答复用该 id。`initialize` 请求双方能力并选择共同支持的最高主版本；没有共同版本在业务操作前报 `PROTOCOL_VERSION_UNSUPPORTED`。调用者收到成功结果后发送 `initialized`。未声明能力即不支持；新增可选字段不升级主版本，破坏性语义变动必须升级主版本。

AHP 线通知采用 `method = event.type`、`params = 完整 AhpEvent`。params 保留 type/payload 与会话源序号；method 与 params.type 必须相等。交互通过 `interaction/requested` 通知发起，只能由独立的 `interaction/respond` 或 `interaction/cancel` 请求应答，不同时要求对同一通知发送 JSON-RPC response。

以下 JSONL 消息通过包内文档样例测试校验：

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersions":[1],"clientInfo":{"name":"example-host","version":"0.1.0"},"clientCapabilities":{"interactions":["approval"]}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"runtime":{"name":"example","version":"0.1.0","adapter":"example/0.1.0"},"capabilities":{"turn":{"interrupt":true},"interactions":["approval"]}}}
{"jsonrpc":"2.0","method":"initialized"}
{"jsonrpc":"2.0","id":2,"method":"session/open","params":{"requestId":"open-1","mode":"new","binding":{"sessionId":"s1","adapterId":"example","runtimeConfigId":"example-1"},"cwd":"/workspace"}}
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"requestId":"start-1","sessionId":"s1","turnId":"t1","input":[{"type":"text","text":"Inspect the workspace"}]}}
{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"s1","streamId":"stream-1","seq":1,"timestamp":"2026-10-26T00:00:00Z","turnId":"t1","type":"turn/started","payload":{"turnId":"t1"}}}
{"jsonrpc":"2.0","method":"interaction/requested","params":{"sessionId":"s1","streamId":"stream-1","seq":2,"timestamp":"2026-10-26T00:00:01Z","turnId":"t1","type":"interaction/requested","payload":{"interactionId":"approve-1","kind":"approval","options":[{"id":"allow","label":"Allow once","semantic":"allowOnce"},{"id":"deny","label":"Deny","semantic":"deny"}]}}}
{"jsonrpc":"2.0","id":4,"method":"interaction/respond","params":{"requestId":"respond-1","sessionId":"s1","interactionId":"approve-1","response":{"kind":"approval","optionId":"deny"}}}
{"jsonrpc":"2.0","method":"interaction/resolved","params":{"sessionId":"s1","streamId":"stream-1","seq":3,"timestamp":"2026-10-26T00:00:02Z","turnId":"t1","type":"interaction/resolved","payload":{"interactionId":"approve-1","outcome":"responded"}}}
{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"s1","streamId":"stream-1","seq":4,"timestamp":"2026-10-26T00:00:03Z","turnId":"t1","type":"turn/completed","payload":{"turnId":"t1","status":"completed"}}}
```

## 能力与方法

能力声明是 `Capabilities`，包含 session resume/fork/revert/history、turn steer/interrupt/outputSchema/输入模态、goal actions、review、compact、嵌套子代理、MCP、交互类型、配置选项 schema 和显式扩展。上层按能力选择，不按提供方名称猜测。`supportsCapability` 对缺省和空列表返回 false。

| 方法 | 参数类型 | 结果类型与限制 |
| --- | --- | --- |
| initialize | InitializeParams | InitializeResult；协议主版本协商 |
| session/open | SessionOpenParams | SessionOpenResult；new/resume/fork，binding 不可变 |
| session/close | SessionCloseParams | SessionCloseResult；只释放 idle 会话 |
| session/config/set | SessionConfigParams | SessionState；patch 按选项 schema 校验 |
| session/revert | SessionRevertParams | RevertResult；请求 scope 必须全部可用，实际效果如实返回 |
| history/read | HistoryReadParams | HistoryPage；权威 item 快照，无原始 delta 序号 |
| turn/start | TurnStartParams | TurnStartResult；调用方先分配 turnId，无默认排队 |
| turn/steer | TurnSteerParams | TurnSteerResult；expectedTurnId 精确匹配当前 turn |
| turn/interrupt | TurnInterruptParams | TurnInterruptResult；受理不代表已结束 |
| interaction/respond | InteractionRespondParams | InteractionResult；审批只允许提供的 optionId |
| interaction/cancel | InteractionCancelParams | InteractionResult；明确非授权取消 |
| goal/set、goal/clear | GoalSetParams、GoalClearParams | GoalState；缺省不支持，不模拟目标 |
| compact/start | CompactStartParams | MaintenanceResult；maintenance 期间不启动 turn |
| review/start | ReviewStartParams | TurnStartResult；与普通 turn 共用互斥与生命周期 |

业务请求的 requestId 只关联本次原生会话操作，不承诺跨进程幂等；持久幂等由 Host 操作账本提供。resume 必须有 binding.nativeRef；fork 必须有 fork.sourceSessionId 与 boundary。boundary 区分 before/through。revert scope 为 conversation/files/both，不支持完整 scope 时必须在执行前拒绝。部分执行后失败携带实际影响和 outcomeUnknown，不声称原子回退。

## 内容和事件

输入为 text/image/file；文件引用是显式 URI，不把任意文本推断为文件操作。Item 包含 userMessage、agentMessage、reasoning、plan、toolCall、subagent、review、compaction、hook、notice 十类。agentMessage.phase 区分 commentary/final；工具 kind/input/output、子代理 subagentId/state 由结构字段表达，title 只展示。

每个 session 最多一个活动 turn。每个已开始的 turn 只有一个 completed 终态（completed/interrupted/failed）。item/completed 是完整权威内容，替换流式内容而不是再拼一次。身份使用 `(sessionId,turnId,itemId)`，不能仅按提供方 itemId 建索引。

每次 open 生成 streamId，源 seq 从 1 连续递增；再次 open 使用新 streamId。Host 的持久 hostSeq 是另一套序号，不与源 seq 混用。只有明确声明 replay 的源才可回放；history 快照不能伪装成原始实时事件。usage 必须标明 provider/scope/source=native，不提供的计数字段缺省，不记零或用累计差值假装精确值。

标准事件包括 session/state、turn/started/completed、item/started/delta/completed、usage/updated、interaction/requested/resolved、notice。未知原生通知转 notice，未知 item 以 toolCall.kind=other 保存可安全公开的 nativeType/raw。未知请求返回 method-not-found，不能默认批准。协议层 schema 校验不替代 SDK 的有状态生命周期检查。

## 交互与隐私

四类交互：approval（options）、userInput（questions 与可选答案 schema）、elicitation（form/url 与 schema）、dynamicTool（toolName/arguments 与输出 schema）。`validateInteractionResponse` 验证 kind、optionId、问题必答/选择范围及附带 JSON Schema。响应的竞争、超时和唯一解决由 SDK 的交互管理器负责。

resolved.outcome 为 responded/cancelled/expired/unknown。responded 表示已提交原生应答；unknown 表示本地不能再安全应答，不能解释为原生已批准或取消。超时、断线和 turn 终止不能默认授权。

privatePayload 只在内存使用，publicEvent/publicInteraction 产生不修改原对象的公开投影，删除整个 privatePayload 并设置 privatePayloadAvailable。secret 答案、认证字段、headers/env 不得持久化。授权 URL 的 query/fragment 不进入公开文本；完整地址仅通过 Host 的授权私有读取返回。日志/错误只保留校验路径和错误关键词，不复制参数值。

## 错误与扩展

HarnessError 包含稳定 code/message/retryable/outcomeUnknown 和可选 details。发送后断线不确定是否执行时 outcomeUnknown=true，禁止自动重新发送。仅明确未执行的 method-not-found 可用于已验证的别名降级；不能用破坏性方法探测能力。

扩展使用 `x-<vendor>/<feature>` 与独立 version，必须在双方能力中声明。AHP 的 extension 事件以 payload.name 指向协商命名空间，payload.version 指定扩展版本。未知可选字段可保留，但不能让旧实现承担新必填语义；未知必需功能按不支持处理。

## 开发与一致性

```sh
cd packages/protocol
bun run generate
bun run generate:check
bun run typecheck
bun test tests
```

生成器拒绝不支持的类型词汇，不能静默发出 any。Schema 的结构校验用固定 Ajv 8.20.0 draft 2020-12；业务强类型和方法映射由相同 Schema 生成。核心和各适配器还必须通过生命周期/恢复一致性套件，Schema 测试本身不证明运行时正确。

## 文件变更材料

`toolCall.fileChanges?: FileChange[]` 是 AHP v1 的可选扩展，旧事件仍有效。每个文件包含 `path`、可选 `oldPath`、`operation`、`materials` 与 `completeness`；材料是 `unified` 原文、带 `scope: file|fragment` 的旧新文本，或带原因的 `unavailable`。片段只有原生提供定位时才有 1-based `oldStartLine/newStartLine`。`oldText: null` 表示有证据的新建，空字符串表示已有空内容。`stats.accuracy` 与 `completeness` 描述材料，执行是否成功仍以原生 item.status 为准。

`item/delta` 的 `kind: patch, value` 保存完整 Item 快照；消费者校验 Item、ID 与当前 turn 中已有类型后整体替换。`patch.text` 仅兼容旧 fileChange 执行日志，不是 unified patch。Codex 的 `item/fileChange/outputDelta` 使用 `kind: output`。
