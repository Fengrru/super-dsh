# Changelog

## 0.4.0

Memory and recovery upgrades from awesome-agent-infra, implemented without its data bugs:

- **Memory v2** — tiers (`core`/`long`/`working`), session-scoped working memory, confidence/feedback, `memory_invalidate` causal cascade through `derivedFrom`, `supersedes`, deterministic `memory_consolidate` (dedupe, expire, promote, per-tier caps), tiered core+relevant injection, JSONL/Markdown compatibility.
- **Error-repair memory** — cross-session `repair_record`/`repair_search`/`repair_list`, normalized error signatures, `tools/post-execute` auto-hint injection on matching errors.
- **Log retention** — opt-in `archive_ledgers` with gzip + SHA-256 + manifest + verified deletes, and `restore_archive` with path-traversal/symlink/overwrite guards.
- **Benchmarks** — memory consolidation: 60 facts, recall@3 1.0 before/after, stale injections 0, injection chars 13775→12565; repair memory: known-error hit 10/10, correct hint 10/10, unknown-error false hits 0/10.
- **Schema guard** extended to the new tools; repair parameter schemas no longer advertise unsupported keywords.

197 tests / 1,184 assertions across 23 files.

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
