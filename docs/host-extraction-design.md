# Anureo Host 抽取方案

> 状态：**设计草案，待实施**；2026-11-13。
> 目标：将 Cowork 已有的持久会话管理能力抽取为 Anureo SDK 的可选 Host 层，并让 Cowork 作为下游消费。
> 关联：[现有架构](architecture.md)、[SDK 入口](../README.md)、[AHP v1](../spec/ahp-v1.md)。本文提出扩展原有“Host 留在 Cowork”的边界；现有文档中的该决定仍描述已实现状态。

## 1. 结论与范围

新增 `@anureo/host`，负责持久会话、操作幂等、事件日志、订阅、排队、并发与故障恢复。已有 `@anureo/sdk` 继续负责 Runtime、Session 和适配器语义，不反向依赖 Host，也不自动引入数据库。

同时抽取通用 Host 合同和 SQLite 实现，分别放入 `@anureo/host-protocol`、`@anureo/host-storage-sqlite`。第一版服务单进程 Host；不同进程不得同时拥有同一数据库的执行调度权。SQLite 支持多连接不等于已经实现分布式执行租约。

这次先交付库和 Cowork 集成，不增加独立 daemon、CLI、HTTP 服务、浏览器客户端 SDK 或多节点调度。

## 2. 已核对的实现基线

| 项目 | 本次观察 |
|---|---|
| SDK 仓库 | `anureo-sdk`，HEAD `c81e93a3230a2e0396325f86e8e9023228676b89`；根包及七个发布包为 `0.2.0` |
| Host 来源 | `cowork-render-performance` worktree，HEAD `fd45203b6df6471e25ef5ecb6f32300e17b5432f` |
| 另一份来源引用 | 本地 `feat/web-hx-protocol` 为 `8e347c3ffd1ad75d25539743225dc03aa385559e`；检查时 Host 生产文件差异仅涉及 `src/index.ts` 导出 |
| 当前工作目录 | `cowork/main`，仍使用旧 Anureo Server + ACP 路径；不得假定在 main 已部署新 Host |
| Host 依赖 | `@anureo/* ^0.2.0`、`@cowork/hx-contracts`、`@cowork/hx-projection` |
| 存储 | `bun:sqlite`，WAL，`user_version` 至 4；包含操作、事件、队列、执行证据、模型和投影快照 |
| 平台依赖 | `store.ts`、`catalog-store.ts` 使用 Bun SQLite；`builtins.ts` 使用 Bun 的带 headers WebSocket 构造接口 |
| 已执行验证 | `bun test --timeout 15000 packages/server/harness-host/tests`：127 pass、0 fail、18 个测试文件、578 次断言 |
| 证据限制 | 测试针对当前工作树，Host 测试和投影存在未提交改动；没有执行真实模型联调、Node Host 验证或 SDK 迁移 |

实施前选择可合并的来源提交，生成文件清单与 SHA-256。不能只记录 HEAD 后无说明地导入工作树内容，也不能覆盖现有 worktree 的修改。依赖的未提交修复应独立确认、纳入来源清单。

源码索引（以下相对链接指向本机相邻 worktree）：

- [Host 主实现](../../cowork-render-performance/packages/server/harness-host/src/host.ts)：控制入口、授权、会话、订阅和恢复。
- [Store](../../cowork-render-performance/packages/server/harness-host/src/store.ts)：SQLite、账本、事件和隐私摘要。
- [配置](../../cowork-render-performance/packages/server/harness-host/src/config.ts)、[内置工厂](../../cowork-render-performance/packages/server/harness-host/src/builtins.ts)：发现、状态目录与后端创建。
- [客户端合同](../../cowork-render-performance/packages/rpc/hx-contracts/src/generated/types.ts)、[投影](../../cowork-render-performance/packages/rpc/hx-projection/src/projection.ts)。
- [Cowork 接入](../../cowork-render-performance/apps/cowork-server/src/index.ts)、[Anureo 准备流程](../../cowork-render-performance/apps/cowork-server/src/harness/hx-anureo-runtime.ts)。

