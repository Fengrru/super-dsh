# nexus-runtime：全部 crate / 模块 / worker / SDK / adapter 接入分析

本文覆盖 `nexus-runtime` 的 **11 个 crate 及其核心模块、3 个 worker、3 个 SDK、2 个 adapter**。结论先行：这个项目没有 N-API、C ABI、WASM 绑定或 HTTP daemon，Rust 不能从 dsh 直接调用；真正可复用的是**确定性状态机、事件模型、副作用账本、内容寻址、能力令牌和 worker 协议**，而不是它的“分布式/持久化运行时”宣传。

> 结论标签：**A 直接移植**（TS 重写即可）· **B 修复/加固后接**（有明确前置条件）· **C 只借思路**（源码不能直接用）· **D 不接**（mock、占位、无 transport 或重复 dsh 现有能力）。
>
> 集成方式：① TS 重实现/移植；② Rust sidecar（仓库目前没有，需要新写）；③ 直接复用 worker 脚本；④ 仅借鉴设计。

## 1. 核心语义（11）

| 组件 | 真实度 / 能力 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **state_machine** (`nexus-core/state_machine.rs`) | 真实；12 状态/28 事件纯函数 `transition()`，校验 session、因果向量、checkpoint 递增 | 在 TS 里实现一个**插件侧执行 FSM**，用于副作用账本/外部 worker/长任务，不替换 dsh session status；状态存 ST，事件写 SE；`ctx.workflowEngine` 或子代理调度器驱动 | 缺 `BudgetExceeded`/`CapabilityDenied`/`Timeout` 分支；`ConvergeStarted`/`ReflectionStarted` 会报非法迁移；预算不参与转移；先 append 后 transition 会产生毒事件 | 并发转移/非法事件/崩溃恢复；状态与事件日志一致性 | **C/A 移植子集（M）** |
| **event / types / CausalVector** | 真实；28 种事件、msgpack payload、BLAKE3 payload hash、SHA-256 integrity hash、向量时钟 | 扩展 SuperDSH audit：记录增加 `causal` 向量（单会话递增；子代理 fan-in 合并）；hash chain 已有；不引入 msgpack | integrity hash 读取/恢复时从不校验；缺签名；LLM/工具事件需新增类型；Node 无 msgpack 内置 | 多子代理 happens-before/并发冲突检测；事件篡改检测 | **B（审计扩展，S/M）** |
| **protocol** (`protocol.rs`) | 真实；确定性 msgpack、BLAKE3/SHA-256、zstd、canonical JSON、USD cents | 已用 canonical JSON + SHA-256；可选 BLAKE3 用于 artifact；不要用 msgpack 作为 dsh 会话格式 | event-store 二次 msgpack 编码，TS 调试困难；BLAKE3 需额外依赖 | hash 稳定性/跨版本 fixture | **B（仅 hash 规范，S）** |
| **checkpoint schema** (`checkpoint.rs`) | 真实类型；`ReplayAction` 覆盖 read/edit/run/LLM/MCP/git；有 golden fixture；**无读写/校验函数** | 为副作用账本定义“可重放动作” schema；ST 存 checkpoint；工具调用前后写 intent/commit；不要假设所有动作都能重放 | 日志中实际常缺 LlmCall/McpInvoke；恢复时 handle registry 被清空 | 中断后从 checkpoint 继续；重复动作幂等 | **C（schema 借鉴，S）** |
| **recovery** (`recovery.rs`) | 部分真实；重放事件、校验 CV、checkpoint/artifact/LLM 去重；**报告字段硬编码 true，plan 不执行** | dsh 已有 session 恢复；只补“未完成副作用对账”：启动时扫描 intent 无 commit 的工具，按 Pure/Idempotent/Reversible/Irreversible 决定 | 不能恢复进行中的 tool call/子进程；`recover_from_events` 假报告；CLI resume 只打印 | kill -9 在 tool intent/commit 之间；重复副作用次数必须 0 | **C（重写对账，M）** |
| **session_driver** (`session_driver.rs`) | 真实；intake/parse/plan/commit/execute/checkpoint/fail/suspend/resume；`SessionStore` trait | 不接；dsh agent loop 已覆盖；只参考“事件先持久化再推进状态”的顺序 | `apply` 先 append 再 transition，非法迁移留毒事件；标准流程空 IntentGraph；预算只覆盖 LLM | 不适用 | **D** |
| **worker_spawner** (`worker_spawner.rs`) | 真实 demo；spawn Python/Node、NDJSON JSON-RPC、kill；`read_response` 实为阻塞 read_line，无超时/cwd/env/进程组 | 不接；dsh 用 `ctx.subprocess`/child_process + 自己的协议 | CWD 相对路径、阻塞、capabilities 不校验、RustInline/WASM 直接报错 | 不适用 | **D** |
| **export** (`export.rs`) | 真实；`SessionExport` 事件存根/CV/memory/hash/verify/replay；**CLI export 用另一套格式** | 扩展 SuperDSH audit 导出：事件摘要 + CV + hash + artifact 引用；提供 `audit_export` 工具 | 存根无 payload/artifact；replay 用空 DAG；CLI import 是空操作 | 导出→离线重放→hash 校验 | **B/C（S/M）** |
| **memory** (`memory.rs`) | 部分真实；BLAKE3 伪 embedding、激活公式、记忆继承；graph 只在内存 | 只借激活公式（relevance/importance/recency/goal）与 edge 类型；语义检索用真实 embedding | BLAKE3 向量与语义无关；event-store memory 表无读写 API；重启丢失 | 激活公式对回忆排序的增益 | **C** |
| **migration** (`migration.rs`) | 部分真实；跨节点会话状态/CV/事件存根/迁移提交；无网络传输 | 不接；dsh 没有跨节点需求 | 节点 ID `SessionId::from_hex("node-1")` 全零；事件不写 store；无鉴权/冲突解决 | 不适用 | **D** |
| **golden_tests / gen_fixtures** | 真实测试资产；22 个字节级确定性与 fixture 往返测试 | 把方法用于 SuperDSH：为 audit/side-effect/worker 消息建立 golden fixture 与跨版本回放 | 只覆盖 Nexus schema；fixture 需重新生成 | 协议升级后旧日志可读/可验证 | **A/B（测试方法，S）** |

