# SuperDSH

[![CI](https://github.com/Fengrru/super-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/Fengrru/super-dsh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.2-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)

> A safety-first reliability suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): tolerant edits, transactional patches with file locks, recovery plans for side effects, signed tamper-evident audit, content-addressed artifacts, tiered project memory, error-repair memory, a repo map, versioned knowledge, scratchpads, deterministic compaction/reflection/handoff, replay plans, budget reservation, log retention, and tested protocol libraries.

SuperDSH is a native dsh plugin bundle, not a fork. It ships as one ESM file with **zero runtime dependencies**, loaded through the ordinary Cordis plugin/profile mechanism. Every feature is independently switchable. Features that are on by default have deterministic tests and a real-dsh smoke; key capabilities also have quantitative experiments, and the default profile itself was chosen by an agent A/B. Features that failed their experiment are documented and left off.

## Why

dsh is an excellent plugin-first harness, but its public composition leaves execution gaps:

| Gap | Consequence | SuperDSH feature |
|---|---|---|
| `edit` requires an exact, unique literal match | Remembered whitespace/CRLF/indentation drift fails the edit | `fuzzy_edit` with safety guards |
| No multi-file transaction | A partial refactor can leave the workspace inconsistent | `apply_patch` with preflight, rollback, and file locks |
| No side-effect ledger | A crash between intent and result leaves an unknown external action | `effects` intent/commit, `effect_reconcile`, `effect_resolve` |
| No content-addressed artifacts | Reports/screenshots/patches are not verifiable later | `artifacts` SHA-256 store + `artifact_verify` |
| No first-party long-term memory | New sessions forget conventions and preferences | Project memory, TTL, MEMORY.md import/export |
| No repo-level symbol map | Agents grep blindly and miss callers | `repo_map`, `find_symbol`, `impact_of` |
| No scratchpad | Long tasks lose discoveries and decisions | Session notes + compaction |
| No versioned knowledge base | Facts are overwritten without history or trust state | `knowledge_*` version chains and trust |
| No resumable handoff | Switching/compacting sessions loses the thread | Deterministic `handoff` + machine-readable `replay_plan` |
| No definition-of-done gate | An agent can claim success without running tests | Opt-in verification gate |
| No tamper-evident audit | A plain JSONL log cannot prove it was not altered | Hash chain, HMAC signatures, evidence lookup, export |
| No token/cost accounting | Long sessions can overrun silently | Opt-in budget with reserve/settle |

The plugin has no runtime dependencies. Third-party license notices are recorded in [NOTICE](NOTICE).

## Install

SuperDSH is distributed from GitHub; it is not published to npm. Build it locally:

```sh
git clone https://github.com/Fengrru/super-dsh.git
cd super-dsh
bun install        # no runtime dependencies; build/test toolchain only
bun run build      # emits dist/index.js
bun test           # 233 deterministic checks
dsh plugin --profile headless add /absolute/path/to/super-dsh
```

`dsh plugin add` uses `pnpm`; make sure `pnpm` is on `PATH`. No npm registry
package is required.

Local overlay:

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

## Profiles

The default is **core**: the safety/recovery surface without repository-map, session-report, or operational extras.

| Profile | Tools | Schema tokens/request | Contents |
|---|---:|---:|---|
| **core** (default) | 21 | 2,953 | fuzzy edit, apply_patch, memory, audit, effects, artifacts |
| coding | 37 | 4,984 | core + repo map/search_code, notes, knowledge, handoff/replay, compact/reflection |
| full | 41 | 5,610 | coding + verify/budget/retention when configured |

The profile is selected in the plugin config; explicit feature flags override it. Ready-made overlays live in [`presets/`](presets/).

```yaml
config:
  profile: coding
```

**Why core is the default:** a 5-task agent A/B (navigation + multi-file fixes) scored **core 5/5 and coding 5/5**, while coding consumed **25,357 input tokens vs 18,490** (~37% more). The coding tools did not improve task success in that sample, so they are opt-in until an agent benchmark shows a win. The A/B ran before repair memory became opt-in, so both arms included it; the current core is 21 tools. See `experiments/results/profile-ab-bench.json` and `docs/experiments.md` E12.

**Repair memory is opt-in.** A separate 16-task agent A/B with the same tool surface in both arms found **16/16 passes in both arms**, with **+9.1% input tokens** and **+15.4% output tokens** when hints were injected. The hints did reach 16/16 treatment sessions, so this is a measured null result, not a wiring failure. Enable it with `repairs: true`; see E14.

## Features

### Editing

**`fuzzy_edit`** — a fallback beside dsh's `edit`. It locates the intended region with eight tolerant strategies, then applies the change through `ctx.fs.editText` with the exact matched substring, preserving atomicity, read-before-edit, sandbox policy, and unique-match. Safety guards: unique bytes, matching start/end anchors, ≥98% token-multiset similarity, at least half of the requested non-empty lines, and a size cap. A missed edit is recoverable; a wrong edit is not.

**`apply_patch`** — up to 10 files in one call. It acquires cross-process advisory file locks, reads and resolves every edit first, refuses duplicate paths, computes all replacements with fuzzy guards, and only then writes. If any write fails, it restores the original contents in reverse order. The result reports strategy and matched characters per file.

### Context and knowledge

**Project memory** — append-only JSONL per workspace under `$DSH_HOME/super-dsh/memory/`. Tools: `memory_save` (TTL, tier, confidence, derived_from, supersedes), `memory_search`, `memory_forget`, `memory_feedback`, `memory_invalidate`, `memory_consolidate`, `memory_export`/`memory_import` (MEMORY.md style). Three tiers: `core` rules are injected first, `long` facts are retrieved by relevance, `working` entries are scoped to one session. Retrieval combines lexical scoring with confidence, tier, importance, recency, and usage. `memory_consolidate` deterministically merges near-duplicates, archives expired/over-cap entries, and promotes frequently used facts. `derivedFrom` links cascade to `stale` on update/forget, so obsolete conclusions stop being injected.

**Error-repair memory (opt-in)** — `repair_record` stores a normalized error signature (tool + code + path/number/UUID-normalized message) with a fix hint; `repair_search`/`repair_list` retrieve it. On a matching tool error or a shell command with a non-zero exit, `tools/post-execute` attaches the prior hint as data, not instructions. Unknown errors are not guessed. The 16-task A/B found no success gain and higher token use on single-file fixes, so the three repair tools and automatic hints are not in the default profile.

**Log retention (opt-in)** — `archive_ledgers` gzips old audit ledgers plus their head anchors, writes a SHA-256 manifest, verifies the gzip round-trip, and only deletes sources when explicitly requested. `restore_archive` validates every entry before writing and refuses path traversal, symlinks, and overwrites.

**Session notes** — `note_append`, `note_read`, `note_compact`. Session ids are sanitized into filenames; malformed lines are isolated; compaction rewrites atomically.

**Repo map** — `repo_map`, `find_symbol`, `impact_of`, `search_code`. Zero-dependency regex index for TS/JS, Python, Rust, Go, Java with imports, reference edges, PageRank, mtime/size invalidation, and per-file symbol ids (same-named symbols never overwrite each other). `search_code` routes natural-language queries to definition/caller/text modes and merges the results. Heuristic: confirm with `read` before editing.

**Knowledge base** — `knowledge_add`, `knowledge_search`, `knowledge_history`, `knowledge_verify`, `knowledge_forget`. Append-only version chains per key, trust states, TTL, archived tombstones. Search returns the latest non-expired, non-disputed version per key; optional pre-step injection is trusted-only.

**Handoff** — `handoff` reads the persisted session via `sessionQuery` and produces deterministic Markdown: real user requests (injected context filtered), final answer, tool counts, errors, touched files (including `apply_patch.edits`), commands, unfinished turns, and a resume checklist. No model call.

**Replay plan** — `replay_plan` produces the machine-readable counterpart: `read` for changed files, `rerun` for failed tools/commands, `verify` for observed test/lint/build/check commands, and `inspect` for unfinished/interrupted turns. This is the resume plan, not prose.

**History compaction** — `history_compact` produces a budgeted deterministic summary: goal, one line per turn, current state, and next steps. It preserves goal/current state under pressure, drops older progress first, and reports original/compact character counts and ratio. No model call.

**Reflection** — `reflect` reviews repeated identical calls, aggregated tool errors, touched files, unfinished turns, and whether verification was observed; it emits fixed rule-based suggestions. No model call.

### Execution safety and observability

**Effects ledger** — every tool call gets hashed arguments and an intent record; results become `committed`/`failed`. A new process marks leftover pending intents `unknown`; `effect_status` reports unresolved work; `effect_reconcile` returns an explicit `replay` / `compensate` / `query` plan; `effect_resolve` records the human/external outcome. The ledger is loaded into memory once per session (10k calls in 733 ms, 0.073 ms/call). `denyUnresolvedIrreversible` (opt-in) blocks a repeated irreversible call after a crash, including `unknown` predecessors.

**Artifacts** — `artifact_put`, `artifact_get`, `artifact_verify`, `artifact_list`, `artifact_reindex`. SHA-256 content addressing, atomic temp+rename writes, append-only index, hash re-verification on every read, text/base64 round-trip. Tampered/missing blobs fail verification; `artifact_reindex` rebuilds a lost index from the blobs, and a never-indexed blob is still readable by hash.

**Audit** — every session event is mirrored into a hash-chained ledger with a head anchor. `audit_verify` checks hashes, chain links, sequence monotonicity, anchor, and optional HMAC signatures; `audit_evidence` looks up an event data hash; `audit_export` returns head/verification and optionally up to 5000 records. HMAC-SHA256 signatures (`signingKeyEnv`/`signingKey`) make re-hashed record tampering detectable. Unkeyed by default: detects edits, deletions, truncation, and reordering, not a full rewrite by an attacker with write access.

**Verification gate (opt-in)** — after file mutations, `agent/turn-stopping` runs the configured command; failures return to the agent with an output tail, bounded by `maxAttempts`. Off by default because E3 showed no gain with `deepseek-flash` (it already ran tests unprompted).

**Budget (opt-in)** — accumulates `assistant/message` and `compaction/summary` usage; `budget_status` reports used/reserved/remaining/exhausted. Used tokens and seq dedupe persist under `$DSH_HOME/super-dsh/budget`, so a restart does not reset accounting; reservations remain in-memory. `enforce: true` refuses over-budget requests; `reservePerRequest` adds reserve/settle/release with request-error and turn-end cleanup.

### Protocol libraries

Tested TS building blocks, not model-facing tools:

- **Capability tokens** — HMAC-SHA256 scopes/session/task/expiry, realpath-aware `fs:read:<path>` / `fs:write:<path>` boundaries (no `startsWith` bypass).
- **Causal clock** — vector-clock tick/merge/compare/serialize for future multi-subagent fan-in.
- **Worker protocol** — JSON-RPC 2.0 NDJSON codec for `execute`/`checkpoint`/`result`/`cancel`, plus a deadline-aware task state machine.
- **File locks** — cross-process advisory locks with stale-owner takeover and TTL; used by `apply_patch`.

## Configuration

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
        # repairs:          # opt-in: adds 3 tools and automatic hints
        #   maxEntries: 500
        retention:
          maxAgeDays: 30
          deleteSource: false
        notes:
          maxEntriesPerSession: 500
        repoMap:
          maxFiles: 2000    # default 1000; raise for larger repositories
          maxFileBytes: 524288
          search: true
          refreshMs: 5000   # 0 = check the cache signature on every call
        knowledge:
          injectTopK: 0
        effects:
          denyUnresolvedIrreversible: false
        artifacts: true
        audit:
          signingKeyEnv: 'SUPER_DSH_AUDIT_KEY'   # optional HMAC
        handoff: true
        historyCompact: true
        reflection: true
        replayPlan: true
        budget:
          maxTokens: 200000
          enforce: false
          reservePerRequest: 0
          # dir: 'C:/custom/budget'   # default: $DSH_HOME/super-dsh/budget
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
| Cross-session memory (10 pairs) | 0/10 recalled | **10/10 recalled** | Accept |
| Memory core-tier (10 trials) | 0/10 (long) | **9/10 (core)** | Accept core tier |
| search_code navigation (8 tasks) | 8/8, 8,679 input tokens | 8/8, **15,840** input tokens | Keep opt-in |
| Audit tamper scenarios (4 kinds) | 0% detected | **100% detected** | Accept |
| Verification gate (4 seeded tasks) | 4/4 pass | 4/4 pass | No gain; keep opt-in |

Execution-layer validation (current counts):

- `bun test`: **233 tests / 1,460 assertions** across 27 files, including schema-subset validation for every registered tool.
- Effects 10,000 calls: **733 ms total, 0.073 ms/call** (20,000 ledger records, 5.5 MB), down from ~33 ms/call.
- Real kill-9 (`experiments/kill9-effects.ts`): a separate Bun process records an irreversible intent, is killed with `taskkill /F /T` or `SIGKILL`, a new process reconciles it to `unknown`, and the repeated irreversible call is denied — **duplicateDenied=true, duplicateExecutions=0**; the committed control still allows a repeat.
- Audit: HMAC signatures, stripped/rehashed tamper detection, export with head/verify, and a byte-pinned golden fixture.
- Replay plan, file locks, budget reserve/settle, capability tokens, causal clock, and worker protocol have deterministic tests; real-dsh smoke exercised `audit_export`, `effect_reconcile`, `replay_plan`, `apply_patch`, repo map, notes, artifacts, knowledge, handoff, history compaction, and reflection.
- Effects crash, artifact crash/tamper, and apply_patch rollback are deterministic guarantees or real-process experiments; they do not yet have agent-level A/B numbers, so they are not presented as benchmark wins.

Memory/repair/retention validation:

- Memory v2 consolidation (`experiments/memory-v2-bench.ts`): 60 facts, recall@3 **1.000 before and after**, stale injections **0**, injected chars **13,775 → 12,565**; 15 duplicates merged, 20 entries archived (merged/expired/cap).
- Repair memory (`experiments/repair-bench.ts`): 5 hints, known errors hit **10/10**, correct hint **10/10**, unknown errors false-hit **0/10**, average injected context 212 chars.
- Retention: gzip + SHA-256 manifest, verified delete, restore, path traversal/symlink/overwrite refusal (`tests/retention.test.ts`).

Profile/performance/crash validation:

- Profile A/B (`experiments/profile-ab-bench.ts`): core **5/5**, coding **5/5**, input tokens **18,490 vs 25,357**, output **3,740 vs 5,605**; default is now core.
- Repo map (`experiments/repo-map-perf.ts`, 2,000 files): cold **2.4–4.6 s** (latest 4,607.7 ms; was 33.3 s), TTL warm p50 **0.1 ms**, forced unchanged rescan p50 **230–363 ms**.
- Kill-9 artifacts: a blob written without an index is readable/verifiable after a real process kill, and `artifact_reindex` restores the index.
- Audit anchor gap: a record appended without a head update is detected (`head anchor expects N records`), no repair.
- Budget restart: used-token accounting is durable (900 → 900); reservations remain in-memory.

Repair/default/concurrency/memory validation:

- Repair A/B (`experiments/repairs-ab-bench.ts`): 16 tasks, both arms 16/16; treatment input **31,156 vs 28,546** (+9.1%), output **+15.4%**; hints were observed in **16/16** treatment sessions and **0/16** baseline sessions. Pre-registered rule: no +2 pass win and no 15% token reduction, so `repairs` moves to opt-in and core drops from 24 to 21 tools.
- Memory replication (`experiments/agent-bench.ts`): 10 cross-session pairs, baseline **0/10**, treatment **10/10**; session-2 output tokens **222–678** vs **44–107**.
- Memory core-tier A/B (`experiments/memory-tier-bench.ts`): baseline long **0/10**, core **9/10**; the fact was injected 10/10 core vs 0/10 long, at +4.3% input tokens.
- search_code A/B (`experiments/search-code-ab-bench.ts`): both arms **8/8**, but the repo-map arm used **15,840 vs 8,679 input tokens** (+82.5%); repo map stays opt-in.
- Budget durability (`experiments/kill9-budget.ts`): used tokens survive a restart **900 → 900**; reservations remain in-memory.
- Cross-process stores: two Bun processes each write 25 rows to the same memory, repair, and knowledge files. All 50 memory rows and 50 knowledge versions survive; repair `successCount` reaches 50; versions are contiguous and ids unique (`tests/concurrency.test.ts`).
- Package install smoke: `npm pack` → `dsh plugin add` → `--dump-config` in an isolated `DSH_HOME`; the profile contains `id: super-dsh` (`scripts/install-smoke.ts`, also in CI).
- Shell-failure hints: repair memory now treats a dsh shell result with `exitCode != 0` as a recoverable failure even though dsh reports it as `isError: false`; a deterministic test covers the injection and the zero-exit/non-shell controls.

Optional-feature experiments (pre-registered decision rules):

| Candidate | Result | Decision |
|---|---|---|
| Best-of-N planning (max-mode) | baseline 0.986, judge 0.995, oracle 1.000, judge top-1 75%, **2.64× tokens**; ceiling effect | **Do not add** |
| Agentic search | hit@5 **80% → 100%**, MRR **0.70 → 0.90**, warm 1.37× latency, cold index 165 ms | **Added as `search_code`** (retrieval-level evidence; caller MRR has a comment-noise caveat) |
| Skill curation | synthetic hit@3 83.3% → 100%, stale slots 25% → 0%, but only synthetic data | **Defer** until real skill corpus/agent tasks |

Full methodology and raw results: [`docs/experiments.md`](docs/experiments.md), [`experiments/`](experiments/). Invariant mapping: [`docs/invariants.md`](docs/invariants.md). Exact coverage and remaining gaps: [`docs/status.md`](docs/status.md).

## Design principles

- **Safety over recall.** Fuzzy edits refuse ambiguous regions. `apply_patch` preflights before writing and locks target files. Memory only injects lexical matches. Artifacts re-verify hashes. Effects deny only when explicitly configured.
- **External state.** Memory, notes, knowledge, effects, artifacts, and audit live under `$DSH_HOME`, never in the user's repository.
- **Failure containment.** Every feature loads in its own `try/catch`; one broken feature cannot take down the harness.
- **Zero runtime dependencies.** The published bundle imports only Node built-ins.
- **Deterministic first.** Handoff, replay plans, compaction, reflection, repo map, effects, artifacts, locks, and budget do not call a model.

## Known limitations

- dsh's public APIs are **pre-stable** (validated against `0.2.1-rc.2`).
- `fuzzy_edit` handles one region per call; `replace_all` is intentionally not exposed.
- `apply_patch` rollback is best-effort: if a restore write itself fails, the error lists files that could not be restored. Locks are advisory: host `write`/`edit`, external editors, and processes with a different lock dir can bypass them. TTL/symlink/case/normalization caveats apply.
- The repo map is regex-based, not type-aware; comments/strings can produce false positives, compressed one-line code is under-indexed, and mtime+size is the cache key. It indexes at most `repoMap.maxFiles` files (default 1000); a 2,000-file cold build takes ~2.4–4.6 s. Reference graphs are bounded at 50k edges, 20 definitions per token, and 10 PageRank iterations, so centrality can be approximate on very dense repositories. `refreshMs` defaults to 5 s, so a query can see an index up to 5 s stale after an edit (forced unchanged rescan is ~230–363 ms). `search_code` routes by keyword and still inherits those limits; caller-mode references include comments (which can lower MRR). Set `repoMap.search: false` to hide the extra tool.
- Effects and session notes are append-only JSONL per session without cross-process locks; do not run two processes writing the same session concurrently. Memory, repairs, and knowledge serialize their read-modify-write cycles with advisory locks, but readers can still observe a snapshot from before a concurrent write.
- Memory v2 retrieval is still lexical (no embeddings); consolidation is deterministic token/Jaccard merging, not semantic summarization. `working` entries are session-scoped by the session id available at save time.
- Repair memory is opt-in. The 16-task A/B was a ceiling experiment on single-file fixes: it shows no benefit and a token cost there, not that hints can never help on harder, cross-session failures.
- Error-repair matching is lexical and tool/code-filtered; a hint can be wrong for a superficially similar error. Hints are injected as data, not enforced.
- Retention is opt-in and can delete source ledgers when `delete_source`/`deleteSource` is true; it verifies gzip and SHA-256 before deletion, but backup policy is the operator's responsibility.
- Audit is unkeyed by default; HMAC signing protects record hashes but key management is the operator's responsibility. A full rewrite with the key can still forge a consistent ledger.
- Handoff/replay-plan filtering of injected context is heuristic; unknown future formats may appear as user requests.
- The verification gate runs one configured command and fails open after `maxAttempts`.
- `budget` accumulates event usage; the used-token ledger is persisted under `$DSH_HOME/super-dsh/budget` (kill-9: 900 → 900), while reservations are in-memory and cleared on restart. Tools/subagents are not individually priced.
- The capability/causal/worker modules are tested libraries, not exposed tools; no remote worker runtime is included. Checkpoint identity, determinism context, and full event replay are dsh host responsibilities, not claimed by this plugin.
- The default profile is `core`; the additional coding/full tools register only when explicitly configured. The 5-task A/B is small and does not prove coding tools are never useful.
- Version 0.2.0 is the current release and ships the features above. Remaining gaps are tracked in [docs/status.md](docs/status.md).

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — plugin architecture and the host this project extends.
- Third-party license notices are listed in [NOTICE](NOTICE).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
