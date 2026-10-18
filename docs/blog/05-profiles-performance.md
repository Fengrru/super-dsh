# 工具不是越多越好：profile A/B 与 33 秒的 repo map

> 每一次请求都要为所有已注册工具的 schema 付费。工具数量不是免费的。

## 工具面的隐藏成本

一个 dsh 插件注册 40 多个工具，看起来很强。但模型每次请求都要看到这些工具的名字、描述、参数 schema。它们会进入上下文，占用 token，也会增加模型选错工具的机会。

SuperDSH 曾经把几乎所有能力都放在默认 bundle 里。这样做的问题是：在没有任务级证据之前，默认值已经替用户做了决定。

我们做了两件事：

1. 把工具面拆成 `core` / `coding` / `full` 三个 profile；
2. 用真实 dsh agent A/B 选择默认 profile。

## 三个 profile

| Profile | 工具数 | Schema chars | 约 token/request | 内容 |
|---|---:|---:|---:|---|
| **core**（默认） | 21 | 11,812 | **2,953** | fuzzy edit、apply_patch、memory、audit、effects、artifacts |
| coding | 37 | 19,934 | **4,984** | core + repo map/search_code、notes、knowledge、handoff/replay、compact/reflection |
| full | 41 | 22,438 | **5,610** | coding + verify/budget/retention（配置后注册） |

token 数是 `schemaChars / 4` 的近似值，不是某个模型的精确 tokenizer 结果；它用于比较相对成本，不用于精确计费。

`repairs` 不在这三个 profile 里。它在一次 16 任务 A/B 后被改为 opt-in，原因在[另一篇文章](03-repairs-null-result.md)里。

## A/B：core vs coding

实验任务有 5 个：3 个导航任务（找调用者、找函数、找传递依赖），2 个单文件/双文件修复任务。两个 arm 使用同样的 dsh headless、同样的模型 `deepseek-flash`、隔离 workspace 和 `DSH_HOME`。

预注册规则：coding 只有比 core 多通过至少 1 个任务才值得默认；平局选输入 token 更低的 arm。

| 指标 | core | coding |
|---|---:|---:|
| 通过 | **5/5** | 5/5 |
| 输入 token | **18,490** | 25,357 |
| 输出 token | **3,740** | 5,605 |
| 墙钟 | **86.3 s** | 101.5 s |

coding 没有赢下任何任务，输入 token 却多了约 37%。所以默认保持 core。这个实验只有 5 个任务，不能证明 coding 永远无用；它证明的是“在这个样本里，没有理由为 coding 付默认成本”。

这次 A/B 运行时 core 还是 24 个工具（包含 repairs），coding 是 40 个。后来 repairs 被移出，当前是 21/37/41。比较的仍然是 coding 额外工具，所以结论不变。

## Repo map：33.3 秒的冷启动

`repo_map` 最初的实现同步读取文件、逐个解析，然后在 2,000 文件上做了一次很重的图计算。第一次构建耗时 **33.3 秒**，热调用也要 0.66–0.71 秒。对一个“让 agent 快速理解仓库”的工具来说，这个冷启动会直接破坏体验。

优化分成四块：

1. **并发读取**：最多 32 个文件并发；读取完成后统一建索引；
2. **TTL 缓存**：`repoMap.refreshMs` 默认 5,000ms，窗口内直接复用索引；设为 0 则每次检查签名；
3. **预计算排序**：无 query 的 `repo_map` 不再每次排序符号；
4. **有界图计算**：PageRank 10 次迭代，引用边上限 50,000，每个 token 最多解析 20 个定义。

在 2,000 文件的 dsh checkout 上：

| 指标 | 结果 |
|---|---:|
| 冷建 | **2.4–4.5 s**（首次未缓存 4.5s；原 33.3s） |
| TTL 热查询 p50 | **0.1 ms** |
| 强制未变更重扫 p50 | **230–363 ms** |

阈值是冷建 <5s、热查询 <100ms，通过。

## 性能优化的代价

这里没有“免费加速”：

- TTL 缓存意味着编辑后最多 5 秒内查询可能看到旧索引；
- 图边和定义数上限意味着超密集仓库的 centrality/引用结果可能近似；
- repo map 仍然是 regex 启发式，不是类型分析；
- 默认 `maxFiles` 是 1,000；基准显式设成 2,000 才能覆盖大仓库；
- 冷建仍然要几秒，不能假装是瞬时。

这些限制都写进了 README 和实验文档。性能数字不是“越快越好”，而是“在明确语义和限制下更快”。

## 为什么默认是 core

总结起来是三条：

1. **schema token 是真实成本**：core 比 coding 少约 2,031 token/request；长会话里会累积。
2. **额外工具没有证明任务收益**：5 个任务的 A/B 是 null；coding 保持 opt-in，等更大的导航/多会话 benchmark。
3. **默认值应该保守**：用户想用 repo map、knowledge、handoff，可以显式选 coding；不想付成本的人不应该被迫接受。

这不是“工具越少越好”。`core` 仍然有 21 个工具，因为它保留了安全/恢复原语。真正被移除的是没有任务级证据支持默认开启的工具。

## 可复现

- [`experiments/profile-ab-bench.ts`](../../experiments/profile-ab-bench.ts)
- [`experiments/repo-map-perf.ts`](../../experiments/repo-map-perf.ts)
- [`experiments/tool-overhead-bench.ts`](../../experiments/tool-overhead-bench.ts)
- [`experiments/results/profile-ab-bench.json`](../../experiments/results/profile-ab-bench.json)
- [`experiments/results/repo-map-perf.json`](../../experiments/results/repo-map-perf.json)
- [`docs/experiments.md`](../experiments.md) E10–E12
