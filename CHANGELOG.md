# Changelog

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