## 2. 安全、成本与内容寻址（8）

| 组件 | 真实度 / 能力 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **budget model** (`types.rs`/`llm_proxy.rs`) | 真实但极简；`BudgetState` 按美分累计，仅在 LLM proxy 预检/扣费；工具/worker/状态机不检查 | 在 `llm/stream` + `tools/execute` 做双层预算：模型按 usage 扣费、工具按调用/时长计费；超限拒绝并审计 | 价格估算偏差；无 tool 级预算；无全局/子代理预算；无 key 时模拟调用也扣费 | 超支率=0、正常任务误杀率；缓存命中是否计费 | **C（TS 重写，S）** |
| **llm_proxy** (`llm_proxy.rs`) | 部分真实；prompt cache、预算预检/扣费、真实 OpenAI/Anthropic/DeepSeek HTTP；无 key 时模拟计划 | 只借“请求 hash 缓存 + 预算闸门 + 审计事件”。在 `llm/stream` 包装：canonical key = provider/model/messages/tools/temp/maxTokens；命中返回缓存并记 audit | cache key 只含 prompt；hit_count 不增；持久化函数未接线；所有响应都写成 PlanProposed；无 streaming/tool calling/重试；无 key 时假计划也扣预算 | 重复提示的命中率/成本；缓存污染（换模型）测试 | **C（缓存/预算，S/M）** |
| **effects** (`effects.rs`) | 真实但未接线；intent/commit、幂等键、Pure/Idempotent/Reversible/Irreversible、recover_effect 策略；**全内存** | **最值得移植**：`tools/pre-execute` 写 intent（callId + class + preconditions），`tools/post-execute` 写 commit/failed；ST 持久化；启动对账；不可逆操作要求审批（PE） | 账本不持久化；compensation 只存不执行；precondition 只认 `"deny"`；无异步取消 | kill -9 在 intent/commit 之间、审批后崩溃、重复调用；重复副作用=0 | **A（TS 移植，M）** |
| **vault** (`vault.rs`) | 真实；BLAKE3 内容寻址、stage/commit/get/rollback/verify_all；索引只在内存 | `artifact_put/get/verify` 工具或内部存储：工具产物、截图、报告、审计附件；索引写 SQLite/storageDomain；hash 校验 | 重启后 index 丢失，文件在也找不到；无并发写锁；无 metadata | 大文件/并发写/重启后 get；篡改检测 | **B（TS 实现，M）** |
| **wasm_worker** (`wasm_worker.rs`) | 部分真实；wasmtime fuel/内存限制、模块校验；**无 WASI/文件/网络**；错误静默回落模拟输出 | 不接；dsh 需要隔离时用容器/独立进程/平台 sandbox | 调用方无法区分真假执行；capability 只比字符串；超时事后检查 | 不适用 | **D** |
| **entropy** (`entropy.rs`) | 真实但未接线；retry/failure/validation 加权 → warning/degradation/halt/circuit_breaker | 运行时健康策略：TR/SE 统计窗口，触发降并发、暂停新任务、要求审批 | 无时间窗口/滞后；动作无执行器；阈值拍脑袋 | 连续故障注入：误熔断 vs 及时止损 | **C（TS 重写，S）** |
| **security / capability** (`security/lib.rs`) | 半真实；HMAC-SHA256 capability token（scope/session/task/expiry）；`permits`/verification | 若接远程 worker/外部工具：给每个任务发短期 capability token，scope 如 `fs:read:<realpath>`、`tool:<name>`；dsh 侧校验 | 路径前缀用 `startsWith`（`/src2` 绕过 `/src`）；Network/SystemExec 分支缺失；无 realpath/symlink 解析 | 越权路径/过期 token/跨 session 重放；必须 0 绕过 | **B（仅 token，S）** |
| **sandbox tier / policy engine** | 名义实现；Tier0 只设环境变量，Tier1/2 空操作；PolicyEngine 不加载 Rego，硬编码 if/else | 不接；dsh 自身 approval/sandbox 才是边界 | 安全剧场；capabilities 信任调用方布尔值 | 不适用 | **D** |

