# Kill -9 之后：副作用、artifact 与多进程写入

> 正常退出测试证明不了崩溃恢复。要证明，就得真的杀进程。

## 为什么 fake context 不够

大多数插件测试可以驱动 hook、断言返回值，然后结束。这对语义正确性足够，但对“进程在写文件时死掉”没有说服力。

SuperDSH 里有一类能力，只有在真实进程死亡后才有意义：

- effects：记录了一个不可逆命令的 intent，但还没收到 result，进程死了；下一次启动时，这个动作到底算不算发生过？
- artifacts：blob 已经写完，索引还没写，进程死了；还能不能按 hash 找到它？
- audit：记录追加了，head anchor 还没更新，进程死了；审计链还能不能验证？
- memory/repair/knowledge：两个 dsh 进程同时写同一个 workspace，会不会互相覆盖？

这些问题的答案不能靠一个 `try/catch` 测试来证明。我们做了真实进程实验。

## Effects：intent 和 result 之间

副作用账本的记录路径是：

```text
tool call
  → 写 intent（pending）
  → 执行工具
  → 写 result（committed / failed）
```

崩溃窗口就在 intent 和 result 之间。进程死后，磁盘上只有一条 pending intent，外部世界可能已经执行、也可能没有。

实验用独立 Bun 进程：

1. 子进程设置隔离的 `DSH_HOME`，调用 `tools/pre-execute` 记录一个不可逆命令的 intent；
2. 不发送 `tools/result`，打印 READY 后 sleep；
3. 父进程用 `taskkill /F /T`（Windows）或 `SIGKILL`（POSIX）杀死它；
4. 新进程读取同一个账本，把 pending 对账为 `unknown`；
5. 重复同一个不可逆调用，期望被拒绝。

结果：

```text
unknown = 1
duplicateDenied = true
duplicateExecutions = 0
```

committed 对照则不同：另一个进程正常记录 intent 和成功 result，新进程看到 committed，重复调用被允许。

这里被证明的不是“外部命令一定不会重复执行”——插件无法控制外部世界——而是：**崩溃后能识别未解决的不可逆动作，并阻止插件自己再次发起它。**

10,000 次 effects 调用的基准是 **733ms，0.073ms/次**。性能不是靠每次 O(n) 扫账本，而是内存索引 + 追加式文件。

## Artifacts：blob 已经写了，索引没写

Artifact 存储是内容寻址的：

```text
<root>/<first-two-hex>/<sha256>
```

写入先落 blob，再写索引。崩溃可能发生在两者之间。

实验让子进程写一个合法 blob，然后在索引之前被杀。新进程直接按 hash 读取并验证，成功；再调用 `artifact_reindex`，从磁盘上的 blob 重建索引。

结果：

```text
getContent = "artifact crash survivor"
verifyOk = true
reindexed = 1
listed = 1
```

这证明了 artifact 的完整性由内容本身保证，而不是由索引保证。索引可以丢，可以重建；blob 的字节必须和文件名 hash 一致。

限制也要说清楚：一个从未被索引过的 blob，重建时只能得到通用 media type 和 mtime，无法恢复原始 name/media type。索引元数据不是内容寻址的一部分。

## Audit：检测缺口，而不是自动修

审计链有 record hash 和 head anchor。head anchor 记录“应该有多少条记录”。

实验模拟一个崩溃窗口：追加一条合法记录，但不更新 head anchor。`audit_verify` 报告：

```text
head anchor expects 3 records
```

这证明缺口能被检测。但我们**没有**实现自动修复。原因是安全取舍：自动补 anchor 或截断记录，可能把篡改伪装成“修复”。正确做法是检测、报告，让操作者决定，必要时从外部 WORM/备份恢复。

这个实验是模拟窗口，不是真实 kill；它证明检测逻辑，不证明真实进程死亡下的全部行为。

## Budget：一个已确认的缺口

预算状态在内存里。实验里子进程累计 900 token，新进程启动后变成 0：

```text
beforeRestartUsed = 900
afterRestartUsed = 0
durable = false
```

这不是 bug 被修掉了，而是当前设计的限制。`budget` 是 per-process 报告/可选执行闸门，不承诺跨重启的 durable accounting。它保持 opt-in，并在文档里明确写出。

如果要把 budget 变成真正跨重启的 enforcement，需要持久化 used/reserved、去重 seq、处理并发和崩溃窗口。这是未来工作，不是一句“加个文件”能解决的。

## 多进程写入：锁住读-改-写

memory、repairs、knowledge 都是 per-workspace JSONL。两个 dsh 进程同时写会怎样？

- memory 追加不同 entry：可能交错；
- repairs 同一 signature 的 successCount：可能丢失更新；
- knowledge 同一 key 的 version：可能两个进程都算出同一个版本号。

修复方式是：每个 store 的写操作持有 per-file advisory lock，拿到锁后重新加载文件，再做读-改-写。这比“只在进程内加锁”更近一步，但仍然不是数据库事务。

测试用两个真实 Bun 进程，各写 25 条：

| Store | 结果 |
|---|---|
| memory | 50/50 行，50 个唯一 id |
| repairs | 最终 successCount = 50 |
| knowledge | 版本 1..50 连续，50 个唯一 id |

锁是 advisory 的：不阻止宿主 `write`/`edit`、外部编辑器或使用不同锁目录的进程。读者也可能看到并发写入前的快照。它解决的是“合作的 SuperDSH 调用之间不要互相覆盖”，不是“提供一个跨 store 的 ACID 事务”。

## 小结

崩溃一致性最重要的不是“加 try/catch”，而是：

1. 明确崩溃窗口在哪里；
2. 用真实进程杀死自己，而不是只在事件数组里模拟；
3. 区分“检测到异常”和“自动修复异常”；
4. 把无法解决的限制写进文档，而不是假装没有。

相关代码和实验：

- [`experiments/kill9-effects.ts`](../../experiments/kill9-effects.ts)
- [`experiments/kill9-artifacts.ts`](../../experiments/kill9-artifacts.ts)
- [`experiments/kill9-audit-anchor.ts`](../../experiments/kill9-audit-anchor.ts)
- [`experiments/kill9-budget.ts`](../../experiments/kill9-budget.ts)
- [`tests/concurrency.test.ts`](../../tests/concurrency.test.ts)
- [`docs/invariants.md`](../invariants.md)
