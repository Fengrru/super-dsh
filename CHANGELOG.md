# Changelog

## 0.6.0

Evidence-driven default change and concurrency hardening:

- **Repair memory is now opt-in.** A pre-registered 16-task agent A/B kept the same tool surface in both arms; the treatment received a task-specific hint after the real `node --test` failure. Both arms passed **16/16**, while the treatment used **31,156 vs 28,546 input tokens (+9.1%)** and **14,259 vs 12,358 output tokens (+15.4%)**. Session logs confirm hints reached **16/16** treatment sessions. Because the rule required +2 passes or −15% input tokens, `repairs` moved out of `core`; enable it with `repairs: true`. Core is now **21 tools / 2,953 schema tokens**, coding **37 / 4,984**, full **41 / 5,610**.
- **Shell failures are now visible to repair memory.** dsh reports a non-zero shell exit as `isError: false`; the post-execute hook now treats a structured foreground result with `exitCode != 0` as a recoverable failure, using stderr/stdout text for matching. Deterministic tests cover injection, zero exit, and non-shell controls.
- **Cross-process store safety.** Memory, repair, and knowledge read-modify-write cycles now hold a per-file advisory lock and reload after acquisition. Two-process tests write 25 rows each: 50/50 memory rows and knowledge versions survive, repair `successCount` reaches 50, and knowledge versions are contiguous with unique ids.
- **Package install smoke.** `scripts/install-smoke.ts` packs the published file set, installs it with `dsh plugin add` into an isolated `DSH_HOME`, and asserts the profile entry. It runs in CI after the build.
- **Docs and release material.** Profile counts, experiments E14–E16, status, decisions, presets, and both READMEs are updated. `experiment:repairs` and `smoke:install` scripts are available.
- **Tests** — 221 tests / 1,404 assertions across 26 files.

## 0.5.0

Profiles, repo-map performance, crash coverage, and release engineering:

- **Profiles** — `core` (24 tools, now the default), `coding` (40), `full` (44). `profile` selects a feature set, explicit flags override it, and `presets/` ships ready-made overlays. `full` registers verify/budget/retention only when configured.
- **Profile A/B** — 5 navigation/edit tasks, isolated workspaces, real dsh headless on `deepseek-flash`: core **5/5** and coding **5/5**; coding used **25,357 vs 18,490 input tokens**, **5,605 vs 3,740 output tokens**, and **101.5 s vs 86.3 s** wall time. Pre-registered rule picks the lower-token arm on a tie, so the default is `core`.
- **Repo-map performance** — concurrent source reads (32), TTL refresh cache (`repoMap.refreshMs`, default 5,000 ms), precomputed sorted symbol list, and bounded PageRank/edges/definitions. On the 2,000-file dsh checkout: cold **2.4 s** after the OS cache is warm (**4.5 s** on the first uncached run, from 33.3 s), TTL warm p50 **0.1 ms**, forced unchanged rescan p50 **230–363 ms**.
- **`artifact_reindex`** — rebuilds a lost artifact index from the content-addressed blobs. A real kill-9 experiment writes a blob, kills the writer before indexing, then reads/verifies it and reindexes from a new process.
- **Crash coverage** — real kill-9 artifacts (covered), audit anchor gap detection (detected, no repair), and budget restart loss (900 → 0, confirmed limitation). `docs/invariants.md` and `docs/status.md` are updated.
- **Repo engineering** — `tsconfig.json` + `bun run typecheck`, `bun run test:coverage`, a CI matrix on Ubuntu and Windows, a lockfile, and experiments for profiles/repo performance.
- **Tests** — 221 tests / 1,404 assertions across 26 files, including a schema-subset guard for every registered tool.

## 0.4.0

Memory and recovery upgrades from awesome-agent-infra, implemented without its data bugs:

