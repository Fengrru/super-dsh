# SuperDSH

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供四个经实验验证的超能力：可靠编辑、跨会话项目记忆、验证闸门、防篡改审计账本。

SuperDSH 不是 dsh 的 fork，而是原生 dsh 插件 bundle：单个 ESM 文件、**零运行时依赖**，通过 Cordis 插件/profile 机制加载。每个能力都可独立开关；默认开启的能力都必须有可复现实验支撑，未通过实验的能力会记录原因并保持关闭。

## 为什么做

dsh 的插件机制非常强，但公共组合在若干执行环节留有空白：

| 空白 | 后果 | SuperDSH 能力 |
|---|---|---|
| `edit` 要求精确且唯一的字面匹配 | 模型记住的空白/缩进/换行漂移导致编辑失败，或模型盲目重试 | `fuzzy_edit`（带安全护栏） |
| 没有第一方长期记忆 | 新会话忘记项目约定和用户偏好 | 文件式项目记忆 + 自动检索 |
| 没有「完成定义」闸门 | Agent 可能没跑测试就宣称成功 | 验证闸门：测试不过不许结束回合 |
| 没有防篡改审计 | 纯 JSONL 日志无法证明记录未被改动 | 哈希链审计账本 + `audit_verify` |

模糊匹配器改编自 [`awesome-agent-infra`](https://github.com/Fengrru/awesome-agent-infra) 的 `fuzzy-patch`。审计、验证以及「相信外部事实验证而非 Agent 自述」的思路来自 [`nexus-runtime`](https://github.com/Fengrru/nexus-runtime) 的不变量。两者都不是运行时依赖。

## 安装

先构建 bundle，然后以本地 overlay 加载，或安装到 profile：

```sh
git clone https://github.com/Fengrru/super-dsh.git   # 发布后
cd super-dsh
bun install        # 无运行时依赖，仅构建/测试需要
bun run build      # 生成 dist/index.js
bun test           # 确定性集成测试
```

本地 overlay（开发时最快）：

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

### `fuzzy_edit`（默认开启）

作为 dsh `edit` 的兜底工具：用 8 种容错策略定位目标区域，再用**精确匹配到的子串**调用 dsh 的 `ctx.fs.editText`，保留原子写、先读后写策略、沙箱策略和唯一匹配规则。

安全优先：漏改可恢复，错改不可恢复。应用前强制要求：匹配字节唯一、首尾锚点一致、Token 多重集相似度 ≥98%、覆盖区域至少达到请求块非空行数的一半。无法证明是目标块的编辑一律拒绝。

### 项目记忆（默认开启）

每个工作区一个追加式 JSONL 存储，位于仓库之外（`$DSH_HOME/super-dsh/memory/`）。模型可调用 `memory_save` / `memory_search` / `memory_forget`；每回合还会自动注入一次相关条目。检索是词法级的（TF-IDF 风格评分 + 标签、重要性、时新性、基础中文分词），只有真正匹配请求的条目才会被注入。

工作区路径来自 Session 的当前目录，而不是 harness 进程目录，因此一个 dsh 进程可以服务多个不同工作区的会话。

### 验证闸门（可选开启）

配置命令后，任何修改过文件的回合在结束前都会执行该命令；失败会带着输出尾部作为下一步指令反馈给 Agent。达到 `maxAttempts` 后放行，避免坏环境把会话困死。

```yaml
config:
  verify:
    command: 'bun test'      # 或 npm test, cargo test, ...
    timeoutMs: 120000
    maxAttempts: 2
```

该能力**默认关闭**。E3 实验中两组都通过了 4/4 个种子任务，因为 `deepseek-flash` 本来就会主动运行测试；闸门没有带来成功率提升，反而略微增加输出 token。它保留给不会主动自检的模型或工作流使用（见 `docs/experiments.md`）。

### 防篡改审计（默认开启）

每个 dsh Session 事件都会镜像到紧凑的哈希链账本，并维护 head anchor，位于 `$DSH_HOME/super-dsh/audit/`。`audit_verify` 会校验记录哈希、链链接、序号单调性和 anchor，并报告第一条损坏记录。它是完整性索引，不替代 dsh 自己的规范 JSONL 会话日志。

## 配置

所有能力都可以在 profile patch 中独立关闭或配置：

```yaml
- insert:
    - id: super-dsh
      name: 'dsh-super'
      config:
        fuzzyEdit: true
        memory:
          dir: 'C:/custom/memory'
          maxEntries: 500
          injectTopK: 4
          injectMaxChars: 1600
        audit:
          dir: 'C:/custom/audit'
        verify:
          command: 'node --test'
          timeoutMs: 60000
          maxAttempts: 2
```

## 实验

项目遵循一条简单规则：**只有实验支持的能力才能默认开启，且护栏指标不得回退。** 本机（Windows 10、Node 24、DeepSeek `deepseek-flash`）结果：

| 实验 | 基线 | SuperDSH | 结论 |
|---|---|---|---|
| 格式漂移下的补丁成功率（80 例） | 33.8% 正确 | **90.0% 正确** | 接受 |
| 漂移下的错区编辑 | 0 | **0** | 护栏保持 |
| 歧义/不匹配拒绝率 | 100% | **100%** | 护栏保持 |
| 审计篡改场景（4 类） | 0% 检出 | **100% 检出** | 接受 |
| 跨会话记忆（2 组） | 0/2 召回 | **2/2 召回** | 接受 |
| 验证闸门（4 个种子任务） | 4/4 通过 | 4/4 通过 | 无提升；保持可选 |

完整方法、语料定义和原始结果见 [`docs/experiments.md`](docs/experiments.md) 与 [`experiments/`](experiments/)。

复现：

```sh
bun run experiment:patch
bun run experiment:units
# Agent 级实验（需要 DEEPSEEK_API_KEY 和同级的 deepseek-harness 源码）
bun experiments/audit-bench.ts
bun run experiment:agent
```

## 设计原则

- **证据门槛**：默认值靠实验挣来，不靠热情。被拒绝的候选与原因记录在 [`docs/decisions.md`](docs/decisions.md)。
- **安全优先于召回**：模糊编辑拒绝歧义或无法证明的区域；记忆必须词法命中才注入；验证闸门有重试上限。
- **外部状态**：记忆和审计存放在 `$DSH_HOME`，绝不弄脏用户仓库。
- **故障隔离**：每个能力独立 `try/catch`，坏掉的能力只写警告，不影响 harness 运行。
- **零运行时依赖**：发布产物只 import Node 内置模块，不与宿主发生版本冲突。

## 已知限制

- dsh 公共 API 仍是 **pre-stable**（本插件验证于 `0.2.1-rc.2`），未来插件 seam 可能变化。
- `fuzzy_edit` 每次只处理单处替换；故意不暴露 `replace_all`，因为模糊多区域替换很难证明安全。
- 记忆检索是词法级的，不是 embedding。完全没有共享 token 的转述不会被召回。
- 审计链没有密钥。它能检测意外修改、删除、截断和重排；拥有写权限的攻击者若重算整条链和 anchor，可以伪造一致账本。对抗性威胁模型请接入外部 WORM 存储或签名。
- 验证闸门只执行一个配置命令；Windows 上用 `taskkill` 终止进程树。
- Agent 级实验样本很小（2 组记忆、4 个验证任务），且只用一个模型；它是证据，不是排行榜。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：插件架构与宿主。
- [`Fengrru/awesome-agent-infra`](https://github.com/Fengrru/awesome-agent-infra)：`fuzzy-patch`，本项目在其基础上加固。
- [`Fengrru/nexus-runtime`](https://github.com/Fengrru/nexus-runtime)：事件日志即事实源、哈希链审计、验证不变量。

## 许可证

MIT。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