## 3. 目标分层与包依赖

```text
Cowork / 其他应用
  ├─ 身份认证、权限策略、Agent catalog、资源解析、业务工作区
  ├─ 客户端协议兼容层、展示投影、产品通知
  └─ @anureo/host
       ├─ @anureo/host-protocol → @anureo/protocol
       ├─ @anureo/sdk → @anureo/protocol
       ├─ 注入的 RuntimeRegistration → 所选 adapter
       └─ HostStorage ← @anureo/host-storage-sqlite
```

| 新包 | 职责 | 依赖限制 |
|---|---|---|
| `@anureo/host-protocol` | Host 请求、结果、事件、错误及生成校验；独立于 AHP 的版本 | 可用于浏览器，不导入 Node、Bun、数据库或产品模型 |
| `@anureo/host` | 调度与生命周期、事件消费、恢复、并发、订阅、模型目录服务 | 依赖 SDK 和通用合同；通过端口访问存储、授权、工作区和 runtime |
| `@anureo/host-storage-sqlite` | SQLite schema、事务、升级和隐私摘要持久化 | 可依赖 Host 的类型；Host 不反向依赖此包；运行时驱动通过独立入口加载 |

`@anureo/host` 的 `./rpc` 子入口提供无网络监听的 JSON-RPC dispatcher。库使用者可直接使用 TypeScript API；网络服务自己负责连接、认证、TLS 和传输大小限制。

初期不再增加独立 catalog、queue、recovery、workspace npm 包，先作为 Host 内部模块。Host 不默认依赖全部适配器；runtime 工厂由应用按需注册。

## 4. 功能归属

| 当前功能 | 目标归属 | 处理方式 |
|---|---|---|
| 持久会话、turn、interaction | Host | 保持原生命周期与能力检查 |
| 幂等操作账本、unknown、reconcile | Host + storage | 保持账本与停止证据语义 |
| `hostSeq`、事件去重、补读、订阅背压 | Host + storage | 先持久化，再推送；订阅失败不撤销已提交操作 |
| 队列、容量、admission、托管执行 | Host | 保留固定上下文、队列快照与容量核算 |
| fork、revert、harness switch | Host | 后端能力不升级；切换创建新 binding generation |
| 模型缓存、刷新合并、退避 | Host | 与应用无关的缓存服务及诊断事件 |
| 模型展示分组、默认 runtime 偏好 | Cowork | 第一阶段保留 `codex-models.ts`、`claude-models.ts` 等展示策略；由注册端提供模型结果 |
| `projectId`、`agentId`、成员角色 | Cowork 兼容层 | 映射至通用 scope、调用主体及应用元数据 |
| Agent instructions、skills、MCP 来源 | Cowork | 解析为固定启动上下文后注入；通用 Host 只消费结果 |
| 引用、图片输出、通知、变更追踪 | Cowork | 使用解析与生命周期端口；不导入产品服务 |
| 工作区执行安全门与停止证据 | Host | 保留锁、忙碌检查、generation 校验 |
| Git worktree 创建、合并、丢弃 | Cowork | 注入 WorkspaceProvider；通用 Host 不执行产品 Git 操作 |
| 原生 CLI 安装、账号登录、Anureo profile/server 准备 | Cowork | 持有资源的工厂注入 Host；不把这些流程强制加入 SDK |
| 当前 `HxProjection` 与 `hx.projection.snapshot` | Cowork | 先移除 Host 硬依赖；在兼容层消费持久事件，保留现有快照与客户端格式 |

投影目前是纯 TypeScript，并非 React 代码；保留在 Cowork 的原因是其输入引用、快照合同和演进节奏属于产品协议。后续若有第二个消费者，再单独抽取通用 reducer，避免本轮同时改变渲染语义。

## 5. 通用模型与授权

核心模型使用 `scopeId` 作为不透明的资源隔离域，Host 不解释其是否为项目、组织或工作流。会话保留 `ownerId`、`runtimeConfigId`、binding、revision、cwd 与执行状态；`agentId` 等放在应用扩展中。