- **Memory v2** — tiers (`core`/`long`/`working`), session-scoped working memory, confidence/feedback, `memory_invalidate` causal cascade through `derivedFrom`, `supersedes`, deterministic `memory_consolidate` (dedupe, expire, promote, per-tier caps), tiered core+relevant injection, JSONL/Markdown compatibility.
- **Error-repair memory** — cross-session `repair_record`/`repair_search`/`repair_list`, normalized error signatures, `tools/post-execute` auto-hint injection on matching errors.
- **Log retention** — opt-in `archive_ledgers` with gzip + SHA-256 + manifest + verified deletes, and `restore_archive` with path-traversal/symlink/overwrite guards.
- **`search_code`** — experiment-supported natural-language routing to definition/caller/text modes over the repo map (hit@5 80%→100%, MRR 0.70→0.90 on the fixture benchmark). `repoMap.search: false` disables it.
- **Deferred-candidate experiments** — Best-of-N planning: do not add (ceiling effect, 2.64× tokens); Valid8 gate: do not add (10% buggy detection); skill curation: defer (synthetic-only evidence).
- **Research prototypes** — POMDP, reasoning-search, process-reward, agent-metacog, hallucination-detector, and code-sandbox were each tested; all six are do-not-add (ties greedy / empty MCTS / AUC 0.5 / worse calibration / F1 0.615 / 1-of-7 sandbox escape).
- **Benchmarks** — memory consolidation: 60 facts, recall@3 1.0 before/after, stale injections 0, injection chars 13775→12565; repair memory: known-error hit 10/10, correct hint 10/10, unknown-error false hits 0/10.
- **Schema guard** extended to the new tools; repair parameter schemas no longer advertise unsupported keywords.

205 tests / 1,352 assertions across 24 files.

## 0.3.0

Nexus-runtime design adoption, implemented and tested in TypeScript:

- **Effects v2** — in-memory ledger index (10k calls in 733 ms, 0.073 ms/call), explicit `effect_reconcile` plan (`replay` / `compensate` / `query`), `effect_resolve`, pure effect state machine, per-tool recovery policies/compensation.
- **Real kill-9 experiment** — separate Bun processes, taskkill/SIGKILL, restart reconciliation, post-crash irreversible retry denial (`duplicateDenied: true`, `duplicateExecutions: 0`); committed control still allows a repeat.
- **Audit v2** — optional HMAC-SHA256 record signatures, `audit_export` with head/verify/records, golden fixture pinning canonical data and record hashes.
- **Replay plan** — `replay_plan` machine-readable actions: re-read changed files, rerun failed commands, verify commands, inspect unfinished turns.
- **File locks** — cross-process advisory locks for `apply_patch`, stale-owner takeover, TTL, deterministic path ordering.
- **Budget v2** — `BudgetLedger` reserve/settle/release and optional `reservePerRequest` enforcement with request-error/turn-end cleanup.
- **Nexus design library** — HMAC capability tokens with realpath path scopes, causal vector clock, JSON-RPC NDJSON worker protocol/state machine.
- **Schema guard** — a test that rejects tool schemas outside dsh's supported JSON-Schema subset (caught a real `maxItems` registration failure).
- **Docs** — `docs/invariants.md` maps the eight Phoenix invariants to fake-context, real kill-9, and remaining gaps.

160 tests / 918 assertions across 20 files.

## 0.2.0

Added a reliability suite on top of the 0.1 core:

- **`apply_patch`** — multi-file transactional edits with full preflight and reverse rollback.
- **Effects ledger** — intent/commit records, restart `unknown` reconciliation, `effect_status`, optional duplicate-irreversible denial.
- **Artifacts** — SHA-256 content-addressed store with atomic writes, index, get/verify/list, tamper detection.
- **Session notes** — path-safe scratchpad with atomic compaction and malformed-line isolation.
- **Repo map** — `repo_map`, `find_symbol`, `impact_of` for TS/JS, Python, Rust, Go, Java; per-file symbol ids, mtime invalidation, ignored build dirs.
- **Knowledge base** — version chains, trust states, TTL, archived tombstones, trusted-only optional injection.
- **Handoff** — deterministic session report with injected-context filtering and `apply_patch.edits` extraction.
- **History compaction** — budgeted deterministic summary with original/compact character ratio.
- **Reflection** — deterministic repeated-call/error/unverified-edit review.
- **Memory upgrades** — TTL, Markdown export, MEMORY.md import.
- **Audit evidence** — `audit_evidence` lookup by event data hash.
- **Budget** — opt-in usage accounting and request enforcement.

76 new deterministic tests (82 total, 427 assertions), real-dsh smoke for the new tools, and a 0.2 section in `docs/experiments.md`.

## 0.1.0

- `fuzzy_edit` with anchor/token/uniqueness guards (90% vs 33.8% on 80 drift cases; 0 wrong edits).
- Project memory with cross-session recall (2/2 vs 0/2).
- Hash-chained audit ledger (4/4 tamper scenarios detected vs 0/4 for plain JSONL).
- Opt-in verification gate (4/4 vs 4/4; no gain with `deepseek-flash`, kept opt-in).
- Full 88-item analysis of `awesome-agent-infra` and `nexus-runtime`.
