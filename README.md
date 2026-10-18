# SuperDSH

> A safety-first reliability suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): tolerant edits, transactional patches, an effects ledger, content-addressed artifacts, project memory, a repo map, versioned knowledge, scratchpads, deterministic compaction/reflection/handoff, a verification gate, audit evidence, and budget accounting.

SuperDSH is a native dsh plugin bundle, not a fork. It ships as one ESM file with **zero runtime dependencies**, loaded through the ordinary Cordis plugin/profile mechanism. Every feature is independently switchable. Features that are on by default have deterministic tests and a real-dsh smoke; the four core capabilities also have quantitative experiments. Features that failed their experiment are documented and left off.

## Why

dsh is an excellent plugin-first harness, but its public composition leaves execution gaps:

| Gap | Consequence | SuperDSH feature |
|---|---|---|
| `edit` requires an exact, unique literal match | Remembered whitespace/CRLF/indentation drift fails the edit | `fuzzy_edit` with safety guards |
| One edit per call, no multi-file transaction | A partial refactor can leave the workspace inconsistent | `apply_patch` with all-or-nothing preflight and rollback |
| No side-effect ledger | A crash between intent and result leaves an unknown external action | `effects` intent/commit ledger and restart reconciliation |
| No content-addressed artifacts | Reports/screenshots/patches are not verifiable later | `artifacts` SHA-256 store + `artifact_verify` |
| No first-party long-term memory | New sessions forget conventions and preferences | Project memory, TTL, MEMORY.md import/export |
| No repo-level symbol map | Agents grep blindly and miss callers | `repo_map`, `find_symbol`, `impact_of` |
| No scratchpad | Long tasks lose discoveries and decisions | Session notes + compaction |
| No versioned knowledge base | Facts are overwritten without history or trust state | `knowledge_*` with version chains and trust |
| No resumable handoff | Switching/compacting sessions loses the thread | Deterministic `handoff` report |
| No definition-of-done gate | An agent can claim success without running tests | Opt-in verification gate |
| No tamper-evident audit | A plain JSONL log cannot prove it was not altered | Hash-chained audit + evidence lookup |
| No token/cost accounting | Long sessions can overrun silently | Opt-in `budget` status/enforcement |

