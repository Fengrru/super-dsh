# 给 AI 编程器加一层可靠性

> 一个 dsh 插件，零运行时依赖；也是我如何用实验决定“哪些能力应该默认开启”的记录。

## 一个熟悉的失败

AI agent 修一个测试失败，通常会这样工作：读文件、猜原因、改一行、跑测试、再改。这个过程在简单任务上很顺，但执行层经常出现一些和模型推理无关的失败：

- 它记得的代码片段和文件里的缩进、换行、空格不一致，`edit` 找不到精确匹配；
- 一次多文件重构改到一半失败，工作区留下半套修改；
- 它执行了一个不可逆命令，然后进程崩了，没人知道到底执行没执行；
- 它说“已经修复”，但没有跑测试；或者跑了，却把测试文件也改了；
- 新会话开始时，上次确认过的项目约定全部消失；
- 报告、截图、补丁留在对话里，事后无法验证是不是原始版本。

这些问题不是“模型不够聪明”，而是执行层缺少边界。dsh 的插件机制很强，但公共组合里没有把这些边界作为第一方能力提供。SuperDSH 就是补这一层。

项目地址：<https://github.com/Fengrru/super-dsh>。首个开源版本是 **0.1.0**，单个 ESM bundle，**零运行时依赖**，通过普通 Cordis 插件/profile 加载。

## 它是什么，不是什么

**是什么：**

- `fuzzy_edit`：dsh `edit` 的容错兜底，带安全护栏；
- `apply_patch`：多文件事务、全量预检、失败回滚、跨进程文件锁；
- `effects`：副作用 intent/commit 账本，崩溃后对账，可选拒绝重复不可逆调用；
- `audit`：哈希链、head anchor、可选 HMAC 签名、证据查询和导出；
- `artifacts`：SHA-256 内容寻址、每次读取重验、索引丢失后可重建；
- `memory`：分层项目记忆、反馈、因果失效、确定性巩固；
- `repo_map` / `find_symbol` / `impact_of` / `search_code`：仓库级符号和调用关系；
- `knowledge`、`notes`、`handoff`、`replay_plan`、`history_compact`、`reflect`；
- 可选 `verify`、`budget`、`retention`、`repairs`。

**不是什么：**

- 不是 sandbox，不替代 dsh 的审批和沙箱；
- 不是语义记忆，检索仍然是词法的；
- 不是“让模型变聪明”的 prompt 包装；
- 不是完整的 durable execution runtime；
- 不声称在 5 个任务的 A/B 里赢过 baseline 的所有能力。

这一点很重要。一个可靠性工具最危险的宣传，是让用户以为它覆盖了它其实没有覆盖的边界。

## 最小设计原则

SuperDSH 一开始就限制了三件事：

1. **单 bundle、零运行时依赖。** 发布产物只 import Node 内置模块，安装和审计都简单：没有传递依赖，没有 postinstall 下载。
2. **每个能力独立开关。** 一个能力坏掉，不能把整个 harness 拖下去；所有 hook 都有隔离。
3. **默认值必须由实验决定。** 不是“这个功能听起来很有用”，而是“它在 baseline 上可测量地解决了问题，且护栏没有退化”。

第三条最贵，也最有价值。SuperDSH 的 profile 不是拍脑袋分的：

| Profile | 工具数 | 每次请求 schema token | 内容 |
|---|---:|---:|---|
| **core**（默认） | 21 | 2,953 | fuzzy edit、apply_patch、memory、audit、effects、artifacts |
| coding | 37 | 4,984 | core + repo map/search_code、notes、knowledge、handoff/replay、compact/reflection |
| full | 41 | 5,610 | coding + verify/budget/retention（配置后注册） |

所有工具 schema 都要付费。core 只保留安全和恢复原语；`repair memory` 曾经在 core，后来被一次 null result 移出去了，这是后话。

## 四个改变决策的实验

### 1. 容错编辑：33.8% → 90.0%

基线是 dsh 的精确匹配 `edit`：`old_string` 必须逐字节、且全局唯一。我们做了 80 个真实格式漂移案例（TS/Python/Rust/Go/CSS/YAML/SQL/Markdown/shell/React/Java × 6 种漂移，再加 8 个歧义/无匹配对照）。

| 指标 | 精确匹配 | fuzzy_edit |
|---|---:|---:|
| 正确（80） | 27（33.8%） | **72（90.0%）** |
| 错区编辑 | 0 | **0** |
| 对照正确拒绝 | 8/8 | **8/8** |

关键不是“容忍差异”，而是“证明差异之后仍然改对了”。`fuzzy_edit` 用 8 种策略定位，然后要求：匹配字节唯一、首尾锚点一致、Token 多重集相似度 ≥98%、覆盖至少一半请求非空行。漏改可以重试，错改不可恢复。

详细设计见 [《为什么我给 fuzzy edit 加了五道护栏》](02-fuzzy-edit.md)。

### 2. 工具越多越好吗：core vs coding

第二个实验比较两个 profile 在 5 个导航/修复任务上的表现。结果是 **core 5/5，coding 5/5**；coding 输入 **25,357 vs 18,490**，输出 **5,605 vs 3,740**，墙钟 **101.5s vs 86.3s**。

coding 没有赢下任何一个任务，却贵了约 37% 输入 token。所以默认是 core，coding/full 保持 opt-in。这个样本很小，只能说明“没有证据支持把 coding 设为默认”，不能证明 coding 永远无用。

### 3. 一个 null result：repair memory 退出 core