应用扩展必须有 schema、大小上限和公开/私有分类。私有 instructions、MCP 凭据和内部路径不因进入 metadata 就变成公开值。列举与查询需要的应用字段由兼容层建立索引或使用明确的 storage 扩展，不能为过滤 Agent 会话每次扫描整个历史。

授权入口采用 `authorize(actor, action, resource)`：

- actor 由宿主应用认证后构造；客户端不能自行声明用户、管理员或 service 身份。
- action 为通用操作，如 `session.read`、`session.create`、`turn.start`、`interaction.respond`、`catalog.refresh`。
- resource 携带可信的 scope/session/binding 信息；按存储记录解析，拒绝客户端伪造作用域。
- 通用 Host 不内置 `mode=off`、`isAdmin`、`service` 绕过规则；Cowork 的现有规则在兼容策略中映射并回归验证。
- 订阅推送、目录通知、后台队列真正 dispatch 时重新检查相关权限；授权缓存不可成为永久许可。
- 本地 `execute()` 和远程 dispatcher 进入同一套授权、校验与操作处理逻辑。

托管任务通过仅服务端可获得的控制对象创建固定上下文。该对象和调用能力不进入 JSON-RPC；禁止把当前内部 `_trusted`、`_fixedContext` 等字段提升为公开协议字段。

## 6. API 设计

以下为目标 API 草图，尚未实现。优先提供一套类型化 command API 和查询 API，RPC 映射到同一执行路径，不维护另一套状态机。

```typescript
import { createHarnessHost } from '@anureo/host'
import { createSqliteHostStorage } from '@anureo/host-storage-sqlite/bun'

const storage = createSqliteHostStorage({ file: './data/host.sqlite' })
const host = await createHarnessHost({
  storage,
  runtimes: [myRuntimeRegistration],
  authorize: myAuthorizationPolicy,
  resolveLaunch: myLaunchResolver,
})

await host.start()
const operation = await host.execute({ actor }, {
  type: 'session.create',
  scopeId: 'workspace-a',
  runtimeConfigId: 'codex-native',
  idempotencyKey: 'create-1',
})
// 后续调用、事件消费与资源释放见包内完整示例；此处只展示创建入口。
await host.close()
```

| API | 作用 |
|---|---|
| `createHarnessHost(options)`、`start()`、`close()` | 构建、后台服务启动、有界关闭；启动恢复完成前不接受写操作 |
| `execute(context, command)` | 会话、turn、interaction、queue、goal、compact、review、binding 等写操作 |
| `sessions.get/list`、`operations.get` | 读取公开状态或幂等操作结果，执行同一授权策略 |
| `events.read/subscribe` | 按持久游标补读与实时消费；返回可显式取消的订阅 |
| `catalog.get/refresh`、`runtimes.replace` | 查询目录、显式刷新、替换未来会话的工厂 |
| `capacity.get` | 读取活动执行、admission 与不确定执行占用 |
| `createManagedController(...)` | 仅服务端构造的托管任务控制对象；创建、执行、查询、停止 |
| `recovery.inspect/reconcile` | 使用独立停止证据核对，不重发原操作 |

第一版托管 controller、admission 和全局权限降级可先作为 experimental API；不要直接将现有所有 public 方法承诺为长期稳定接口。

必要端口包括 `HostStorage`、`RuntimeRegistration`、`AuthorizationPolicy`、`LaunchResolver`、`InputResolver`、`WorkspaceProvider` 和生命周期/诊断回调。扩展端口按现有真实调用抽取，不构造通用插件系统。

固定上下文在任务接受时解析并冻结。排队保存 canonical execution input、模型与配置快照；dispatch 时重新校验策略，但不悄悄采用更新后的 Agent 配置，也不扩大已接受权限。

## 7. 存储与运行时边界

### 7.1 存储接口

先将现有 Store 转换为领域存储端口，封住 `store.db`。尤其要将 `new CatalogStore(this.store.db)` 变为 `storage.catalog`；投影缓存通过 Cowork 自有接口访问，Host 不暴露数据库连接。

