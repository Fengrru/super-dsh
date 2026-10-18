# awesome-agent-infra：48 个包的全量接入分析

本文对 `awesome-agent-infra` 的**全部 48 个包**逐个评估：实现是否真实、能否接到 dsh、具体接在哪个 seam、需要先修什么、用什么实验判断、最终结论。

> 结论标签：**A 直接做**（低风险，1–2 天）· **B 修复后做**（有明确前置修复，3–7 天）· **C 借鉴重写**（源码不可直接用，思路可移植）· **D 不接**（重复、mock、失效或无可测收益）。
>
> dsh seam 缩写：T=工具注册 · C=命令 · SP=系统提示词 · PS=`agent/pre-step` · RQ=`agent/request` · LS=`llm/stream` · TS=`agent/turn-stopping` · PE/PO/TR=`tools/pre-execute`/`post-execute`/`result` · SE=`session/event` · ST=`storageDomain` · CMP=`ctx.compaction` · SUB=子代理 · WF=`workflowEngine` · SK=`ctx.skills` · FS=文件系统 intent · SH=shell/subprocess。

## A. 文件、补丁与代码智能（4）

| 包 | 真实实现 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **fuzzy-patch** | 8 策略模糊匹配，纯函数；值字面量护栏；单文件 | 已作为 `fuzzy_edit` 工具（T + FS）；经 `ctx.fs.editText` 保留原子性/观测/沙箱策略 | 上游缺边界守卫（会吞 `}`/换行），已在 `src/fuzzy-apply.ts` 加锚点/Token/唯一性护栏 | 80 例漂移语料：33.8%→90%，0 错改 | **A 已发布** |
| **txn-fs** | 内存模拟 + 真实 FS 两套；三路合并；TOCTOU 校验 | 新工具 `apply_patch`/`txn_edit`：多文件 staging → 审批（PE）→ 原子写（temp+rename）→ SE 审计；冲突时返回 diff | `RealGitTransactionManager.rollback()` 写的是 **propose 后的新内容**，冲突回滚会污染文件；空文件无法写入；无删除；非原子；`readFile` 吞权限错误 | 三路合并语料 + 冲突/回滚/崩溃；错写率必须为 0 | **B 修复后做** |
| **codegraph** | 代码符号图、PageRank、ego graph、impact、增量；regex/tree-sitter | `repo_map`/`find_symbol`/`impact_of` 工具（T）；编辑前查 callers/impact（PE 提示） | 符号 ID 不含文件路径，同名符号跨文件覆盖；`build()` 命中持久化图不校验 mtime；无真实 watcher；tree-sitter 依赖未声明 | 3 个仓库的 symbol hit@5 / file hit@5 vs grep+LSP；agent 任务 token/轮次 | **B 修复后做** |
| **mcp-codegraph** | 真实 MCP stdio server（JSON-RPC/NDJSON），`where_is`/`who_calls`/`impact_of`；e2e 测试最完整 | 作为 MCP server 接入 dsh 的 MCP 客户端；或直接 vendor 三个函数注册为工具（T） | 未声明 codegraph 依赖、无 tsconfig/dist、bin 指向 .ts；root 无白名单；rejected Promise 永久缓存；2000 文件静默截断 | MCP 端到端 + 大仓库索引时延 + 路径越界测试 | **B（最快代码图路径）** |

**实现蓝图（codegraph/mcp-codegraph）**：先修 `makeSymbolId` 加相对路径、`build()` 按 mtime 校验、文件遍历排序、`maxFiles` 上限；工具输出限制为 `{symbol,kind,file,line,score}`。实验先做离线检索（queries 30 条），再跑 3 个“定位并修改函数”的 agent 任务，比较工具调用数、token、成功率。

## B. 记忆、知识与压缩（13）