`repairs` 会在工具失败后自动注入历史修复提示。我们做了 16 个单文件修复任务，两个 arm 使用完全相同的工具面；treatment 的 DSH_HOME 预置了该任务真实 `node --test` 失败对应的提示。

结果是：**两个 arm 都 16/16**；提示确实进入了 **16/16** 个 treatment 会话；但 treatment 输入 token **+9.1%**，输出 **+15.4%**。

规则要求“多通过 2 题，或输入 token 降低 15%”，都没有满足。于是 `repairs` 从默认 core 移除，改为 `repairs: true`。它仍然保留，因为 harder/cross-session 场景还没有被这个 ceiling corpus 覆盖。

这次实验还暴露了一个真实 bug：dsh 的 shell 非零退出是 `isError: false`，原实现只看 `isError`，所以 repair memory 根本看不到 `node --test` 失败。现在它会识别结构化 foreground 结果的非零 `exitCode`，并用 stderr/stdout 匹配提示。

详细过程见 [《一次 null result 如何让一个功能退出默认配置》](03-repairs-null-result.md)。

### 4. 跨会话记忆：0/10 → 10/10

最初的两对 memory 实验后来扩展到十对。两个 session 之间删除并重建 workspace，只保留 `DSH_HOME`。结果 baseline **0/10** 召回，treatment **10/10** 召回；session 2 输出 token 从 **222–678** 降到 **44–107**。

这支持 memory 作为默认能力，但它验证的是“用户明确要求记住、之后能取回”，不是长期记忆质量。检索仍然是词法的。

## 崩溃之后会发生什么

可靠性不能只在正常路径上测试。我们做了几组真实进程实验：

- **effects**：独立 Bun 进程记录不可逆 intent，被 `taskkill /F /T` 或 `SIGKILL` 杀死；新进程把 pending 对账为 `unknown`，重复不可逆调用被拒绝（`duplicateDenied=true`，`duplicateExecutions=0`），而 committed 对照仍允许重复。
- **artifacts**：子进程写完 blob、还没写索引就被杀；新进程按 SHA-256 读取和验证成功，`artifact_reindex` 从 blob 重建索引。
- **audit anchor**：追加记录但不更新 head anchor，`audit_verify` 报 `head anchor expects N records`。只检测，不自动修复——自动修复可能掩盖篡改。
- **budget**：确认了限制：内存态预算重启后从 900 变成 0，不持久。
- **多进程写入**：两个 Bun 进程各写 25 条 memory/repair/knowledge，最终 50/50 条 memory、50 次 repair 计数、1..50 连续 knowledge 版本，无丢失、无重复。

这部分详见 [《Kill -9 之后：副作用、artifact 与多进程写入》](04-crash-consistency.md)。

## 反例同样重要

一个只展示成功案例的项目，很难判断它的边界。SuperDSH 也记录了大量“不加”的决定：

- **Best-of-N planning**：baseline 已接近天花板，judge 只提升 0.0087，却花 2.64× token；
- **Valid8 输出门禁**：10 个 buggy 片段只检出 1 个；
- **POMDP planner**：成功率与 greedy 打平，但步数更多、单次规划 ~163ms；
- **reasoning-search**：MCTS-general 生成 0 个候选，best_of_n 与同预算标准采样打平；
- **process-reward**：holdout AUC 0.500；
- **agent-metacog**：校准变差；
- **hallucination-detector**：F1 0.615，true/false 对几乎不可分；
- **code-sandbox**：7 个探针中 1 个通过 `process.getBuiltinModule('fs')` 逃逸。

这些否定结果没有让项目变弱，反而定义了它：SuperDSH 是一个可靠性层，不是万能 agent 增强包。完整的 88 项来源分析和拒绝理由在 [`docs/analysis/`](../analysis/README.md) 与 [`docs/decisions.md`](../decisions.md)。

## 安装

当前是 0.1.0。npm 包发布前，可以从源码安装：

```sh
git clone https://github.com/Fengrru/super-dsh
cd super-dsh
bun install
dsh plugin --profile headless add /absolute/path/to/super-dsh
```

或者用 overlay：

```yaml
- insert:
    - id: super-dsh
      name: '/absolute/path/to/super-dsh/dist/index.js'
      config:
        profile: core
```

```sh
dsh --profile headless --patch ./super-dsh.patch.yml --json "修复失败的测试"
```

npm 包名是 `dsh-super`；发布后可以用 `dsh plugin add dsh-super`。发布状态见仓库 README。

## 已知限制

- dsh 公共 API 仍是 pre-stable，当前验证版本是 `0.2.1-rc.2`；
- memory 检索是词法的，没有 embedding；巩固是确定性 token/Jaccard 合并；
- repo map 是 regex 启发式，不是类型分析；TTL 内可能返回最多 5 秒旧索引；
- `repairs` 的 A/B 是 ceiling 实验，不能证明它在困难场景永远无益；
- budget 不跨重启；
- file locks 是 advisory，不能阻止宿主 `write`/`edit` 或外部进程；
- audit 默认无密钥；拥有写权限并重写整条链的攻击者仍可伪造一致账本。

这些限制在 [`docs/status.md`](../status.md) 中有更完整的说明。

## 结语

SuperDSH 想解决的，不是“让 agent 更聪明”，而是让它在出错时**有边界、有记录、有恢复路径**。这件事很难靠一个更长的 prompt 完成；它需要账本、哈希、锁、事务和真实的崩溃测试。

如果这个方向对你有用，欢迎从 [GitHub 仓库](https://github.com/Fengrru/super-dsh) 开始，或者先读下一篇关于容错编辑的文章。