## 3. 存储与传输（5）

| 组件 | 真实度 / 能力 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **EventStore trait + schema** | 真实接口；events/sessions/side_effects/locks/llm_calls/artifacts/memory 8 表 | 只借 schema：审计/副作用/artifact 表；dsh 的 JSONL 保持 canonical；插件 SQLite 用 storageDomain 或 node:sqlite | 事件表无 UPDATE/DELETE 触发器，append-only 非强制；无 migration；半数字段被 StateRow 丢弃 | 表结构与事件完整性/查询性能 | **C（schema 借鉴，S）** |
| **SQLite store** | 部分真实；WAL、append、state；但 `since` 直接报错、乐观锁形同虚设、锁永远成功、side-effect id 丢弃 | 不直接用；若做审计 SQLite，需实现真正的 `UPDATE ... WHERE version=expected` | `INSERT OR REPLACE` 忽略 expected_version；acquire_lock 永远 true；CV/memory/budget 读回默认化 | 并发写/版本冲突/锁竞争 | **C（重写锁，M）** |
| **Postgres store** | 名义实现；schema 一次多语句执行大概率失败；`expected_version` 忽略；未实现 SessionStore | 不接 | 启动不可靠；无版本锁；无集成测试 | 不适用 | **D** |
| **nexus-rpc** | 真实 codec；JSON-RPC/NDJSON、execute/checkpoint/result/cancel；无 server/dispatch/超时/取消 | 外部 worker/远程子代理协议：`dsh` 作为父进程，NDJSON 帧；补 deadline、cancel、capability、错误码、stderr 转发 | 只有 codec；Python/Node worker 未用它；字段容易漂移 | 进程崩溃/半包/超大行/取消；协议一致性 | **B（TS codec/协议，S/M）** |
| **nexus-cli** | 可运行 demo；run/resume/status/export/import/budget；**import/budget-set 空操作，resume 不继续执行，worker 失败进 demo 完成** | 不接；dsh CLI 是入口 | 固定 `~/.nexus/events.db`、worker 路径依赖 CWD、无 timeout、假成功 | 不适用 | **D** |