| 包 | 真实实现 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **agent-memory** | 4 层记忆 + Ebbinghaus 衰减 + token 预算组装 | 合并进 SuperDSH memory v2：L1 工作集/L2 摘要/L3 长期/L4 规则；ST 持久化；PS 注入 | 依赖 `memory-engine-v2`（workspace:*，npm 不可用）；只有内存态；bridge 不序列化 engine；语义召回弱 | 与当前 JSONL 记忆对比 recall@3、注入 token、跨会话保留 | **B/C** |
| **memory-engine-v2** | 5 层 + sleep consolidation + attention 检索 | 只借“分层 + 巩固”结构；重写持久化和召回 | 依赖私有 `internal-tfidf`；`Math.random` 巩固；recall 无条件 `recordResult(true)` 造成伪信号；无持久化 | 关闭巩固/开启巩固的召回稳定性；伪信号检测 | **C 借鉴** |
| **memory-graph** | CoW 因果图、BFS 级联失效、冲突检测 | 作为 memory v2 的内存索引：记忆条目为节点，来源/依赖为边；更新时 cascadeInvalidate；ST 存图 | 无 `toJSON/fromJSON`；节点/边只在内存；无法接真实存储 | 矛盾事实注入后的 stale 命中率；删除上游后的下游失效 | **B/C** |
| **embedding** | TF-IDF + n-gram + Camel/snake + hybrid（文本/图/向量） | `semantic_search` 工具（T）覆盖仓库与记忆；或作为 memory 检索后端 | `df` 按词频而非文档频次累加；重复 add 不撤销旧 df；remove 只减一次；CJK 被清空；`vectorScore=textScore` | 30 条代码/记忆查询 hit@5 vs grep；中文查询 | **B 修复后做** |
| **internal-tfidf** | 纯函数 tokenize/IDF/向量/余弦 | 替换 SuperDSH memory 里的内联打分，统一 tokenizer | ASCII-only；不等长数组返回 NaN；无序列化；与 embedding 两套实现 | 边界单测 + CJK/标识符查询 | **B（小）** |
| **project-memory** | MEMORY.md 读写、解析、promotion、搜索 | 作为人类可读的项目记忆文件：`memory_export/import` 工具；或让 MEMORY.md 成为 canonical 存储 | round-trip 丢 `verification_count/source_sessions/user_authored/created_at`；整文件写无锁；解析是 YAML 子集 | 人改 MEMORY.md 后的 round-trip 保真；并发写 | **B** |
| **agent-checkpoint** | L1/L2/L3 内存快照 + 5MB LRU | 只借快照 schema；dsh 已有 session checkpoint/persistence | 不采集、不写盘、无链式恢复；`validateSize` 结果被丢弃；L3 上限 10KB 反而更小；ID 同毫秒碰撞 | 无需独立实验；若做则测恢复点完整性 | **C/D** |
| **checkpoint-writer** | LLM 提取 11 字段 + 正则 fallback + discovery promotion | `/handoff` 或 `session_checkpoint` 工具：把当前会话压成结构化状态；ST 存储；下一会话 PS 注入 | 增量不 merge（丢旧字段）；截断先丢最新对话；版本仅内存；无原子写；`maxTokens/temperature/persistToDB` 未接线 | 跨会话 handoff 任务完成率 vs 纯历史；摘要 token | **B 修复后做** |
| **notes-manager** | 按 session 的 JSONL scratchpad | `note_append/note_read/note_compact` 工具（T）；长任务记录 discovery/error/decision；作为 CMP 输入 | sessionId 未清洗（路径穿越）；一行坏 JSON 导致 `readAll` 返回空；无真正 compaction；无锁 | 长会话（>50 步）任务成功率/重复探索次数 | **B（安全修复）** |
| **knowledge-vault** | SQLite append-only 版本链 + 派生边 + 信任状态 + outcome 指标 | `knowledge_add/search/verify` 工具；只注入 `latestTrusted()`；ST/SQLite；按 session/trace 记 provenance | id 只哈希 name/kind/content，内容回滚会主键冲突；新版本删除旧派生边；TTL 不生效；无迁移/锁 | 知识冲突/回滚/过期；trusted 注入的准确率 | **B** |
| **retrieval-feedback** | `isExpired`/`injectable`/`usageFactor` 三个纯函数 | 直接用于 memory/knowledge 检索后的过滤与重排 | 仅 type-only 依赖；价值小但零风险 | 注入过期/低使用条目的比例 | **A（小）** |
| **evidence-log** | 内容寻址 append-only 日志 + `verifyEvidence` | 审计/证据链：可作为 SuperDSH audit 的第二实现；或把工具结果写入证据表 | SQLite 形状是 Bun 风格 `query`，Node 需 adapter；旧行无 hash 判 invalid | 篡改/缺失证据检测（与现有 hash chain 对比） | **B/A** |
| **history-compact** | 确定性按 round 压缩，纯函数，5KB | CMP fallback：模型摘要失败/超预算时按整轮折叠；PS 注入压缩后的历史 | 需要把 dsh 事件映射成 `turn/done/step/result` 并提供 reconstruct；无 LLM 摘要的语义损失 | token 减少率 + 任务成功率保持；与 dsh 摘要对比 | **A/B** |