The fuzzy matcher is adapted from [`awesome-agent-infra`](https://github.com/Fengrru/awesome-agent-infra)'s `fuzzy-patch` package. The effects ledger, artifact vault, audit, and verification ideas are inspired by [`nexus-runtime`](https://github.com/Fengrru/nexus-runtime)'s invariants. Neither project is a runtime dependency.

## Install

```sh
git clone https://github.com/Fengrru/super-dsh.git   # once published
cd super-dsh
bun install        # no runtime dependencies; build/test toolchain only
bun run build      # emits dist/index.js
bun test           # 82 deterministic checks
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

### Editing

**`fuzzy_edit`** — a fallback beside dsh's `edit`. It locates the intended region with eight tolerant strategies, then applies the change through `ctx.fs.editText` with the exact matched substring, preserving atomicity, read-before-edit, sandbox policy, and unique-match. Safety guards: unique bytes, matching start/end anchors, ≥98% token-multiset similarity, at least half of the requested non-empty lines, and a size cap. A missed edit is recoverable; a wrong edit is not.

**`apply_patch`** — up to 10 files in one call. It reads and resolves every edit first, refuses duplicate paths, computes all replacements with fuzzy guards, and only then writes. If any write fails, it restores the original contents in reverse order. The result reports strategy and matched characters per file.

### Context and knowledge

**Project memory** — append-only JSONL per workspace under `$DSH_HOME/super-dsh/memory/`. Tools: `memory_save` (with optional `ttl_days`), `memory_search`, `memory_forget`, `memory_export`/`memory_import` (MEMORY.md style). Relevant, non-expired entries are injected once per turn; retrieval is lexical with tags, importance, recency, usage, and basic CJK handling.

**Session notes** — `note_append`, `note_read`, `note_compact` for a per-session scratchpad. Session ids are sanitized into filenames; malformed lines are isolated; compaction rewrites atomically.

**Repo map** — `repo_map`, `find_symbol`, `impact_of`. A zero-dependency regex index for TS/JS, Python, Rust, Go, and Java with imports, name-reference edges, PageRank ranking, file mtime/size invalidation, and per-file-path symbol ids (same-named symbols never overwrite each other). It is a heuristic: confirm with `read` before editing.

**Knowledge base** — `knowledge_add`, `knowledge_search`, `knowledge_history`, `knowledge_verify`, `knowledge_forget`. Append-only version chains per key, trust states (`draft`/`verified`/`disputed`), TTL, and archived tombstones. Search returns the latest non-expired, non-disputed version per key; optional pre-step injection is trusted-only.

**Handoff** — `handoff` reads the persisted session via `sessionQuery` and produces a deterministic Markdown report: real user requests (injected runtime context is filtered), final answer, tool counts, errors, touched files (including `apply_patch.edits`), commands, unfinished turns, and a resume checklist. No model call.

**History compaction** — `history_compact` produces a budgeted Markdown summary from the persisted session: goal, one line per turn (request, assistant text, tools, changed files, errors), current state, and three next steps. It preserves the goal and current state under pressure, drops older progress first, and reports the original/compact character counts and ratio. No model call.

**Reflection** — `reflect` reviews a session deterministically: repeated identical calls, aggregated tool errors, touched files, unfinished turns, and whether a verification command was observed. It emits fixed rule-based suggestions (e.g., "files changed without verification"). No model call.

### Execution safety and observability

**Effects ledger** — every tool call gets hashed arguments and an intent record; results become `committed`/`failed`. A new process marks leftover pending intents as `unknown`; `effect_status` reports unresolved work. `denyUnresolvedIrreversible` (opt-in) blocks a repeated irreversible call with the same key. Pure tools are classified separately; shell commands matching dangerous patterns are irreversible.

**Artifacts** — `artifact_put`, `artifact_get`, `artifact_verify`, `artifact_list`. SHA-256 content addressing, atomic temp+rename writes, an append-only index, hash re-verification on every read, and text/base64 round-trip. A tampered or missing blob fails verification instead of being trusted.

**Audit** — every session event is mirrored into a hash-chained ledger with a head anchor. `audit_verify` checks record hashes, chain links, sequence monotonicity, and the anchor; `audit_evidence` looks up an event data hash. Unkeyed: it detects edits, deletions, truncation, and reordering, not a full rewrite by an attacker with write access.

**Verification gate (opt-in)** — after file mutations, `agent/turn-stopping` runs the configured command; failures return to the agent with an output tail, bounded by `maxAttempts`. Off by default because the E3 experiment showed no gain with `deepseek-flash` (it already ran tests unprompted).

**Budget (opt-in)** — accumulates `assistant/message` and `compaction/summary` usage per session; `budget_status` reports used/remaining/exhausted. With `enforce: true`, `agent/request` refuses a request once the limit is reached.

## Configuration

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

## Experiments and checks

The rule stays the same: **a capability is a default only if checks support it, and a guardrail must never regress.**

Quantitative experiments on this machine (Windows 10, Node 24, DeepSeek `deepseek-flash`):

| Experiment | Baseline | SuperDSH | Verdict |
|---|---|---|---|
| Patch success under formatting drift (80 cases) | 33.8% correct | **90.0% correct** | Accept |
| Wrong-region edits under drift | 0 | **0** | Guardrail held |
| Ambiguous / no-match refusals | 100% | **100%** | Guardrail held |
| Cross-session memory (2 pairs) | 0/2 recalled | **2/2 recalled** | Accept |
| Audit tamper scenarios (4 kinds) | 0% detected | **100% detected** | Accept |
| Verification gate (4 seeded tasks) | 4/4 pass | 4/4 pass | No gain; keep opt-in |

Deterministic suite checks and real-dsh smoke for the 0.2 features:

- `bun test`: **82 tests / 427 assertions** across effects, artifacts, apply_patch rollback, notes path safety, repo-map same-name symbols and mtime invalidation, knowledge version/trust/expiry, handoff, history compaction/reflection, budget, memory TTL/import-export, audit evidence, fuzzy edits, and the verification gate.
- Real dsh headless smoke: `artifact_put` + `note_append` succeeded, `effect_status` showed 2 committed / 0 unresolved; `apply_patch` edited 2 files atomically; `repo_map` found `start` in `a.ts`; `knowledge_add` created v1; `handoff` summarized 43 events with no model call; `history_compact` and `reflect` returned deterministic reports from a live session.
- Effects crash/duplicate denial, artifact tamper detection, and apply_patch rollback are covered deterministically; they do not yet have agent-level A/B numbers, so they are described as deterministic guarantees, not benchmark wins.

Full methodology and raw results: [`docs/experiments.md`](docs/experiments.md), [`experiments/`](experiments/). The item-by-item assessment of all 88 source components: [`docs/analysis/`](docs/analysis/README.md).

## Design principles

- **Safety over recall.** Fuzzy edits refuse ambiguous regions. `apply_patch` preflights everything before writing. Memory only injects lexical matches. Artifacts re-verify hashes. Effects deny only when explicitly configured.
- **External state.** Memory, notes, knowledge, effects, artifacts, and audit live under `$DSH_HOME`, never in the user's repository.
- **Failure containment.** Every feature loads in its own `try/catch`; one broken feature cannot take down the harness.
- **Zero runtime dependencies.** The published bundle imports only Node built-ins.
- **Deterministic first.** Handoff, compaction-safe notes, repo map, effects, and artifacts avoid model calls; model calls are reserved for features that need them.

## Known limitations

- dsh's public APIs are **pre-stable** (validated against `0.2.1-rc.2`).
- `fuzzy_edit` handles one region per call; `replace_all` is intentionally not exposed.
- `apply_patch` rollback is best-effort: if a restore write itself fails, the error lists the files that could not be restored. There is no filesystem-level transaction or cross-process lock.
- The repo map is regex-based, not type-aware; comments/strings can produce false positives, compressed one-line code is under-indexed, and mtime+size is the cache key.
- Effects and knowledge are append-only JSONL without cross-process locks; notes the same. Do not run two processes writing the same session/workspace concurrently.
- The audit chain is unkeyed; use an external WORM sink or signatures for an adversarial threat model.
- Handoff filters known injected-context markers heuristically; unknown future injected formats may appear as user requests.
- The verification gate runs one configured command and fails open after `maxAttempts`.
- `budget` accumulates event usage; it does not price tools or subagents, and enforcement is opt-in.
- The 88-item analysis is a roadmap, not a claim that every item is implemented. Version 0.2.0 ships the features above; C/D items remain deferred or rejected.

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — plugin architecture and the host this project extends.
- [`Fengrru/awesome-agent-infra`](https://github.com/Fengrru/awesome-agent-infra) — `fuzzy-patch`, vendored and hardened here; several memory/compaction/scratchpad ideas.
- [`Fengrru/nexus-runtime`](https://github.com/Fengrru/nexus-runtime) — effects ledger, content-addressed artifacts, audit, and verification invariants.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
