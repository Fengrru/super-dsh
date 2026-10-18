# SuperDSH

[![CI](https://github.com/Fengrru/super-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/Fengrru/super-dsh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.2-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供的安全优先可靠性套件：容错编辑、带文件锁的多文件事务、副作用恢复计划、带签名的防篡改审计、内容寻址 artifact、分层项目记忆、错误修复记忆、代码仓库地图、版本化知识库、会话便签、确定性压缩/反思/handoff、replay plan、预算预留、日志归档保留，以及经过测试的协议库。

SuperDSH 不是 dsh 的 fork，而是原生 dsh 插件 bundle：单个 ESM 文件、**零运行时依赖**，通过 Cordis 插件/profile 机制加载。每个能力独立开关；默认开启的能力都有确定性测试和真实 dsh 冒烟；关键能力还有量化实验，默认 profile 也由 agent A/B 决定。未通过实验的能力会记录原因并保持关闭。

## 为什么做

dsh 的插件机制很强，但公共组合仍有执行空白：

| 空白 | 后果 | SuperDSH 能力 |
|---|---|---|
| `edit` 要求精确唯一匹配 | 模型记住的空白/换行/缩进漂移导致失败 | 带安全护栏的 `fuzzy_edit` |
| 无多文件事务 | 半途失败会留下不一致的工作区 | `apply_patch`：全量预检 + 回滚 + 文件锁 |
| 没有副作用账本 | 崩溃在 intent 与 result 之间会留下未知外部动作 | `effects` intent/commit + `effect_reconcile`/`effect_resolve` |
| 没有内容寻址 artifact | 报告/截图/补丁事后无法验证 | `artifacts` SHA-256 + `artifact_verify` |
| 没有第一方长期记忆 | 新会话忘记约定和偏好 | 项目记忆 + TTL + MEMORY.md 导入导出 |
| 没有仓库级符号图 | Agent 只能盲 grep，漏掉调用者 | `repo_map` / `find_symbol` / `impact_of` / `search_code` |
| 没有 scratchpad | 长任务丢失发现与决策 | 会话便签 + 压缩 |
| 没有版本化知识库 | 事实被覆盖，没有历史/信任状态 | `knowledge_*` 版本链与 trust |
| 没有可恢复 handoff | 切换/压缩会话丢失上下文 | 确定性 `handoff` + 机器可读 `replay_plan` |
| 没有完成定义闸门 | Agent 可能没跑测试就宣称成功 | 可选验证闸门 |
| 没有防篡改审计 | 纯 JSONL 无法证明未被改动 | 哈希链 + HMAC 签名 + 证据查询 + 导出 |
| 没有 token/成本统计 | 长会话可能静默超支 | 可选预算 + 预留/结算 |

插件没有运行时依赖。第三方许可证归属记录在 [NOTICE](NOTICE)。

## 安装

SuperDSH 从 GitHub 分发，不发布到 npm。本地构建：

```sh
git clone https://github.com/Fengrru/super-dsh.git
cd super-dsh
bun install        # 无运行时依赖，仅构建/测试需要
bun run build      # 生成 dist/index.js
bun test           # 222 个确定性检查
dsh plugin --profile headless add /absolute/path/to/super-dsh
```

`dsh plugin add` 依赖 `pnpm`；请确保 `pnpm` 在 `PATH` 中。不需要 npm registry 包。

本地 overlay：

```yaml
# super-dsh.patch.yml
- insert:
    - id: super-dsh
      name: '/absolute/path/to/super-dsh/dist/index.js'
      config:
        verify:
          command: 'bun test'   # 可选；开启验证闸门
```

```sh
dsh --profile headless --patch ./super-dsh.patch.yml --json "修复失败的测试"
```

持久安装：

```sh
dsh plugin --profile headless add /absolute/path/to/super-dsh
dsh --profile headless --dump-config | grep super-dsh
```

## Profiles

默认是 **core**：保留安全与恢复能力面，不含仓库地图、会话报告或运维扩展。

| Profile | 工具数 | 每次请求 schema token | 内容 |
|---|---:|---:|---|
| **core**（默认） | 21 | 2,953 | fuzzy edit、apply_patch、memory、audit、effects、artifacts |
| coding | 37 | 4,984 | core + repo map/search_code、notes、knowledge、handoff/replay、compact/reflection |
| full | 41 | 5,610 | coding + verify/budget/retention（需配置后才注册） |

Profile 在插件 config 中选择；显式 feature flag 会覆盖 profile。现成 overlay 在 [`presets/`](presets/)。

```yaml
config:
  profile: coding
```

**为什么默认 core：** 5 个任务的 agent A/B（导航 + 多文件修复）中 core **5/5**、coding **5/5**，但 coding 消耗 **25,357 vs 18,490 输入 token**（约 +37%）。该样本里额外工具没有提高成功率，因此在 agent benchmark 证明收益前保持 opt-in。该 A/B 在 repairs 改为 opt-in 之前运行，两个 arm 都包含 repairs；当前 core 是 21 个工具。见 `experiments/results/profile-ab-bench.json` 与 `docs/experiments.md` E12。

**Repair memory 是 opt-in。** 另一个 16 任务 agent A/B 使用相同工具面：两个 arm 都 **16/16** 通过，但注入提示时输入 token **+9.1%**、输出 **+15.4%**。提示确实进入了 **16/16** 个 treatment 会话，因此这是可测的 null result，不是接线失败。用 `repairs: true` 开启，见 E14。

## 能力

### 编辑

**`fuzzy_edit`**：dsh `edit` 的兜底工具。用 8 种容错策略定位目标区域，再用精确匹配子串调用 `ctx.fs.editText`，保留原子写、先读后写、沙箱策略与唯一匹配。护栏：匹配字节唯一、首尾锚点一致、Token 多重集相似度 ≥98%、覆盖至少一半请求非空行、大小上限。漏改可恢复，错改不可恢复。

**`apply_patch`**：一次最多 10 个文件。先获取跨进程 advisory 文件锁，读取/解析全部 edit，拒绝重复路径，用 fuzzy 护栏计算全部替换，然后才写入；任一写入失败则逆序恢复原内容。结果按文件报告策略与匹配字符数。

### 上下文与知识

**项目记忆**：每工作区一个追加式 JSONL，位于 `$DSH_HOME/super-dsh/memory/`。工具：`memory_save`（TTL、tier、confidence、derived_from、supersedes）、`memory_search`、`memory_forget`、`memory_feedback`、`memory_invalidate`、`memory_consolidate`、`memory_export`/`memory_import`（MEMORY.md 风格）。三层：`core` 规则优先注入，`long` 事实按相关度检索，`working` 只对当前 session 可见。检索综合词法分数、confidence、tier、importance、时新性和使用次数。`memory_consolidate` 确定性合并近似条目、归档过期/超限条目、提升高频事实。`derivedFrom` 依赖链在更新/遗忘时级联标 stale，避免继续注入过期结论。

**错误修复记忆（opt-in）**：`repair_record` 保存归一化错误签名（tool + code + 路径/数字/UUID 归一化消息）和修复提示；`repair_search`/`repair_list` 检索。工具再次报同类错误，或 shell 命令以非零退出码失败时，`tools/post-execute` 把历史提示作为数据附加，不当作指令；未知错误不猜测。16 任务 A/B 在单文件修复上没有成功率增益且 token 更高，因此三个 repair 工具和自动注入都不在默认 profile 中。

**日志归档保留（可选）**：`archive_ledgers` 对旧审计账本及 head anchor 做 gzip、写 SHA-256 manifest、校验解压往返，仅在显式要求时删除源文件；`restore_archive` 先全量校验再写入，拒绝路径穿越、symlink 和覆盖。

**会话便签**：`note_append` / `note_read` / `note_compact`。session id 清洗为安全文件名；坏行隔离；压缩用临时文件 + rename 原子重写。

**仓库地图**：`repo_map` / `find_symbol` / `impact_of` / `search_code`。零依赖 regex 索引，支持 TS/JS、Python、Rust、Go、Java，含 import、引用边、PageRank、mtime+size 失效，以及带文件路径的符号 ID（同名符号不覆盖）。`search_code` 把自然语言查询路由到 definition/caller/text 模式并合并结果。它是启发式索引，编辑前仍应 `read` 确认。

**版本化知识库**：`knowledge_add` / `knowledge_search` / `knowledge_history` / `knowledge_verify` / `knowledge_forget`。按 key 的追加式版本链、trust、TTL、archived tombstone。搜索只返回每个 key 最新、未过期、非 disputed 的版本；可选 pre-step 注入只注入 verified。

**Handoff**：`handoff` 通过 `sessionQuery` 读取持久会话，生成确定性 Markdown：真实用户请求（过滤注入上下文）、最终回答、工具计数、错误、触碰文件（含 `apply_patch.edits`）、命令、未完成回合和 resume checklist。不调用模型。

**Replay plan**：`replay_plan` 生成机器可读的对应物：变更文件 re-read、失败工具/命令 rerun、观察到的 test/lint/build/check verify、未完成/中断 turn inspect。它是恢复计划，不只是文字总结。

**历史压缩**：`history_compact` 生成受预算约束的确定性摘要：目标、每回合一行进度、当前状态、next steps。超预算时保留目标与当前状态、丢弃较旧进度，并返回原始/压缩字符数与比例。不调用模型。

**反思**：`reflect` 确定性回顾重复相同调用、聚合工具错误、触碰文件、未完成回合、是否观察到验证命令，并按固定规则给出建议。不调用模型。

### 执行安全与可观测性

**副作用账本**：每次工具调用记录 hash 参数与 intent；结果变为 `committed`/`failed`。新进程把遗留 pending 标为 `unknown`；`effect_status` 报告未解决项；`effect_reconcile` 返回明确的 `replay`/`compensate`/`query` 计划；`effect_resolve` 记录人工/外部结果。账本每 session 只加载一次到内存（10k 次调用 733ms，0.073ms/次）。`denyUnresolvedIrreversible`（可选）在崩溃后拒绝重复不可逆调用（包括 unknown 前驱）。

**Artifacts**：`artifact_put` / `artifact_get` / `artifact_verify` / `artifact_list` / `artifact_reindex`。SHA-256 内容寻址、temp+rename 原子写、追加式索引、每次读取重验 hash、文本/base64 往返。篡改/缺失会验证失败；索引丢失时可按 blob 重建索引，永不索引的 blob 也能按 hash 读取。

**审计**：每个 session 事件镜像为哈希链 + head anchor。`audit_verify` 校验哈希、链链接、序号单调性、anchor 与可选 HMAC 签名；`audit_evidence` 按事件 data hash 查找证据；`audit_export` 返回 head/verify，可选最多 5000 条记录。`signingKeyEnv`/`signingKey` 启用 HMAC-SHA256 签名，使“重算 hash 但保留旧签名”的篡改可检出。默认无密钥：能检出编辑、删除、截断、重排，不能阻止拥有写权限且掌握密钥的攻击者重写整条链。

**验证闸门（可选）**：文件修改后，在 `agent/turn-stopping` 运行配置命令；失败带输出尾部反馈，最多 `maxAttempts` 次。默认关闭，因为 E3 显示 `deepseek-flash` 本来就会主动跑测试，没有成功率增益。

**预算（可选）**：累计 `assistant/message` 与 `compaction/summary` usage；`budget_status` 返回 used/reserved/remaining/exhausted。`enforce: true` 超限拒绝请求；`reservePerRequest` 提供 reserve/settle/release，并在 request-error/turn-end 清理。

### 协议库

以下是有测试的 TS 构建块，不是模型可见工具：

- **Capability tokens**：HMAC-SHA256 scope/session/task/expiry，realpath 感知的 `fs:read:<path>` / `fs:write:<path>` 边界（无 `startsWith` 绕过）。
- **Causal clock**：向量时钟 tick/merge/compare/serialize，为未来多子代理 fan-in 准备。
- **Worker protocol**：JSON-RPC 2.0 NDJSON `execute`/`checkpoint`/`result`/`cancel` codec，以及带 deadline 的任务状态机。
- **File locks**：跨进程 advisory 锁，支持 stale owner 接管与 TTL；`apply_patch` 已使用。

## 配置

```yaml
- insert:
    - id: super-dsh
      name: 'dsh-super'
      config:
        profile: core
        fuzzyEdit: true
        applyPatch:
          maxFiles: 10
          useLocks: true
          lockTimeoutMs: 5000
          lockTtlMs: 120000
        memory:
          dir: 'C:/custom/memory'
          maxEntries: 500
          injectTopK: 4
          injectMaxChars: 1600
          coreMaxChars: 500
          maxPerTier: 500
          dedupeThreshold: 0.85
        # repairs:          # opt-in：增加 3 个工具和自动提示
        #   maxEntries: 500
        retention:
          maxAgeDays: 30
          deleteSource: false
        notes:
          maxEntriesPerSession: 500
        repoMap:
          maxFiles: 2000    # 默认 1000；大仓库可提高
          maxFileBytes: 524288
          search: true
          refreshMs: 5000   # 0 = 每次检查缓存签名
        knowledge:
          injectTopK: 0
        effects:
          denyUnresolvedIrreversible: false
        artifacts: true
        audit:
          signingKeyEnv: 'SUPER_DSH_AUDIT_KEY'   # 可选 HMAC
        handoff: true
        historyCompact: true
        reflection: true
        replayPlan: true
        budget:
          maxTokens: 200000
          enforce: false
          reservePerRequest: 0
        verify:
          command: 'node --test'
          timeoutMs: 60000
          maxAttempts: 2
```

## 实验与检查

规则不变：**只有检查支持的能力才能默认开启，且护栏指标不得回退。**

本机量化实验（Windows 10、Node 24、DeepSeek `deepseek-flash`）：

| 实验 | 基线 | SuperDSH | 结论 |
|---|---|---|---|
| 格式漂移补丁（80 例） | 33.8% 正确 | **90.0% 正确** | 接受 |
| 漂移下错区编辑 | 0 | **0** | 护栏保持 |
| 歧义/不匹配拒绝 | 100% | **100%** | 护栏保持 |
| 跨会话记忆（10 组） | 0/10 召回 | **10/10 召回** | 接受 |
| 审计篡改（4 类） | 0% 检出 | **100% 检出** | 接受 |
| 验证闸门（4 个任务） | 4/4 通过 | 4/4 通过 | 无增益，保持可选 |

执行层验证（当前计数）：

- `bun test`：**222 个测试 / 1,412 个断言**，26 个文件，包含对每个注册工具 schema 子集的校验。
- Effects 10,000 次调用：**733ms 总计，0.073ms/次**（20,000 条账本记录，5.5MB），从约 33ms/次降下来。
- 真实 kill-9（`experiments/kill9-effects.ts`）：独立 Bun 进程记录不可逆 intent，被 `taskkill /F /T` 或 `SIGKILL` 杀死，新进程把它对账为 `unknown`，重复不可逆调用被拒绝——**duplicateDenied=true, duplicateExecutions=0**；committed 对照仍允许重复。
- 审计：HMAC 签名、删除/重算签名篡改检测、带 head/verify 的导出、字节级 golden fixture。
- Replay plan、文件锁、预算预留/结算、capability token、因果时钟、worker 协议都有确定性测试；真实 dsh 冒烟覆盖 `audit_export`、`effect_reconcile`、`replay_plan`、`apply_patch`、repo map、notes、artifacts、knowledge、handoff、history compact、reflect。
- Effects 崩溃、artifact 崩溃/篡改、apply_patch 回滚是确定性保证或真实进程实验，尚无 Agent 级 A/B 数字，因此不宣称基准胜利。

记忆/修复/归档验证：

- Memory v2 巩固（`experiments/memory-v2-bench.ts`）：60 条事实，巩固前后 recall@3 **1.000**，stale 注入 **0**，注入字符 **13,775 → 12,565**；合并 15 条重复，归档 20 条（合并/过期/超限）。
- 修复记忆（`experiments/repair-bench.ts`）：5 条提示，已知错误命中 **10/10**，正确 hint **10/10**，未知错误误命中 **0/10**，平均注入 212 字符。
- 归档保留：gzip + SHA-256 manifest、校验后删除、恢复、路径穿越/symlink/覆盖拒绝（`tests/retention.test.ts`）。

Profile/性能/崩溃验证：

- Profile A/B（`experiments/profile-ab-bench.ts`）：core **5/5**、coding **5/5**；输入 token **18,490 vs 25,357**，输出 **3,740 vs 5,605**，墙钟 **86.3s vs 101.5s**；决策规则是 coding 至少多通过一题才选 coding，平局选低 token，因此默认改为 core。
- Repo map（`experiments/repo-map-perf.ts`，2,000 文件）：冷建 **2.4–4.6s**（最近一次 4,607.7ms；原 33.3s），TTL 暖查询 p50 **0.1ms**，未变更强制重扫 p50 **230–363ms**；阈值 5s/100ms 通过。
- Kill-9 artifacts：子进程写完 blob、未写索引即被杀；新进程按 hash 读取/校验成功，`artifact_reindex` 重建索引。
- Audit anchor：追加合法记录但不更新 head anchor，`audit_verify` 报 `head anchor expects N records`；只检测，不自动修复。
- Budget 重启：用量从 900 变为 0，确认内存态预算在重启后丢失（设计缺口，已记录）。

修复默认值/并发/记忆验证：

- Repair A/B（`experiments/repairs-ab-bench.ts`）：16 任务，两 arm 均 16/16；treatment 输入 **31,156 vs 28,546**（+9.1%），输出 **+15.4%**；提示在 **16/16** treatment 会话中出现，baseline 为 0/16。预注册规则是“多通过 2 题或输入 token 降低 15%”，两者都不满足，因此 `repairs` 改为 opt-in，core 从 24 个工具降到 21 个。
- 记忆复现（`experiments/agent-bench.ts`）：10 组跨会话任务，baseline **0/10**、treatment **10/10**；session 2 输出 token **222–678 vs 44–107**。
- 跨进程 store：两个 Bun 进程同时向同一 memory、repair、knowledge 文件各写 25 条。50 条 memory 和 50 个 knowledge 版本全部保留；repair `successCount` 达到 50；版本连续且 id 唯一（`tests/concurrency.test.ts`）。
- 安装烟测：`npm pack` → `dsh plugin add` → 隔离 `DSH_HOME` 下的 `--dump-config`，profile 包含 `id: super-dsh`（`scripts/install-smoke.ts`，已接入 CI）。
- Shell 失败提示：dsh 的 shell 非零退出是 `isError: false`，repair memory 现在会把它当作可恢复失败；确定性测试覆盖注入、零退出和非 shell 对照。

可选能力实验结论（预注册决策规则）：

| 候选 | 结果 | 决策 |
|---|---|---|
| Best-of-N 规划（max-mode） | baseline 0.986、judge 0.995、oracle 1.000、judge top-1 75%、**2.64× token**；明显天花板 | **不加** |
| Agentic search | hit@5 **80% → 100%**、MRR **0.70 → 0.90**、warm 1.37× 耗时、冷索引 165ms | **已加为 `search_code`**（检索级证据；caller MRR 有注释噪声 caveat） |
| Skill curation | 合成 hit@3 83.3%→100%、stale 槽位 25%→0%，但只有合成数据 | **延后**，等真实技能语料/Agent 任务 |

完整方法与原始结果见 [`docs/experiments.md`](docs/experiments.md) 与 [`experiments/`](experiments/)。不变量映射见 [`docs/invariants.md`](docs/invariants.md)。精确覆盖范围与剩余缺口见 [`docs/status.md`](docs/status.md)。

## 设计原则

- **安全优先于召回**：fuzzy 编辑拒绝歧义；apply_patch 先预检并锁文件；memory 只注入词法匹配；artifact 每次重验 hash；effects 拒绝需显式开启。
- **外部状态**：memory、notes、knowledge、effects、artifacts、audit 都在 `$DSH_HOME`，不污染仓库。
- **故障隔离**：每个能力独立 `try/catch`，坏一个不影响 harness。
- **零运行时依赖**：发布产物只 import Node 内置模块。
- **确定性优先**：handoff、replay plan、压缩、反思、repo map、effects、artifacts、locks、budget 不调用模型。

## 已知限制

- dsh 公共 API 仍是 pre-stable（验证于 `0.2.1-rc.2`）。
- `fuzzy_edit` 每次只处理单区域；故意不暴露 `replace_all`。
- `apply_patch` 回滚是尽力而为：若恢复写入本身失败，错误会列出无法恢复的文件。文件锁是 advisory：宿主 `write`/`edit`、外部编辑器、使用不同锁目录的进程可绕过；TTL/symlink/大小写/路径归一化有边界。
- repo map 是 regex 启发式，不做类型分析；注释/字符串会误报，压缩单行代码召回有限；缓存键是 mtime+size。最多索引 `repoMap.maxFiles` 个文件（默认 1000）；2,000 文件冷建约 2.4–4.6s。引用图上限为 50k 边、每个 token 20 个定义、10 次 PageRank 迭代，因此超密集仓库的中心性可能近似。`refreshMs` 默认 5s，因此编辑后最多 5s 内查询可能看到旧索引；强制未变更重扫约 230–363ms。`search_code` 按关键词路由，继承这些限制；caller 模式会把注释中的符号名当引用（可能降低 MRR）。`repoMap.search: false` 可隐藏该工具。
- effects 和 session notes 是 per-session 追加式 JSONL，没有跨进程锁；不要让两个进程同时写同一 session。memory、repairs、knowledge 的读-改-写已经用 advisory lock 串行化，但读者仍可能看到并发写入前的快照。
- Memory v2 检索仍是词法级（无 embedding）；巩固是确定性 token/Jaccard 合并，不是语义摘要；`working` 可见性依赖保存时的 session id。
- Repair memory 是 opt-in。16 任务 A/B 是单文件修复的 ceiling 实验：它只说明在这类任务上没有收益且有 token 成本，不代表更难、跨会话的失败场景永远无益。
- 错误修复匹配是词法级 + tool/code 过滤；相似错误可能命中错误提示；提示作为数据注入，不强制。
- 日志归档默认关闭；`delete_source`/`deleteSource` 为 true 时会删除源账本，虽然删除前校验 gzip 和 SHA-256，备份策略仍是运维责任。
- 审计默认无密钥；HMAC 只保护记录 hash，密钥管理是运维责任；拥有密钥并重写整条链仍可伪造一致账本。
- handoff/replay-plan 对注入上下文的过滤是启发式；未来未知格式可能被当成用户请求。
- 验证闸门只跑一个配置命令，达到 `maxAttempts` 后放行。
- `budget` 只累计事件 usage；预留在内存，重启丢失（kill-9 实验已确认 900→0）；工具/子代理没有单独计价。
- capability/causal/worker 是测试过的库，不是暴露的工具；没有包含远程 worker 运行时。
- 默认 profile 是 core；coding/full 的额外工具只在显式配置后注册。5 任务 A/B 样本很小，不能证明 coding 永远无益。
- 当前版本为 0.1.1，交付上述能力；剩余缺口见 [docs/status.md](docs/status.md)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：插件架构与宿主。
- 第三方许可证归属见 [NOTICE](NOTICE)。

## 许可证

MIT。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
