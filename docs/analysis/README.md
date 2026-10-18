# 全量增强分析：把两个项目逐项映射到 dsh

这份分析回答一个问题：**awesome-agent-infra 的 48 个包、nexus-runtime 的 40 个组件，每一个能不能用来增强 dsh，具体怎么接，需要先修什么，值不值得做。**

不是“挑几个做”，而是全量清点后再分层：能直接做、修复后能做、只能借思路重写、明确不做。每一项都给出 dsh seam、前置条件、实验和结论标签。

- [awesome-agent-infra 全量分析](awesome-agent-infra.md) — 48 个包
- [nexus-runtime 全量分析](nexus-runtime.md) — 40 个组件
- [机器可读矩阵](matrix.json) — 名称、类别、结论、工作量

## 统计

| 来源 | 组件数 | A 直接做 | B 修复后做 | C 借鉴/重写 | D 不接 |
|---|---:|---:|---:|---:|---:|
| awesome-agent-infra | 48 | 3 | 16 | 18 | 11 |
| nexus-runtime | 40 | 1 | 9 | 11 | 19 |
| **合计** | **88** | **4** | **25** | **29** | **30** |

（A/B 的边界按“当前代码是否需要先改核心逻辑”划分；C 是“不能直接用，但设计/算法值得重写”；D 是“重复 dsh、mock、安全剧场或无可测收益”。）

## 0.2/0.3/0.4 已落地的项目

以下分析项已经在 0.2–0.4 中实现，并通过确定性测试/真实 dsh 冒烟（不代表全部 B 项都已完成）：

| 已落地 | 来源 | 说明 |
|---|---|---|
| `fuzzy_edit` | awesome `fuzzy-patch` | 已有 80 例、90% 正确的实验 |
| `apply_patch` | awesome `txn-fs` 思路 | 全量预检 + 失败逆序回滚 + 跨进程文件锁；未复制有 bug 的实现 |
| Memory v2 | awesome `agent-memory`/`memory-engine-v2`/`memory-graph`/`embedding`/`retrieval-feedback` 思路 | 分层、session working、confidence/feedback、因果 stale、确定性巩固、TTL/MEMORY.md；无伪 embedding |
| 会话便签 | awesome `notes-manager` | 修复路径穿越/坏行/无效压缩 |
| 错误修复记忆 | awesome `healix` 思路 | 归一化错误签名 + 跨会话 hint + post-execute 注入；重写匹配 |
| 日志归档保留 | awesome `archiver` 思路 | gzip + SHA-256 manifest + 校验删除/恢复；修复路径穿越 |
| repo map + `search_code` | awesome `codegraph`/`agentic-search` 思路 | 轻量 regex 索引重写，修复同名符号/缓存；`search_code` 基于 E8 实验（hit@5 80%→100%）加入 |
| 版本化知识库 | awesome `knowledge-vault` 思路 | JSONL 版本链、trust、TTL、tombstone |
| effects 账本 + 恢复计划 | nexus `effects`/`recovery` | intent/commit、`effect_reconcile`/`effect_resolve`、重启对账、kill-9 验证 |
| artifact store | nexus `vault` | SHA-256 内容寻址、原子写、重验 |
| 审计哈希链 + 签名 + 导出 | nexus event/audit/security | `audit_verify`/`audit_evidence`/`audit_export`、HMAC、golden fixture |
| handoff + replay plan | nexus `checkpoint`/`export` | 确定性报告 + 机器可读 `replay_plan` |
| history compact | awesome `history-compact` | 受预算约束的确定性压缩，含 ratio |
| reflection | awesome `learning-nudge` 思路 | 确定性重复调用/错误/未验证修改报告 |
| budget + reserve/settle | nexus `budget` | 状态统计、预留/结算、可选 enforce |
| capability token / causal clock / worker protocol | nexus security/types/RPC | 纯 TS 库，有测试，暂不作为模型工具 |
| 验证闸门 | dsh/nexus 不变量 | 已实验，无增益，保持 opt-in |

仍未实现的主要是 C/D 类：Nexus 运行时/worker/SDK、codegraph 原实现、embedding/memory v2、valid8、reasoning-search、POMDP、process-reward、dynamic-workflow、branch 等。它们要么需要重写核心，要么属于已拒绝的安全/正确性问题。

## 怎么看“能不能做”

我们把“能做”拆成四种，而不是一句“可以”：

1. **直接做（A）**：代码语义可信，接一个 dsh seam 就能用；1–2 天内可交付，实验可确定性验证。
2. **修复后做（B）**：有明确的核心 bug/缺口（回滚、符号 ID、打包、路径安全、锁、增量合并等）；修复清单可枚举，修完有可测收益。
3. **借鉴重写（C）**：原实现不可靠或与 dsh 模型不匹配，但算法/协议/schema 值得在 TS 侧重写；不复制源码。
4. **不接（D）**：mock、占位、重复 dsh 已有更强能力，或安全声明不成立；除非前置条件全部重做，否则不进入路线。

