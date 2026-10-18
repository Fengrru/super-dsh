# 一次 null result 如何让一个功能退出默认配置

> 一个功能“有测试、有 benchmark、也确实注入了”，并不等于它值得默认开启。

## 假设

Repair memory 的想法很直接：当工具再次犯同类错误时，把之前成功的修复提示自动附加到上下文里。它应该能让 agent 少走弯路，提高成功率，或者至少减少 token。

在 0.1.0 之前，`repairs` 和其他安全/恢复能力一起放在默认 core 里。它有确定性测试，也有一个 5 条提示、10 个已知/未知错误的合成检索实验：已知错误命中 10/10，正确 hint 10/10，未知错误误命中 0/10。

但这些都是**检索层**的指标。我们不知道它是否改变了 agent 的任务结果。

## 先发现了一个真实 bug

在设计 A/B 时，我们先检查 dsh 的 shell 工具如何报告失败。结果发现：

```text
node --test 失败
→ result.isError: false
→ result.value.exitCode: 1
```

dsh 不把“命令以非零退出”当作工具错误；它把退出码放在结构化结果里，让模型自己判断。原来的 repair memory 只监听 `isError: true`，所以它**根本看不到测试失败**。

这意味着两件事：

1. 之前的合成实验没有覆盖真实使用路径；
2. 如果不修这个问题，repairs 的 A/B 会得到“没有注入、也没有效果”的假 null。

修法是：在 `tools/post-execute` 里识别 `kind: 'foreground'` 且 `exitCode != 0` 的结果，用 stderr/stdout 文本匹配修复提示。提示仍然作为数据注入，不当作指令。

## A/B 设计

我们预注册了规则：

> 只有当 treatment 比 baseline 多通过至少 2 个任务，或者通过数不下降且输入 token 降低至少 15% 时，才保留 `repairs` 默认开启；否则改为 opt-in。

实验使用 16 个单文件调试任务，每个任务都有一个 `src.js` 和一个 `test.js`。两个 arm：

- 都启用同样的 `repairs` 工具面；
- 唯一区别是 treatment 的 `DSH_HOME` 预置了一条提示；
- 提示的 `error_message` 来自该任务真实的 `node --test` 失败输出；
- 提示内容是该任务的具体修复；
- 外部 checker 运行 `node --test`，并检查 `test.js` 哈希未变。

为了确认不是“提示根本没注入”，实验在每次运行后解压 dsh 的 session 日志，搜索注入标记。结果是 treatment **16/16** 都有注入，baseline **0/16**。

## 结果

| 指标 | baseline | treatment |
|---|---:|---:|
| 通过 | **16/16** | **16/16** |
| 输入 token | **28,546** | 31,156（+9.1%） |
| 输出 token | **12,358** | 14,259（+15.4%） |
| 墙钟 | **205.7 s** | 213.7 s |
| 有注入的会话 | 0/16 | **16/16** |

两个 arm 都通过了全部任务。提示没有带来任何额外成功，却让输入和输出 token 都增加了。规则没有满足。

## 为什么会这样

这是一个 **ceiling effect**：16 个任务都是小型的单文件修复，模型本来就能读取失败信息、定位 bug、改一行代码。提示“告诉它怎么修”没有增加它不知道的信息，只是多了上下文。

它也暴露了默认开启的代价：即使提示没问题，它也会占用 token；如果提示错误，还可能把模型带偏。

因此决定：`repairs` 从 core 移除，改为 `repairs: true`。这是一个默认值变更，不是删除功能。它的工具、存储、注入路径和测试都保留。

## 这是否说明 repair memory 没用

不能。这个实验只覆盖了：

- 单文件、短任务；
- 失败信息清晰；
- 模型能够自己从测试输出推断修复；
- 一个模型；
- 16 个任务。

它没有覆盖 repair memory 最可能发挥作用的场景：跨会话的重复错误、错误信息很隐晦、模型反复尝试同一错误、或团队希望把“上次怎么修好的”固化下来。

所以正确的结论不是“repair memory 永远没用”，而是：

> 在这些任务上，它没有证明自己值得默认开启。默认值是一个产品声明，没有证据就不应该占着默认位置。

## 从这次实验学到的

1. **合成指标通过，不代表任务级有效。** 检索命中 10/10 只说明提示能被找到，不说明提示能帮助完成任务。
2. **先验证接线，再判断效果。** 如果没检查 session 日志，我们甚至不知道提示有没有注入。
3. **null result 是有价值的交付。** 它让我们把默认 token 成本降下来，也让项目更诚实。
4. **默认配置需要定期重审。** 一个功能在 0.1.0 默认开启，不代表在 0.2.0 还应该默认开启。

方法、限制和原始结果：

- [`docs/experiments.md`](../experiments.md) E14
- [`experiments/results/repairs-ab-bench.json`](../../experiments/results/repairs-ab-bench.json)
- [`experiments/repairs-ab-bench.ts`](../../experiments/repairs-ab-bench.ts)
- [`tests/repairs.test.ts`](../../tests/repairs.test.ts)