## C. 验证、安全与审计（7）

| 包 | 真实实现 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **valid8** | 4 层验证（syntax/semantic/runtime/security）+ 可选 LLM/扫描器 | `validate_output` 工具或 PO 门禁：只启用 runtime/security 层，对生成代码做低成本检查 | syntax 层把 `any`/`console`/空 catch 都算 issue，误报高；security 是字符串包含匹配，可绕过；semgrep/bandit 可选 | 误报率（正常代码）与真错捕获率；执行成本 | **B（窄化后）** |
| **guardrail** | 指标阈值 → CONTINUE/ALERT/DEGRADE/PAUSE/ROLLBACK/TERMINATE | 运行时健康策略：TR/SE 聚合工具失败率、重试率，触发降并发/暂停/人工审批 | 只返回枚举，不执行；阈值无窗口/滞后；容易误熔断 | 注入连续失败工具，误暂停率 vs 及时止损率 | **C** |
| **healix** | 错误分类 + 哈希匹配 + 修复规则记忆 | PO 纠错提示：按 dsh 错误码/工具名分类，注入 repair hint；规则持久化 | 精确哈希 tier 实际与 `recovery_action` 比较；匹配实现错误；学习信号弱 | 重复错误率下降；错误分类准确率 | **C（重写匹配）** |
| **goal-verifier** | LLM 验证或 DAG 计数启发式 | 不接；用“运行测试/检查文件”的证据验证替代（已有 verify gate） | 无 LLM 时只看 completed/total；`retryCount>=maxRetries` 直接 satisfied；temperature/maxTokens/model 未传 | 若重写：假完成率（必须为 0） | **D 现实现 / C 概念** |
| **confidence-gate** | ECE/Brier/温度缩放/动态阈值 | 仅离线校准：对已有标注的 agent 输出做置信度校准；不要用它判断事实 | 需要 raw confidence + 正确性标签；`fit()` 会裁剪 ECE/Brier/Pearson，污染报表 | 标注集上的 ECE/Brier；阈值收益 | **C（离线）** |
| **hallucination-detector** | TF-IDF/Jaccard claim 一致性；spectral 死代码 | 不接；若需要事实性，用测试/检索/工具证据 | 内部一致性≠事实；spectral 从未被 detect 调用；无外部证据 | 不适用 | **D** |
| **code-sandbox** | 子进程跑 Node + Math/Code/Logic verifier | 不当作安全边界；可借 VerifierPool 跑测试型代码题 | `node:vm` 非安全隔离；spawn `node` 而非 `process.execPath`；测试覆盖逃逸但非对抗性 | 若用：逃逸测试 + 资源限制；不建议 | **D 安全 / C 验证器** |

## D. 搜索、推理与规划（5）