存储端口按实际原子操作设计，如事件追加与状态更新、幂等接受、队列 CAS 和执行证据提交。第一阶段保持同步 SQLite 事务，不将所有方法机械改为 async；第一版不承诺远程数据库实现。

必须保持的原子与时序约束：

1. 写入 operation 接受记录及请求摘要后，才允许向后端 dispatch。
2. 事务内完成 source 去重、分配 `hostSeq` 和派生状态更新，提交后才能发布事件。
3. queue revision CAS、位置和 execution snapshot 同时提交；dispatching 记录先于实际发送。
4. 后端调用不放入数据库事务；跨进程崩溃窗口使用 `unknown` 表达，不能声称 exactly-once 执行。
5. reconcile 得到已停止证据，只解除执行阻塞；原操作结果保持 unknown，新尝试必须有新意图标识。

幂等键保持 actor、method、target、key 的既有隔离；公开重命名不可改变已经落库的操作身份。新的 scope 隔离必须保证 target 或账本索引中包含相应隔离信息。

### 7.2 Node 与 Bun

现有 SDK 支持 Node 22+；当前 Host 不能直接满足这一点。抽取后 root entry 不得静态导入 `bun:sqlite`、Bun 类型或默认全适配器工厂。

- `@anureo/host`：Node 22+ / Bun 的共同逻辑。
- `host-storage-sqlite/bun`：独立加载现有 Bun SQLite 驱动。
- `host-storage-sqlite/node`：经 PoC 选择与目标 Node 最低版本兼容的 SQLite 驱动；逐项验证事务、backup、BLOB、WAL、busy 和关闭行为。驱动选择是 P0 技术验证项，不在方案中假定现有 Bun API 可直接替换。
- AHP WebSocket 连接工厂由调用方注入；带认证 headers 的连接不依赖 Bun 特有构造参数。Node 普通 WebSocket 构造器不能被假定支持相同签名。

内部迁移可先跑通 Bun；完整公开交付必须补齐 Node 持久化与三平台验收。不能因为内存 fake 在 Node 跑通，就宣称持久 Host 已支持 Node。

### 7.3 单进程所有权

同一持久库同一时刻只允许一个 Host 执行者。打开时取得独占实例所有权，第二个 Host 必须明确失败；异常退出后按操作系统锁的生命周期释放并进入恢复。锁实现必须在 Windows/macOS/Linux 验证，不能仅依赖不带存活校验的 PID 文件。

第一版通过锁注入接口及参考实现完成这一点；不在现有 SQLite 表上自行拼出未经验证的多主租约协议。

## 8. Host 协议与 Cowork 兼容

AHP v1 继续表示 Host 到 harness 的合同。本次不向 AHP 添加 project、权限角色、持久事件游标或队列账本，也不因新增 Host 包自动提升 AHP 主版本。

新的 Host 合同单独版本化，初期标记 experimental；保留 `hx.*` 方法命名体系，使用 `scopeId` 等通用模型。不能把现有 Cowork schema 直接换包名后宣称已经通用化。

Cowork 保留原 `@cowork/hx-contracts` 的客户端合同，由薄兼容层完成：

| Cowork 输入/输出 | 通用 Host 映射 |
|---|---|
| `projectId` | `scopeId`，保持原始标识值 |
| `agentId`、资源 references | 应用字段与 InputResolver；公开引用保持原格式 |
| viewer/member/maintainer、管理与 service 规则 | AuthorizationPolicy 的显式映射 |
| `chp` runtime 名称 | 配置边界兼容为 `ahp`；已有 binding 不原地重命名 |
| `hx.projection.snapshot` | Cowork 投影服务，从同一 durable log 读取 |
| `hx.workspace.*` | Cowork WorkspaceProvider，保留 Host 执行安全门 |
| `hx.*` 旧操作账本 | 保持 legacy operation identity 与摘要规则，不因字段映射造成重复执行 |

旧输入的幂等摘要必须在兼容映射前按旧规范计算，或通过明确的持久 identity 映射保留；不能简单对映射后的新 JSON 重算摘要。新 API 使用独立的合同版本/identity 域，禁止同一幂等键跨旧新合同被误认为同一操作。

