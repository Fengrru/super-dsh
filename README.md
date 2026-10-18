# SuperDSH

> Four evidence-gated superpowers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): reliable edits, cross-session project memory, a verification gate, and a tamper-evident audit ledger.

SuperDSH is a native dsh plugin bundle, not a fork. It is one ESM file with **zero runtime dependencies**, loaded through the ordinary Cordis plugin/profile mechanism. Every feature is independently switchable, and every feature that is on by default earned its place through a reproducible experiment. Features that failed their experiment are documented and left off.

## Why

dsh is an excellent plugin-first harness, but its public composition leaves several execution gaps:

| Gap | Consequence | SuperDSH feature |
|---|---|---|
| `edit` requires an exact, unique literal match | A model's remembered whitespace/CRLF/indentation drift fails the edit, or the agent retries blindly | `fuzzy_edit` with safety guards |
| No first-party long-term memory | A new session forgets project conventions and user preferences | File-backed project memory + automatic retrieval |
| No definition-of-done gate | An agent can claim success without running the project's tests | Verification gate that refuses to finish on failure |
| No tamper-evident audit | A plain JSONL log cannot prove that its records were not altered | Hash-chained audit ledger + `audit_verify` |

The fuzzy matcher is adapted from [`awesome-agent-infra`](https://github.com/Fengrru/awesome-agent-infra)'s `fuzzy-patch` package. The audit, verification, and "external state over self-report" ideas are inspired by [`nexus-runtime`](https://github.com/Fengrru/nexus-runtime)'s invariants. Neither project is a runtime dependency.

## Install

Build the bundle, then either load it as a local overlay or install it into a profile.

```sh
git clone https://github.com/Fengrru/super-dsh.git   # once published
cd super-dsh
bun install        # no dependencies; only needed for the build/test toolchain
bun run build      # emits dist/index.js
bun test           # deterministic integration checks
```

Local overlay (fastest for development):

```yaml
# super-dsh.patch.yml
- insert:
    - id: super-dsh
      name: '/absolute/path/to/super-dsh/dist/index.js'
      config:
        verify:
          command: 'bun test'   # optional; enables the verification gate
```

```sh
dsh --profile headless --patch ./super-dsh.patch.yml --json "fix the failing tests"
```

Persistent install:

```sh
dsh plugin --profile headless add /absolute/path/to/super-dsh
dsh --profile headless --dump-config | grep super-dsh
```

## Features

### `fuzzy_edit` (on by default)

A fallback tool beside dsh's `edit`. It locates the intended region with eight tolerant strategies, then applies the change through dsh's `ctx.fs.editText` with the **exact matched substring**, preserving atomicity, the read-before-edit policy, sandbox policy, and the unique-match rule.

Safety is the point: a missed edit is recoverable, a wrong edit is not. Before applying, SuperDSH requires unique bytes, matching start/end anchors, ≥98% token-multiset similarity, and a region covering at least half the requested non-empty lines. It refuses anything it cannot prove is the intended block.

### Project memory (on by default)

A small append-only JSONL store per workspace, outside the repository (under `$DSH_HOME/super-dsh/memory/`). The model can call `memory_save`, `memory_search`, and `memory_forget`; relevant entries are also injected automatically once per turn. Retrieval is lexical (TF-IDF-style scoring with tags, importance, recency, and basic CJK handling) and only injects entries that actually match the request.

The workspace path is resolved from the session's working directory, not from the harness process, so one dsh process can serve multiple sessions.

### Verification gate (opt-in)

When configured with a command, every turn in which the agent mutated files is checked before it can finish. A failure is returned to the agent as the next instruction, with the command's output tail. The gate gives up after `maxAttempts` so a broken environment cannot trap the session.

```yaml
config:
  verify:
    command: 'bun test'      # or npm test, cargo test, ...
    timeoutMs: 120000
    maxAttempts: 2
```

This feature is **off by default**. In the E3 experiment both arms passed 4/4 seeded tasks because `deepseek-flash` already ran the test suite unprompted; the gate showed no success gain and a modest output-token increase. It remains available as a guarantee for models or workflows that do not self-verify (see `docs/experiments.md`).

### Tamper-evident audit (on by default)

Every dsh session event is mirrored into a compact hash-chained ledger with a head anchor under `$DSH_HOME/super-dsh/audit/`. `audit_verify` checks record hashes, chain links, sequence monotonicity, and the anchor, and reports the first broken record. This is an integrity index, not a replacement for dsh's canonical JSONL session log.

## Configuration

All features can be disabled or configured per profile patch:

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

## Experiments

The project is organized around a simple rule: **a capability is a default only if an experiment supports it, and a guardrail must never regress.** Results from this machine (Windows 10, Node 24, DeepSeek `deepseek-flash`):

| Experiment | Baseline | SuperDSH | Verdict |
|---|---|---|---|
| Patch success under formatting drift (80 cases) | 33.8% correct | **90.0% correct** | Accept |
| Wrong-region edits under drift | 0 | **0** | Guardrail held |
| Ambiguous / no-match refusals | 100% | **100%** | Guardrail held |
| Audit tamper scenarios (4 kinds) | 0% detected | **100% detected** | Accept |
| Cross-session memory (2 pairs) | 0/2 recalled | **2/2 recalled** | Accept |
| Verification gate (4 seeded tasks) | 4/4 pass | 4/4 pass | No gain; keep opt-in |

Full methodology, corpus definitions, and raw result files are in [`docs/experiments.md`](docs/experiments.md) and [`experiments/`](experiments/).

Reproduce:

```sh
bun run experiment:patch
bun run experiment:units
# agent-level (needs DEEPSEEK_API_KEY and a sibling deepseek-harness checkout)
bun experiments/audit-bench.ts
bun run experiment:agent
```

## Design principles

- **Evidence gating.** Defaults are earned by experiments, not by enthusiasm. Rejected candidates and their reasons are recorded in [`docs/decisions.md`](docs/decisions.md).
- **Safety over recall.** Fuzzy edits refuse ambiguous or unprovable regions. Memory retrieval requires a lexical match before injecting anything. The verification gate has a bounded retry count.
- **External state.** Memory and audit live under `$DSH_HOME`, never in the user's repository. The workspace stays clean.
- **Failure containment.** Every feature is loaded in its own `try/catch`; a broken feature logs a warning and leaves the harness running.
- **Zero runtime dependencies.** The published bundle imports only Node built-ins. No version fights with the host.

## Known limitations

- dsh's public APIs are **pre-stable** (validated against `0.2.1-rc.2`). Plugin seams may change in future releases.
- `fuzzy_edit` handles a single replacement per call; `replace_all` is intentionally not exposed because fuzzy multi-region replacement is hard to prove safe.
- Memory retrieval is lexical, not embedding-based. Paraphrases with no shared tokens will not be recalled.
- The audit chain is unkeyed. It detects accidental edits, deletions, truncation, and reordering; an attacker with write access who recomputes the entire chain and anchor can forge a consistent ledger. Use an external WORM sink or signatures for an adversarial threat model.
- The verification gate runs a single configured command from the session's working directory. On Windows it terminates the process tree with `taskkill`.
- The agent-level experiments are small samples (2 memory pairs, 4 seeded verification tasks) and use one model; they are evidence, not a benchmark leaderboard.

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — plugin architecture and the host this project extends.
- [`Fengrru/awesome-agent-infra`](https://github.com/Fengrru/awesome-agent-infra) — `fuzzy-patch`, vendored and hardened here.
- [`Fengrru/nexus-runtime`](https://github.com/Fengrru/nexus-runtime) — event-log-as-truth, hash-chained audit, and verification invariants.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