## dsh 的 seam 地图

所有接入点都必须是 dsh 的公开 seam；不依赖内部类，不改 Session 事件词汇。

| dsh seam | 适合接入的能力 | 代表组件 |
|---|---|---|
| `ctx.tools.register`（T） | 新工具、补丁、检索、验证、记忆、便签、知识库、artifact | fuzzy-patch, txn-fs, codegraph, notes-manager, project-memory, knowledge-vault |
| `tools/pre-execute` / `ctx.tools.guard` | 权限、风险分类、副作用 intent、审批 | guardrail, effects, capability token |
| `tools/post-execute` | 纠错、验证闭环、副作用 commit、错误分类 | valid8, healix, effects, verify |
| `tools/result` | 指标、审计、健康度、重复调用检测 | tracing, entropy, archiver, audit |
| `agent/pre-step` | 记忆注入、技能注入、上下文裁剪 | agent-memory, embedding, memory-graph, skillforge |
| `agent/turn-stopping` | 完成定义、目标验证、反思 | goal-verifier（重写）, verify, learning-nudge |
| `agent/request` / `llm/stream` | 模型路由、预算、缓存、best-of-N、置信度 | nexus llm_proxy, confidence-gate, max-mode-sampler |
| `ctx.systemPrompt` | 持久规则、人设、项目约定 | project-memory, knowledge-vault |
| `session/event` | 审计、事件归档、指标、旁路日志 | evidence-log, audit, archiver, event-bus |
| `storageDomain` | 插件自有持久状态（不污染 Session 词汇） | memory, effects ledger, knowledge-vault, artifact index |
| `ctx.compaction` | 确定性压缩、摘要 fallback、检查点 | history-compact, cycle-controller, checkpoint-writer |
| `ctx.subagents` / `ctx.workflowEngine` | 并行/分叉/外部 worker/多方案 | worker, branch, dynamic-workflow, max-mode-sampler, llm-dag-generator |
| `ctx.skills` | 技能库、curation、蒸馏 | skillforge, skill-curator, dreamdistill |
| `ctx.shell` / `ctx.subprocess` / sandbox | 代码执行、外部 runner、容器 | code-sandbox（非安全边界）, nexus workers |
| `ctx.mcp` / MCP client | 外部 MCP 工具 | mcp-client, mcp-codegraph |
| `ctx.sessionQuery` / `ctx.sessionPersistence` | 会话检索、导出、重放 | replay（不接）, nexus export, evidence-log |
| `ctx.telemetry` / OTel | 指标与链路追踪 | nexus-metrics, tracing（Node ESM 下失效） |
| `ctx.lsp` | 语言级导航 | codegraph/mcp-codegraph（与 LSP 互补） |

## 最高优先级：真正值得补的能力

按“用户价值 × 可验证性 × 风险”排序，而不是按包的数量。

### P0（1–3 天，建议下一批实现）

1. **副作用账本（nexus effects 移植）**  
   dsh 已有工具 checkpoint 和 `TOOL_OUTCOME_UNKNOWN`，但没有形式化的 effect class / idempotency ledger / intent-commit。  
   落点：PE/PO + ST；工具名分类；callId 幂等；不可逆操作要求审批。  
   实验：在 intent 后、执行后、commit 前分别 kill -9；恢复后重复副作用次数必须为 0，未知状态必须被标记。

2. **内容寻址 artifact（nexus vault）**  
   落点：`artifact_put/get/verify` 工具 + ST/SQLite 索引；BLAKE3 或 SHA-256。  
   实验：重启后仍可 get；篡改文件必须 verify 失败；并发写不丢索引。

3. **确定性历史压缩 fallback（history-compact）**  
   落点：CMP/PS；把 dsh 事件映射为整轮折叠，模型摘要失败或超预算时启用。  
   实验：token 减少 ≥40% 且任务成功率不下降；与模型摘要做 A/B。

4. **会话 scratchpad（notes-manager 修复版）**  
   落点：T + CMP；记录 discovery/error/decision；sessionId 清洗、路径白名单、坏行隔离。  
   实验：长任务重复探索次数、任务成功率、上下文 token。

5. **记忆检索过滤（retrieval-feedback）**  
   落点：现有 memory 的 search 后处理；过期/不可注入/使用因子。  
   实验：注入过期条目的比例、recall@k 变化。

### P1（1–2 周）

6. **可证明的 repo map（codegraph/mcp-codegraph 修复版）**  
   先修符号 ID（加文件路径）、缓存 mtime、文件排序、root 白名单、打包。  
   落点：T（`repo_map`/`find_symbol`/`impact_of`）。  
   实验：30 条查询 hit@5 vs grep+LSP；3 个修改任务的工具调用/token/成功率。

7. **多文件事务编辑（txn-fs 修复版）**  
   先修 rollback（恢复 baseline 而非 staged）、空文件、删除、原子写、路径锁。  
   落点：新 `apply_patch` 工具 + PE 审批 + SE 审计。  
   实验：三路合并语料；冲突回滚后文件 hash 必须等于 baseline；0 数据污染。

