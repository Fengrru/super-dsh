# SuperDSH

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供的安全优先可靠性套件：容错编辑、多文件事务、副作用账本、内容寻址 artifact、项目记忆、代码仓库地图、版本化知识库、会话便签、确定性压缩/反思/handoff、验证闸门、审计证据与预算统计。

SuperDSH 不是 dsh 的 fork，而是原生 dsh 插件 bundle：单个 ESM 文件、**零运行时依赖**，通过 Cordis 插件/profile 机制加载。每个能力独立开关；默认开启的能力都有确定性测试和真实 dsh 冒烟验证；四个核心能力还有量化实验。未通过实验的能力会记录原因并保持关闭。

## 为什么做

dsh 的插件机制很强，但公共组合仍有执行空白：

| 空白 | 后果 | SuperDSH 能力 |
|---|---|---|
| `edit` 要求精确唯一匹配 | 模型记住的空白/换行/缩进漂移导致失败 | 带安全护栏的 `fuzzy_edit` |
| 单次只能编辑一处，无多文件事务 | 半途失败会留下不一致的工作区 | `apply_patch`：全量预检 + 回滚 |
| 没有副作用账本 | 崩溃在 intent 与 result 之间会留下未知外部动作 | `effects` intent/commit + 重启对账 |
| 没有内容寻址 artifact | 报告/截图/补丁事后无法验证 | `artifacts` SHA-256 + `artifact_verify` |
| 没有第一方长期记忆 | 新会话忘记约定和偏好 | 项目记忆 + TTL + MEMORY.md 导入导出 |
| 没有仓库级符号图 | Agent 只能盲 grep，漏掉调用者 | `repo_map` / `find_symbol` / `impact_of` |
| 没有 scratchpad | 长任务丢失发现与决策 | 会话便签 + 压缩 |
| 没有版本化知识库 | 事实被覆盖，没有历史/信任状态 | `knowledge_*` 版本链与 trust |
| 没有可恢复 handoff | 切换/压缩会话丢失上下文 | 确定性 `handoff` 报告 |
| 没有完成定义闸门 | Agent 可能没跑测试就宣称成功 | 可选验证闸门 |
| 没有防篡改审计 | 纯 JSONL 无法证明未被改动 | 哈希链审计 + 证据查询 |
| 没有 token/成本统计 | 长会话可能静默超支 | 可选 `budget` 状态/强制 |