事件保持既有 `hostSeq`、source、bindingGeneration 和订阅顺序。兼容层只改表示，不造历史 source 事件、不压缩旧游标、不把 snapshot 当作源 replay。

Host 通知包含可补读的事件、订阅溢出和目录失效。订阅先建立一致的读取边界再衔接实时推送，验证边界期间不会漏事件；通知权限失效应停止发送。

## 9. 数据兼容与隐私

第一阶段尽量保留现有 `hx_*` 表名、`project_id` 列和 record 布局，由 SQLite 兼容 codec 映射通用模型。品牌改名不构成重建数据库的理由。新字段优先增量迁移；源数据库 schema v1 至 v4 都提供 fixture 验证。

必须保留 `.key` 与数据库的对应关系：当前它用于 HMAC 请求摘要、private answer hints 和 key verifier，并不是数据库加密密钥。保留旧 verifier 标签 `cowork-hx-key-verifier` 的兼容读取；不能仅改字符串就导致全部旧库被判断为密钥无效。

缺失/错误 key 继续 fail closed。认证凭据、secret 答案原文、private interaction payload 和 delta 临时尾部不得写入公开日志或快照；已标记秘密的历史与 fork 继承脱敏行为保持不变。

备份与回退按整体状态处理：

- 停止旧执行者后，使用 SQLite 一致性备份方式获取数据库，并一并保全 `.key`；不能只复制正在写入的主文件而忽略 WAL。
- 包替换优先在相同 schema 和双向可读 codec 下完成；升级前验证旧版本能读取新写入的兼容记录。
- schema 一旦发生旧版本无法识别的迁移，不支持直接降包；回退必须停掉新执行者，恢复升级前整体快照，并核对升级后产生的执行，不能自动重发。
- 投影属于可重建缓存；迁移可失效重放，但不能丢失事件、操作或隐私摘要。

## 10. 实施阶段与交付门槛

| 阶段 | 工作 | 完成标准 |
|---|---|---|
| P0：冻结与 PoC | 选来源提交、记录哈希与工作树差异；验证 Node SQLite 驱动与实例锁；确定旧账本兼容规则 | 有可复现 provenance、Node/Bun 同一存储场景验证、旧库/新库兼容矩阵；不改生产路径 |
| P1：Cowork 内清边界 | 拆出授权/launch/投影端口、封装 `store.db`；按子系统拆 host.ts；保持原 RPC/数据库 | 既有测试保持通过；新增授权映射、旧幂等重试、投影衔接测试；行为可与基线对照 |
| P2：SDK 迁入 | 新增三包、生成通用合同、迁入领域逻辑与测试；接入 Bun/Node 存储 | 无 `@cowork/*` 导入；root entry 无 Bun 依赖；两种运行时可持久化、重启与补读 |
| P3：Cowork 反向消费 | 在包含新 Host 的特性分支接入 tarball/候选包，保留旧 hx 协议和产品端口 | 会话、审批、排队、fork/revert、切换、Workflow、工作区和恢复集成通过；不在旧 main 上直接替换 |
| P4：独立发布就绪 | 示例、文档、打包、干净安装、三平台、真实适配器验收与发布元数据 | 下表验收通过；Cowork 无私有源码引用；按仓库发布流程另行执行版本发布 |

P1 优先保行为，P2 再清理公共命名；不把拆目录、改模型、换数据库驱动和改协议混成一个不可对照的大提交。迁移期间不重启用户 local，也不让新旧 Host 同时 dispatch 同一数据库。

建议提交单元：基线夹具 → 存储/投影端口 → 通用授权与合同 → SDK 三包 → Node 驱动 → Cowork 兼容接入 → 独立分发验收。源修复与抽取重构分开记录。

## 11. 验收计划