## 4. 编排与运维（8）

| 组件 | 真实度 / 能力 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **LocalScheduler** | 真实进程内队列；Exclusive 资源锁、max_concurrency；priority 无效、队头阻塞 | 借“资源锁 + 并发闸门”思路，用于插件内部 fanout（如并行子代理/工具调用） | tick 遇锁任务直接 break；Shared 不记账；只返回 TaskId | 并发/锁竞争/队列公平性 | **C（S）** |
| **DockerScheduler** | 部分真实；默认 stub；容器 network=none、readonly；无任务/workspace/结果通道 | 不接；dsh 需要容器时用自身 sandbox/外部 runner | LIFO 调度、镜像缺失、孤儿容器、假启动 | 不适用 | **D** |
| **K8sScheduler / RealK8s** | 生成 PodSpec 或创建无 command/volume/结果通道的 Pod；feature 名不匹配 | 不接 | 创建不可工作的 Pod；无 watch/结果；stub | 不适用 | **D** |
| **Coordinator** | 真实进程内 propose/vote/quorum/commit；无网络、无持久化、converge 空 | 不接；dsh 子代理/agent-team 已覆盖协调 | 假共识；重复票覆盖；无超时 | 不适用 | **D** |
| **MessageBus** | 真实进程内 tokio broadcast + CV 排序；Gossip 只发本地心跳 | 不接；Node EventEmitter/SE 足够 | 无 transport；publish 需订阅者；mark_delivered 未调用 | 不适用 | **D** |
| **Metrics** | 真实 Prometheus 指标定义 15 组；全仓未接线；serve 不监听端口 | 把指标名映射到 dsh telemetry/OTel（S）；不要引 Rust 依赖 | 无 HTTP listener；无调用方 | 指标覆盖/导出格式 | **C（S）** |
| **Temporal** | 占位；无 Temporal SDK；append 无 local_store 时丢事件；workflow 只打日志 | 不接；需要 durable workflow 时直接接 Temporal SDK 或 dsh workflow | 静默丢事件/假完成 | 不适用 | **D** |
| **Phoenix tests** | 26 个测试；事件数组模拟崩溃；**不是实际 kill -9**；报告硬编码 true | 把 8 条 invariant + 崩溃阶段清单改造成 SuperDSH 的 fault-injection 测试：真实杀进程、审计/副作用对账、恢复后不重复 | 非真实进程故障；无 worker/vault/security 覆盖 | 真实 kill -9 × 6 阶段；副作用重复=0；恢复成功定义见 experiments.md | **B（测试方法，M）** |

## 5. Workers / SDK / Adapters（8）