8. **版本化知识库（knowledge-vault 修复版）**  
   先修 id 冲突、派生边历史、TTL、事务。  
   落点：T + ST；只注入 `latestTrusted()`。  
   实验：矛盾事实/回滚/过期场景的注入准确率。

9. **会话结束反思（learning-nudge 修复版）**  
   落点：TS/SE + memory/skills；按 session 隔离计数；修 `user_authored`。  
   实验：跨会话事实捕获率、重复错误率。

10. **内容寻址证据链（evidence-log）**  
    落点：SE + ST；可作为现有 audit 的第二实现或补强。  
    实验：篡改/缺失/重放；与 hash chain 对比。

### P2（2–6 周，需要重写核心）

- **embedding/memory v2**：先修 df/CJK/remove，再做真正的语义检索；否则不上。
- **checkpoint-writer**：修增量 merge、原子写、截断策略；用于 handoff。
- **max-mode-sampler**：接预算/温度/超时；用于高风险规划。
- **state-machine + taskdag**：只在插件侧工作流使用，不替换 dsh session。
- **llm-dag-generator**：修图校验/fallback/K 候选后再接 plan。
- **外部 worker 协议（nexus RPC + Python worker 加固）**：只作为扩展 runner，不做 Nexus 服务。
- **capability token**：仅远程 worker/工具；必须 realpath + 边界校验。

## 明确不做（及原因）

- **Nexus 作为运行时/服务**：没有 N-API/HTTP daemon，CLI 是 demo；`resume` 不继续执行，`import` 空操作；与 dsh 的 session/persistence 重复。
- **Node SDK**：纯内存 mock，零执行。
- **Postgres/Temporal/Coordinator/MessageBus/Docker/K8s**：骨架/无 transport；dsh 有更强的 subagent/workflow。
- **WASM/SandboxTier/PolicyEngine**：不是安全边界；静默回落模拟或只设环境变量。
- **hallucination-detector/process-reward/agent-metacog 校准器**：内部一致性/假训练/随机噪声，不能作为事实或质量判断。
- **code-sandbox**：不是对抗性沙箱；需要隔离时用容器/独立进程。
- **dynamic-workflow/branch/event-bus/worker/engine-db**：`resume` 断裂、merge 空壳、批量序号错误、缺失 DDL；dsh 已有同类更强实现。
- **tracing/replay/mcp-client**：Node ESM 下 OTel 失效、getter 返回空、dsh 已有 MCP/telemetry。
- **goal-verifier 现实现**：会在重试上限直接返回 satisfied，不能用来判完成；完成定义应运行测试/检查文件。

## 交叉发现（比单个包更重要）

1. **线覆盖率高 ≠ 行为可信**：多个包 100% 行覆盖，但测试不在 tsconfig 里、使用 no-op mock、把错误行为固化为断言（agentic-search 的 target、state-machine 的 timeout、worker 的 concurrency）。
2. **“零依赖”不等于“可直接运行”**：extensionless import、`workspace:*`、未发布的私有包、Node ESM 解析问题，需要 bundler/vendor。
3. **Nexus 是设计蓝图，不是可嵌入运行时**：真正值得拿的是不变量、schema、协议和故障注入方法，不是二进制。
4. **dsh 已有能力不要重复**：session JSONL、checkpoint、compaction、subagents、workflow、skills、MCP、LSP、approval/sandbox 都比多数包成熟。增强应补空白，不应替换。
5. **安全边界必须明确**：fuzzy 编辑、审计链、capability token、code sandbox、WASM 都有各自的边界；不要把它们宣传成“安全沙箱”或“不可伪造审计”。

## 推荐路线图

| 阶段 | 内容 | 成功标准 |
|---|---|---|
| 已完成 | fuzzy_edit、项目记忆、审计账本、验证闸门（opt-in） | 已有实验：90% 补丁、2/2 记忆、4/4 审计检测；验证闸门无增益 |
| P0 | 副作用账本、artifact、history-compact、notes、retrieval-feedback | 每项有确定性故障注入/基准；0 数据污染/0 重复副作用 |
| P1 | repo map、txn-fs、knowledge-vault、learning-nudge、evidence-log | 每项有 A/B 或 hit@k；不通过就不默认 |
| P2 | embedding/memory v2、checkpoint-writer、max-mode、worker 协议、capability token | 先修核心 bug，再跑实验；未通过保持 opt-in |
| 不做 | 上文 D 类 | 记录在 decisions.md |

## 与现有 SuperDSH 的关系

现有 `fuzzy_edit`、memory、audit、verify 不变；本分析是**下一阶段的候选池**，不是一次性全做。每一项进入实现前必须补齐：

- 前置修复清单（本文已列）；
- 一个基线、一个护栏、一个决策规则；
- 失败时保持 opt-in 或回退，不污染现有默认。

这也是对“根据实验确认是否增强”的延续：全量分析给出“能做/怎么做”，实验决定“是否默认开启”。