| 类别 | 必须覆盖 |
|---|---|
| 行为基线 | 来源的 127 项 Host 测试迁移或明确归属 Cowork；不得以测试数量相同替代行为核对 |
| 原子与恢复 | 在接受前、dispatch 前后、原生 ack 前后、事件提交前后注入崩溃；unknown 不重发、队列不重复 dispatch、容量不提前释放 |
| 并发与死锁 | 提前到达的审批可回答、同 revision 仅一写成功、关闭期间迟到回调可安全清理、目录刷新不替换 live runtime |
| 授权 | 本地和 RPC 同策略、scope 伪造失败、列举隔离、订阅撤权、托管能力不可通过客户端参数伪造 |
| 存储兼容 | v1–v4 fixture 升级、旧 key verifier、WAL 备份、HMAC identity、旧请求在抽取后重试不重复执行 |
| 事件/投影 | 重连补读无缺口、source 去重、fork 祖先边界、binding generation、snapshot 失效重建、慢消费者溢出 |
| 隐私 | secret 跨 delta/重启/fork 不泄露，privatePayload 不落库，缺 key/错 key 拒绝启动 |
| 运行时/平台 | Node 最低支持版本及当前受支持版本、Bun；Windows/macOS/Linux；分别运行 Bun 和 Node SQLite 持久用例 |
| 所有权 | 第二 Host 无法打开执行权，异常退出后可恢复；不会双重消费 durable queue |
| 独立消费 | tgz 干净安装、strict NodeNext、无仓库路径/业务包/Bun 类型泄漏、只装所需 adapter 即可运行 |
| 产品集成 | Cowork 旧客户端合同、Agent 上下文、Workspace 安全门、Workflow 托管任务、权限降级均保持 |
| 真实后端 | Codex、Claude、ACP 至少验证创建/执行/审批或明确不适用/中断/恢复；脚本夹具通过不代替真实账号验收 |

已有七包的 `check:boundaries`、`generate:check`、`protocol:check`、typecheck、测试和 `verify:pack` 必须保持通过。扩展包列表、打包顺序、生成检查和 CI 时使用明确依赖关系，避免只在 workspace 链接环境中能运行。

## 12. 预计文件改动

| 仓库 | 路径 | 改动 |
|---|---|---|
| SDK | `packages/host-protocol/` | 新增 schema、生成器、类型、校验与合同测试 |
| SDK | `packages/host/src/` | 新增 Host 入口及 sessions、operations、events、subscriptions、queue、capacity、recovery、catalog、ports、rpc 模块 |
| SDK | `packages/host-storage-sqlite/` | 新增领域 Store、兼容 codec、迁移、Bun/Node 驱动与 fixture |
| SDK | `examples/host-standalone.ts` | 无 Cowork、无账号的持久会话、事件消费、关闭与重启补读示例 |
| SDK | `scripts/check-boundaries.ts`、`scripts/harness-sdk/pack.ts`、CI | 扩展三包、独立导入检查、存储运行时矩阵和干净安装验收 |
| SDK | `README.md`、`docs/architecture.md`、`spec/host-v1.md` | 清楚区分当前 SDK、可选 Host、AHP/Host 协议及运行时支持范围 |
| Cowork | `packages/server/harness-host/` | 迁移期薄 facade；稳定后仅保留产品兼容和启动组装 |
| Cowork | `packages/rpc/hx-contracts/`、`packages/rpc/hx-projection/` | 保留客户端合同和投影，增加新 Host 映射与快照接入 |
| Cowork | `apps/cowork-server/src/index.ts` 与 `harness/hx-*.ts` | 注入工厂、上下文、策略与 lifecycle hooks，替换内部 Host 构造 |

## 13. 关键决策与后续事项

本方案建议直接确定：Host 为可选层；三包边界；AHP 与 Host 协议独立；Cowork 旧协议兼容；单进程执行所有权；先保留存储布局再演进。

P0 需用代码验证后确定：Node SQLite 驱动、三平台实例锁实现，以及迁移时冻结的来源提交。这些是实施中的技术选型，不应成为反复向用户请求许可的流程。

完整公开发布前稳定最小 API，给 experimental 项明确标记；首发版本和发布时机遵循仓库现有发布流程。本设计草案不表示 Host 已实现、已发布或已通过 Node/三平台验收。
