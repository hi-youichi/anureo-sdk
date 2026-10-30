# 独立 SDK 开发与迁移记录

> 状态：独立开发 workspace；2026-10-29。
> 关联：[架构](architecture.md)、[抽取方案](../extraction-plan.md)。

## 1. 本轮范围

从 cowork 的七包实现迁入独立 workspace，保留完整测试、必要假后端和独立安装样例。只迁入 SDK 打包所需脚本及夹具，没有迁入 Harness Host、产品 RPC、真实账号探测脚本或启动服务的脚本。

来源 revision 与原文件 SHA-256 记录在 [upstream-provenance.json](upstream-provenance.json)。这是代码快照迁入，不是 `git filter-repo` 历史迁移。来源 SDK 和所选脚本在迁入时没有未提交变更；上游其他模块存在进行中的改动，因此本轮先在独立目录改名与验收，未按原方案先修改上游。

## 2. 命名与兼容边界

七包改为 `@anureo/*`，目录提升为 `packages/<leaf>`；原 `chp` 目录现在为 `ahp`。协议类型和工厂使用 `Ahp*`、`AHP_*`、`createAhpAdapter()`，扩展前缀使用 `x-anureo/`。

原方案称 Schema 没有 cowork 字符串；实际 Schema 的 `$id`、标题和描述仍带旧品牌。本轮迁移将 `$id` 改为 `urn:anureo:ahp:v1`，并同步 Schema 定义名及其引用。JSON-RPC 方法、事件与业务字段结构沿用原合同；旧品牌扩展名称不自动兼容，需要两端使用新前缀。

Codex 固定版本的原生 Schema 与 provenance 保留原始内容，并恢复为 Git 中的 LF 换行以通过原有哈希检查。这里的品牌迁移不修改第三方协议资产的语义或预期哈希。仓库通过 `.gitattributes` 固定 LF，避免 Windows 检出为 CRLF 后导致生成文件与原生资产检查失配。

包版本设为本地开发版 `0.2.0`，所有 manifest 和打包副本保持 `private: true`。该设置不代表 npm 已发布，也不完成公开发布的许可与治理决策。

## 3. 验证入口

| 命令 | 验证内容 |
|---|---|
| `bun install --frozen-lockfile` | 从本仓锁文件安装，无上游 node_modules 链接或 ACP 补丁 |
| `bun run check:boundaries` | 七包依赖和导入边界，禁止产品包与本地路径依赖 |
| `bun run generate:check` | Schema 和生成类型一致 |
| `bun run protocol:check` | Codex 原生协议资产哈希与映射 |
| `bun run typecheck` | 七包类型检查 |
| `bun run typecheck:tooling` | 本仓打包、校验脚本与根示例类型检查 |
| `bun test --timeout 15000 packages scripts/harness-sdk` | 各包单测、一致性测试和打包辅助组件测试 |
| `bun run example` | 无账号、无模型调用的公共接口示例 |
| `bun run build` | 七个 Node ESM + 类型声明 tgz |
| `bun run verify:pack` | 干净 npm 安装、strict NodeNext、Node/Bun 和真实 ACP/AHP stdio 流程 |

测试运行器使用 Bun；独立产物的运行时兼容性通过 Node 和 Bun 两次实际运行检查。CI 在三个操作系统上执行这些步骤，测试不调用付费模型。

## 4. 验收记录

本地环境：Windows、Node.js `v22.20.0`、Bun `1.4.2`。

| 检查 | 结果 |
|---|---|
| 冻结锁文件安装 | 通过；独立安装，无上游 workspace 链接 |
| 七包边界、Schema 生成一致性、Codex 原生 Schema 哈希 | 通过 |
| 七包和根目录工具类型检查 | 通过 |
| 完整测试集 | **190 passed / 0 failed**，24 个测试文件，735 次断言 |
| 根目录公共接口示例 | 通过，输出 `Hello from Anureo SDK` |
| 七包 tgz 与干净安装 | 通过，包名、ESM 入口和类型声明可独立消费 |
| 安装产物的 strict NodeNext 类型检查 | 通过，`skipLibCheck: false` |
| Node / Bun 样例与标准 ACP / AHP stdio 流程 | 通过；覆盖文本、拒绝审批和中断 |
| ACP 官方依赖检查 | 使用未打补丁的官方 SDK `1.4.0` |
| 上游源文件保护 | 迁入清单中的 96 个文件 SHA-256 与迁入前一致 |

详细本地产物位于 `artifacts/report.json`、`artifacts/unit-tests.log` 和 `artifacts/pack-verification.log`，均为忽略文件。CI 已配置但尚未在远端运行，macOS/Linux 的当前版本证据仍待补齐；脚本化验收不覆盖真实付费后端。

本轮修复了 Windows 路径和测试可移植性问题：URL 路径通过 `fileURLToPath()` 转换，声明生成的 glob 使用正斜杠并由 Node 执行 TypeScript；生成文件和原生 Schema 使用 LF。对于本机复现的原生 I/O 拒绝断言挂起，测试先 `await` 捕获错误再进入 matcher；短超时测试在启动握手后设置被测期限，不改变生产默认值和预期错误语义。

## 5. 仍待完成

- 在干净仓库执行 Git 历史抽取，再将本轮独立改动叠加到历史上；不得以当前快照冒充保留历史的抽取结果。
- cowork 的业务层改为消费独立包，并执行其集成验收；本轮未修改上游业务、依赖或运行进程。
- 实际运行 macOS/Linux CI，补齐平台证据；单机 Windows 验收不能替代另外两平台。
- 确认 npm/GitHub 归属、许可证和首发版本，准备英文公开规范、治理和安全文档。
- 在已确认的远端与发布权限下配置 dev channel；本轮未建立自动发布或使用发布凭据。