| 组件 | 真实度 / 能力 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **Python worker** | 真实执行器；NDJSON JSON-RPC；read/write/grep/run_command；capabilities 只记录、无 timeout、`shell=True`、BLAKE2b 冒充 BLAKE3 | 外部工具 runner：dsh 通过 child_process + JSON-RPC 驱动；补命令白名单/沙箱、timeout+SIGKILL、能力校验、正确 BLAKE3、artifact 内容回传 | RCE 风险；hash 错误；checkpoint 重复；cancel 无效 | 超时/崩溃/越权命令/大输出 | **B（加固后，M）** |
| **Node worker** | 真实 dispatch，但 `createHash('blake2b256')` 在 Node 24 不支持，所有 artifact 动作报假错误 | 不接；同语言可直接用 dsh subprocess | 假失败；无沙箱；无 timeout | 修复 hash 后 smoke；否则不适用 | **D（现版本）** |
| **Rust worker** | 真实单动作；BLAKE3 正确；无 plan/mkdir/沙箱/timeout | 不接；Node 已等价 | 能力有限；Windows cmd 注入面 | 不适用 | **D/C** |
| **Python SDK** | 旁路真实；自建 SQLite schema 与 Rust 不兼容；无状态机/replay；worker stderr 死锁风险 | 不接；dsh SDK 是唯一入口 | schema 冲突；resume 不重放；预算不强制 | 不适用 | **D** |
| **Node SDK** | **纯内存 mock**；`Session.run()` 硬编码状态、不执行工具/worker/LLM；`NexusRuntime` 不存在 | 不接；最多抄 API 命名 | 接入后看起来完整但零执行 | 不适用 | **D** |
| **Rust SDK** | 半成品；create_session 不写 store，resume 直接把状态设 Executing | 不接 | resume 语义错误 | 不适用 | **D** |
| **OpenClaw adapter** | 数据 shim；只拼 HTTP payload，从不发请求；未初始化会 panic | 不接；若要接 OpenClaw 自写 HTTP/WS | 假对接；全零 session | 不适用 | **D** |
| **Hermes adapter** | checkpoint 文件 shim；固定 TaskId 0xAA、CV 按 step、artifacts 空 | 只借 checkpoint 文件交换格式 | 固定 ID/CV 语义错误；不写事件库 | 文件往返/跨 session import | **C/D** |

## 对 dsh 的最终路线

### P0（1–3 天，最高 ROI，全部 TS 重写）

1. **副作用账本**（effects）：`tools/pre-execute` 写 intent，`tools/post-execute` 写 commit/failed；ST 持久化；启动对账；不可逆操作走审批。实验：kill -9 在 intent/commit 之间，重复副作用必须 0。
2. **内容寻址 artifact**（vault）：BLAKE3/SHA-256 + 持久化索引 + `artifact_get/verify`；接入 deliverable/截图/报告。实验：重启后可取、篡改可检出。
3. **审计扩展**（event/CV/export）：在现有 hash chain 上加 causal vector 与导出验证；不引入 Nexus schema。实验：多子代理并发、导出后离线验证。
4. **测试方法**（golden fixtures + Phoenix 清单）：为 audit/副作用/worker 协议建立真实故障注入，而不是内部 replay。

### P1（1–2 周）

5. **worker/远程工具协议**：NDJSON JSON-RPC + deadline/cancel/capability + stderr 转发；只作为 dsh 外部 runner，不做 Nexus 服务。
6. **capability token**：HMAC 短期票据，scope 用 realpath + 分隔符边界；只用于远程 worker/工具，不替代 dsh approval。
7. **recovery 对账**：只恢复“下一个待执行动作”，不声称恢复进行中的 tool call；报告不得硬编码 true。
8. **LLM 缓存/预算**：仅在批处理/评估等重复 prompt 场景启用；key 必须含 model/tools/temp/maxTokens。

### 明确不做

- Nexus CLI 作为服务、Postgres store、Temporal/Coordinator/MessageBus、Docker/K8s scheduler、WASM sandbox、SandboxTier/PolicyEngine、Node SDK、Python SDK 混用 DB、OpenClaw/Hermes 假网关。
- 任何“Rust 内核直接嵌入 dsh”的方案：没有绑定/daemon，必须新写 sidecar，成本 L，且会与 dsh 自己的 session/persistence 重复。

## 统计

- 40 个组件中：**A 级 1 个**（effects 移植）、**B 级 9 个**、**C 级 11 个**、**D 级 19 个**。
- 真正确认“实现与 README 一致且可直接支撑生产”的组件极少；多数是“库已写、未接线”或“骨架”。
- 对 dsh 的最高价值不是运行 Nexus，而是把它的**不变量**变成 SuperDSH 的测试与账本。
