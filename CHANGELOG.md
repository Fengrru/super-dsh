# Changelog

## 0.1.0 — 2026-10-18

First open-source release. SuperDSH is a safety-first reliability suite for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), shipped as
one zero-runtime-dependency ESM plugin bundle. Pre-release development notes
(0.2.0–0.6.0) are archived in [`docs/dev-changelog.md`](docs/dev-changelog.md).

### Editing and transactions

- **`fuzzy_edit`** — eight tolerant matching strategies with unique-byte,
  anchor, token-similarity, coverage, and size guards. On the 80-case drift
  corpus it raised correct edits from **33.8% to 90.0%** with **0** wrong-region
  edits and **100%** control refusals.
- **`apply_patch`** — multi-file preflight, reverse rollback, duplicate-path and
  size limits, and cross-process advisory file locks.

### Recovery, integrity, and audit

- **Effects ledger** — intent/commit records, restart `pending → unknown`
  reconciliation, `effect_reconcile` / `effect_resolve` plans, and opt-in
  duplicate-irreversible denial. A real kill-9 test reports
  `duplicateDenied=true`, `duplicateExecutions=0`; 10,000 effects calls run at
  **0.073 ms/call**.
- **Content-addressed artifacts** — SHA-256 verification on every read, atomic
  writes, tamper refusal, real kill-9 blob recovery, and `artifact_reindex` to
  rebuild a lost index from blobs.
- **Tamper-evident audit** — hash chain, head anchor, sequence checks, optional
  HMAC-SHA256 signatures, evidence lookup, export, and a byte-pinned fixture.
- **Cross-process store safety** — memory, repair, and knowledge read-modify-write
  cycles hold per-file advisory locks and reload after acquisition. Two-process
  tests preserve 50/50 memory rows, 50 repair increments, and 50 contiguous
  knowledge versions.

### Context and knowledge

- **Project memory v2** — core/long/working tiers, confidence and feedback,
  causal invalidation, deterministic consolidation, TTL, and MEMORY.md-style
  import/export.
- **Repo map** — `repo_map`, `find_symbol`, `impact_of`, and `search_code` for
  TS/JS, Python, Rust, Go, and Java. A 2,000-file build takes **2.4–4.5 s**
  (down from 33.3 s), with TTL-warm queries at **0.1 ms**.
- **Versioned knowledge**, **session notes**, **deterministic handoff**,
  **machine-readable replay plans**, **budgeted history compaction**, and
  **reflection**.
- **Opt-in repair memory** — normalized error signatures and automatic hints
  for matching tool failures and non-zero shell exits. A 16-task agent A/B found
  no success gain and **+9.1% input / +15.4% output tokens**, so it is not in a
  default profile; enable it with `repairs: true`.

### Profiles and packaging

- **`core`** (default, 21 tools / ~2,953 schema tokens), **`coding`** (37 /
  ~4,984), and **`full`** (41 / ~5,610). Explicit feature flags override the
  profile; `presets/` contains ready-made overlays.
- Default profile chosen by a 5-task agent A/B: core **5/5**, coding **5/5**,
  but coding used **25,357 vs 18,490 input tokens**.
- `npm pack` → `dsh plugin add` → isolated `--dump-config` smoke test, plus a
  CI matrix on Ubuntu and Windows, typecheck, coverage, and a schema-subset
  guard for registered tools.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates,
  and a tag-triggered release workflow.

### Evidence

The repository contains 16 experiment write-ups (E1–E16), 24 scripts, and 26
raw JSON result files. Negative results are kept: Best-of-N planning, Valid8,
POMDP, reasoning-search, process-reward, agent-metacog,
hallucination-detector, and code-sandbox were not added; repair memory was
demoted to opt-in. See [`docs/experiments.md`](docs/experiments.md) and
[`docs/status.md`](docs/status.md).

### Validation

- 221 tests / 1,404 assertions across 26 files.
- 95.41% line / 93.01% function coverage.
- `bun run typecheck`, `bun run build`, and `bun run smoke:install` pass.
- Manual install and `artifact_put` / `artifact_verify` smoke on published
  dsh `0.2.1-rc.2`.
