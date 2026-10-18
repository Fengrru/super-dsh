# SuperDSH 文章合集

这是一组关于 **SuperDSH 0.1.0** 的工程文章。SuperDSH 是给
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）
加一层可靠性的开源插件：容错编辑、多文件事务、副作用恢复、审计、artifact、
项目记忆、知识和崩溃后的恢复计划。

这些文章不是功能清单，而是围绕一个问题展开：

> 当 AI agent 的“执行层”出错时，我们怎么知道它错了，怎么限制损失，怎么在下一次会话里恢复？

## 阅读顺序

1. **[给 AI 编程器加一层可靠性](01-launch.md)** — 主文。为什么做、怎么设计、哪些实验改变了默认值，以及哪些东西明确不做。
2. **[为什么我给 fuzzy edit 加了五道护栏](02-fuzzy-edit.md)** — 80 个格式漂移案例，33.8% → 90.0%，以及为什么“漏改”必须优于“错改”。
3. **[一次 null result 如何让一个功能退出默认配置](03-repairs-null-result.md)** — repair memory 的 16 任务 A/B，hint 真实注入 16/16，但最终改为 opt-in。
4. **[Kill -9 之后：副作用、artifact 与多进程写入](04-crash-consistency.md)** — 真实进程崩溃实验、audit anchor 缺口、artifact 重建、跨进程锁。
5. **[工具不是越多越好：profile A/B 与 33 秒的 repo map](05-profiles-performance.md)** — 24/40/44 → 21/37/41 的工具面，以及 repo map 从 33.3 秒降到 2 秒级。

## 项目状态

- 版本：**0.1.0**（首个开源版本）
- 仓库：<https://github.com/Fengrru/super-dsh>
- 发布页：<https://github.com/Fengrru/super-dsh/releases/tag/v0.1.0>
- 测试：**222 tests / 1,412 assertions**，26 个测试文件
- 覆盖率：**95.50% lines / 93.08% functions**
- 运行时依赖：**0**
- 验证宿主：dsh `0.2.1-rc.2`（pre-stable）
- 实验环境：Windows 10、Node 24、DeepSeek `deepseek-flash`；样本较小，结论以各实验的限制为准

## 实验与原始数据

文章里的数字都来自仓库中的实验，而不是事后估算。完整方法、限制和原始 JSON：

- [`docs/experiments.md`](../experiments.md) — E1–E16
- [`docs/status.md`](../status.md) — 覆盖范围、已拒绝候选、剩余缺口
- [`experiments/results/`](../../experiments/results/) — 原始结果
- [`docs/invariants.md`](../invariants.md) — Phoenix invariants 映射

## 适合谁

- 正在给 dsh 写插件，想知道哪些可靠性原语真的有用；
- 在做 agent 工程，关心“默认值是否有实验支持”；
- 对 negative results、crash consistency、多进程写入安全感兴趣。

## 转载

文章与代码使用 MIT License。转载时请保留仓库链接和实验数据出处。