模糊匹配改编自 [`awesome-agent-infra`](https://github.com/Fengrru/awesome-agent-infra) 的 `fuzzy-patch`。副作用账本、artifact、审计与验证思路来自 [`nexus-runtime`](https://github.com/Fengrru/nexus-runtime) 的不变量。两者都不是运行时依赖。

## 安装

```sh
git clone https://github.com/Fengrru/super-dsh.git   # 发布后
cd super-dsh
bun install        # 无运行时依赖，仅构建/测试需要
bun run build      # 生成 dist/index.js
bun test           # 82 个确定性检查
```

本地 overlay（开发最快）：

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

## 能力

### 编辑

**`fuzzy_edit`**：dsh `edit` 的兜底工具。用 8 种容错策略定位目标区域，再用精确匹配子串调用 `ctx.fs.editText`，保留原子写、先读后写、沙箱策略与唯一匹配。护栏：匹配字节唯一、首尾锚点一致、Token 多重集相似度 ≥98%、覆盖至少一半请求非空行、大小上限。漏改可恢复，错改不可恢复。

**`apply_patch`**：一次最多 10 个文件。先读取/解析全部 edit，拒绝重复路径，用 fuzzy 护栏计算全部替换，然后才写入；任一写入失败则逆序恢复原内容。结果按文件报告策略与匹配字符数。

### 上下文与知识

**项目记忆**：每工作区一个追加式 JSONL，位于 `$DSH_HOME/super-dsh/memory/`。工具：`memory_save`（支持 `ttl_days`）、`memory_search`、`memory_forget`、`memory_export`/`memory_import`（MEMORY.md 风格）。每回合自动注入相关且未过期条目；检索是词法级，含标签、重要性、时新性、使用次数和基础中文处理。

**会话便签**：`note_append` / `note_read` / `note_compact`。session id 会清洗为安全文件名；坏行隔离；压缩用临时文件 + rename 原子重写。

**仓库地图**：`repo_map` / `find_symbol` / `impact_of`。零依赖 regex 索引，支持 TS/JS、Python、Rust、Go、Java，含 import、名称引用边、PageRank 排序、mtime+size 失效，以及带文件路径的符号 ID（同名符号不会互相覆盖）。它是启发式索引，编辑前仍应 `read` 确认。

**版本化知识库**：`knowledge_add` / `knowledge_search` / `knowledge_history` / `knowledge_verify` / `knowledge_forget`。按 key 的追加式版本链、trust（draft/verified/disputed）、TTL、archived tombstone。搜索只返回每个 key 最新、未过期、非 disputed 的版本；可选 pre-step 注入只注入 verified。

**Handoff**：`handoff` 通过 `sessionQuery` 读取持久会话，生成确定性 Markdown：真实用户请求（过滤注入的 runtime context）、最终回答、工具计数、错误、触碰文件（含 `apply_patch.edits`）、命令、未完成回合和 resume checklist。不调用模型。

**历史压缩**：`history_compact` 从持久会话生成受预算约束的 Markdown：目标、每回合一行的进度（请求、助手文本、工具、变更文件、错误）、当前状态和三条 next steps。超预算时优先保留目标与当前状态、丢弃较旧进度，并返回原始/压缩字符数与比例。不调用模型。

**反思**：`reflect` 确定性回顾会话：重复相同调用、聚合工具错误、触碰文件、未完成回合、是否观察到验证命令，并按固定规则给出建议（如“文件已改但未观察到验证”）。不调用模型。

### 执行安全与可观测性

**副作用账本**：每次工具调用记录 hash 参数与 intent；结果变为 `committed`/`failed`。新进程会把遗留 pending 标为 `unknown`；`effect_status` 报告未解决项。`denyUnresolvedIrreversible`（可选）会拒绝同 key 的重复不可逆调用。纯工具单独分类；危险 shell 命令判为不可逆。

**Artifacts**：`artifact_put` / `artifact_get` / `artifact_verify` / `artifact_list`。SHA-256 内容寻址、temp+rename 原子写、追加式索引、每次读取重新校验 hash、文本/base64 往返。被篡改或缺失的 blob 会验证失败，而不是被信任。

**审计**：每个 session 事件镜像为哈希链账本 + head anchor。`audit_verify` 校验记录哈希、链链接、序号单调性和 anchor；`audit_evidence` 按事件 data hash 查找证据。无密钥：能检出编辑、删除、截断和重排，不能阻止拥有写权限的攻击者重算整条链。

**验证闸门（可选）**：文件修改后，在 `agent/turn-stopping` 运行配置命令；失败带输出尾部反馈，最多 `maxAttempts` 次。默认关闭，因为 E3 实验显示 `deepseek-flash` 本来就会主动跑测试，没有成功率增益。

**预算（可选）**：累计 `assistant/message` 与 `compaction/summary` 的 usage；`budget_status` 返回已用/剩余/耗尽。`enforce: true` 时在 `agent/request` 超限拒绝。

## 配置

```yaml
- insert:
    - id: super-dsh
      name: 'dsh-super'
      config:
        fuzzyEdit: true
        applyPatch:
          maxFiles: 10
        memory:
          dir: 'C:/custom/memory'
          maxEntries: 500
          injectTopK: 4
          injectMaxChars: 1600
        notes:
          maxEntriesPerSession: 500
        repoMap:
          maxFiles: 2000
          maxFileBytes: 524288
        knowledge:
          injectTopK: 0
        effects:
          denyUnresolvedIrreversible: false
        artifacts: true
        audit: true
        handoff: true
        historyCompact: true
        reflection: true
        budget:
          maxTokens: 200000
          enforce: false
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
| 跨会话记忆（2 组） | 0/2 召回 | **2/2 召回** | 接受 |
| 审计篡改（4 类） | 0% 检出 | **100% 检出** | 接受 |
| 验证闸门（4 个任务） | 4/4 通过 | 4/4 通过 | 无增益，保持可选 |

0.2 新能力的确定性检查与真实 dsh 冒烟：

- `bun test`：**82 个测试 / 427 个断言**，覆盖 effects、artifacts、apply_patch 回滚、notes 路径安全、repo-map 同名符号与 mtime 失效、knowledge 版本/trust/过期、handoff、history compact/reflection、budget、memory TTL/导入导出、audit 证据、fuzzy edit 与验证闸门。
- 真实 dsh headless 冒烟：`artifact_put` + `note_append` 成功，`effect_status` 显示 2 committed / 0 unresolved；`apply_patch` 原子编辑 2 个文件；`repo_map` 找到 `a.ts` 的 `start`；`knowledge_add` 创建 v1；`handoff` 汇总 43 个事件；`history_compact` 与 `reflect` 在真实会话中返回确定性报告。
- effects 崩溃/重复拒绝、artifact 篡改检测、apply_patch 回滚有确定性保证，但还没有 Agent 级 A/B 数字，因此不宣称基准胜利。

完整方法/原始结果见 [`docs/experiments.md`](docs/experiments.md) 与 [`experiments/`](experiments/)。88 项来源组件分析见 [`docs/analysis/`](docs/analysis/README.md)。

## 设计原则

- **安全优先于召回**：fuzzy 编辑拒绝歧义；apply_patch 先全量预检；memory 只注入词法匹配；artifact 每次重验 hash；effects 默认只记账，拒绝需显式开启。
- **外部状态**：memory、notes、knowledge、effects、artifacts、audit 都放在 `$DSH_HOME`，不污染仓库。
- **故障隔离**：每个能力独立 `try/catch`，坏一个不影响 harness。
- **零运行时依赖**：发布产物只 import Node 内置模块。
- **确定性优先**：handoff、notes 压缩、repo map、effects、artifacts 不调用模型。

## 已知限制

- dsh 公共 API 仍是 pre-stable（验证于 `0.2.1-rc.2`）。
- `fuzzy_edit` 每次只处理单区域；故意不暴露 `replace_all`。
- `apply_patch` 回滚是尽力而为：若恢复写入本身失败，错误会列出无法恢复的文件；没有文件系统级事务或跨进程锁。
- repo map 是 regex 启发式，不做类型分析；注释/字符串会误报，压缩单行代码召回有限；缓存键是 mtime+size。
- effects、knowledge、notes 都是追加式 JSONL，没有跨进程锁；不要让两个进程同时写同一 session/workspace。
- 审计链无密钥；对抗性威胁模型需要外部 WORM 或签名。
- handoff 对注入上下文做已知标记过滤；未来未知的注入格式可能被当成用户请求。
- 验证闸门只跑一个配置命令，达到 `maxAttempts` 后放行。
- `budget` 只累计事件 usage，不对工具/子代理计价；强制默认关闭。
- 88 项分析是路线图，不代表全部已实现。0.2.0 交付上述能力；C/D 类保持延后或拒绝。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：插件架构与宿主。
- [`Fengrru/awesome-agent-infra`](https://github.com/Fengrru/awesome-agent-infra)：`fuzzy-patch`（已 vendored 并加固），以及记忆/压缩/便签的部分思路。
- [`Fengrru/nexus-runtime`](https://github.com/Fengrru/nexus-runtime)：副作用账本、内容寻址、审计与验证不变量。

## 许可证

MIT。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