| 包 | 真实实现 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **agentic-search** | intent→strategy→执行→融合；内置 code_symbol/code_graph/semantic 工具 | 重写为 dsh 工具编排：grep/glob/LSP/codegraph；PS 里指导按意图选工具 | target 提取错误（取最后一个词）；`trace_call` 依赖传参错误；parallel 未实现；多个工具名无实现；超时定时器未清理 | 30 条导航查询的命中率/工具调用数 vs 模型自选 | **C 重写** |
| **reasoning-search** | 6 种策略（MCTS/beam/importance/best_of_n...）+ 指标 + 幻觉抑制 | 仅 best_of_n 有实用价值：WF/子代理并行采样 + 独立 judge；MCTS 需重写 | general 任务非空即完成；MCTS 重复 expand/未访问路径；finalScore 恒 0；RNG 未 seed；幻觉抑制 `includes("YES")` 误判 | pass@1 vs pass@N 与成本；轨迹可复现性 | **C** |
| **pomdp-planner** | QMDP + 粒子滤波 + rollout；无 LLM | 不接；若做不确定动作选择，需要真实观测模型和 seeded RNG | belief 退化；观测是字符串精确匹配；用单状态而非 belief 推进；随机 | 不适用 | **C/D** |
| **process-reward** | 启发式 step 打分/标签/“训练” | 不接；若要 PRM，接真实模型与标注数据 | 注册 scorer/cache 未使用；trainer 标签泄漏；validate 不验证学习；随机 shuffle | 不适用 | **D** |
| **agent-metacog** | 交互记账 + 知识边界/遗忘提醒 + 校准器 | 只借 Metacog 记账（知识边界/遗忘告警），不要用 calibrator | 训练是随机噪声；ECE 用 token 阈值伪标签；无可泛化模型 | 知识边界告警准确率（人工标注） | **C/D** |

## E. 编排与执行（9）

| 包 | 真实实现 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **taskdag** | DAG 校验/ready/failed/替换子树/成本；无执行器 | 插件内部 DAG 校验：plan 工具或 WF；失败级联需自己 `getTransitiveDependents` | `markNodeFailed` 只阻塞直接后继；`replaceSubtree` 修改入参；无执行/调度 | DAG 校验正确性；失败级联测试 | **C** |
| **state-machine** | 14 状态/47 迁移 FSM，guards、快照、指标 | 不替换 dsh session 状态；可用于插件子工作流/副作用账本状态 | 每迁移创建 30s timer 不清理；超时后 transition 继续改状态；无并发串行化；ERROR 旁路 | 并发/超时/恢复一致性 | **C** |
| **event-bus** | 优先级批量事件总线 + waitForEvent + 持久化回调 | dsh 已有 session event；插件内部如需 pubsub 可用 Node EventEmitter | 批量持久化 sequence 全部取批次末值；持久化异常静默；shutdown 后丢弃；无背压 | 批量事件序号/失败注入 | **D/C** |
| **worker** | 进程内池（capability 路由）+ worker_threads 池 | dsh 子代理/shell 更强；只借全局 semaphore/取消思路 | `options.concurrency` 未读；pre-abort 泄漏 activeCount；超时不取消 handler；True pool 运行中不超时 | 并发上限/取消/崩溃恢复 | **C/D** |
| **dynamic-workflow** | VM 沙箱 JS 编排（agent/parallel/pipeline） | 不接；dsh `workflowEngine` 已有安全编排 | `resume()` 缺 scriptPath 不可用；checkpoint 只存 lastResult；vm 非安全边界；file primitives 无根约束 | 不适用 | **D** |
| **llm-dag-generator** | LLM 生成 DAG + fallback + replan + K 候选 | `plan` 工具/WF：生成 dsh plan DAG；fallback 仅作无模型兜底 | fallback edges 索引错；K 候选 dependencies 悬空；无环/白名单校验；model/temperature 未传 | plan 有效率（无悬空/环）；replan 成功率 | **C 修复后** |
| **lifecycle-manager** | 模块 onEnter/onExit/onPhase 钩子，priority 排序 | 插件内部模块生命周期；dsh Cordis `ctx.effect` 已覆盖大部分 | dependsOn 未实现；只自动 hook onEnter；错误仅 warn | 钩子顺序/失败隔离 | **C/D** |
| **max-mode-sampler** | Best-of-N 方案 + LLM judge + 启发式回退 | WF/子代理并行生成 N 个 plan，独立 judge 选一个；RQ/LS 控制预算 | 温度/maxTokens/超时配置全未用；judge 输出校验弱；无预算/并发上限 | 方案质量 vs 单方案；成本/延迟 | **B/C** |
| **branch** | 会话 fork/merge/abandon 注册表 + DB 复制回调 | dsh 已有 session fork/subagent；若要分支树，用 SE/ST 重建 | merge 只改状态不合并；`session_` 前缀二次拼接；UUID fallback 测试是假的；DB 失败不回滚 | fork 并发/复制完整性 | **D** |

## F. 自演化与技能（4）

| 包 | 真实实现 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **skillforge** | SKILL.md 创建/加载/L0/L1/L2 + 管理 | dsh 已有 `ctx.skills`；可做导入/导出或技能市场适配 | 同名覆盖无版本；frontmatter 子集；搜索前不扫描；无锁 | 技能发现/覆盖/导入 | **C** |
| **skill-curator** | archive stale/pin frequent/quality review | 作为技能库维护任务（JOB）：标记 stale、pin 高频；不自动删除 | 依赖 skillforge 接口；LLM 质量评审可选；启发式 | stale 技能清理率 + 误归档率 | **C** |
| **dreamdistill** | 7 天 Dream 记忆合并 + 30 天 Distill 产技能 | 定时任务（JOB）+ memory v2 巩固；只借“合并/衰减/蒸馏”策略 | 定时器 `distill([])`；路径正则误删；全删全插无事务；interval 提前消耗 | 记忆压缩率、冲突解决、技能质量 | **C/D** |
| **learning-nudge** | 工具计数/模式/会话结束触发 LLM 反思，写 memory/skill | SE/TS 触发反思；写入 memory/skill；用户声明即时保存 | `user_authored` 写 false；maxConcurrent 未用；计数不按 session 隔离；无锁 | 持久事实捕获率；错误重复率 | **B** |

## G. 基础设施（6）

| 包 | 真实实现 | dsh 落点 / 怎么做 | 前置修复与风险 | 实验 | 结论 |
|---|---|---|---|---|---|
| **cycle-controller** | token 使用率→NOOP/CHECKPOINT/REBUILD 策略 | dsh CMP 已做上下文压缩；只借“阈值+检查点”提醒 | 只是策略，`executeRebuild` 依赖外部 callback；无循环检测 | 不适用 | **C/D** |
| **tracing** | OTel 抽象 + no-op fallback | dsh 已有 telemetry/OTel；不要引入第二个 tracer | Node ESM 下 `require()` 失效，OTel 永远 no-op；参数未使用 | 不适用 | **D** |
| **replay** | 事件重放三种模式 + trajectory/differences | dsh session log 已可重放；不接 | getter 直接返回 `[]`；dry-run 仍调用 transition；无持久化 | 不适用 | **D** |
| **archiver** | 热/冷归档 + gzip + DB 删除 | 审计/记忆日志轮转：CSP 风格 cold storage；插件 JOB | archiveId 路径穿越；无 manifest/checksum；删除失败仍成功；全量 JSON.stringify | 归档/恢复完整性；内存峰值 | **C/B（先修安全）** |
| **mcp-client** | stdio + HTTP MCP 客户端，工具发现/超时 | dsh 已有 `dsh-mcp-client`；不重复 | 只覆盖 tools；无 resources/prompts/重连 | 不适用 | **D** |
| **engine-db** | SQLite CRUD（事件/检查点/能力/记忆/技能...） | dsh JSONL+storageDomain 更强；只借部分表结构 | `createTables` 缺 9 张业务表；fork 主键冲突；repair 字段丢失；归档适配器 no-op | 不适用 | **D/C** |

## 全量结论

- **真正值得进入 SuperDSH 的下一批**：`txn-fs`（多文件事务，先修 rollback）、`codegraph`/`mcp-codegraph`（repo map，先修 ID/缓存）、`notes-manager`（scratchpad）、`history-compact`（压缩 fallback）、`retrieval-feedback`（记忆过滤）、`learning-nudge`（会话结束反思）、`evidence-log`（内容寻址证据）、`knowledge-vault`（版本化知识）。
- **需要先重写核心算法再谈**：`embedding`、`agent-memory`/`memory-engine-v2`、`checkpoint-writer`、`max-mode-sampler`、`llm-dag-generator`。
- **只有概念价值**：`memory-graph`、`goal-verifier`、`guardrail`、`healix`、`confidence-gate`、`agentic-search`、`reasoning-search`、`state-machine`、`taskdag`、`valid8`、`archiver`。
- **明确不接**：`hallucination-detector`、`code-sandbox`（安全边界）、`event-bus`、`worker`、`dynamic-workflow`、`branch`、`tracing`、`replay`、`mcp-client`、`engine-db`（作为库）、`process-reward`、`agent-metacog`（校准器）、`pomdp-planner`。
