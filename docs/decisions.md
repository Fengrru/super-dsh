# Decision log

This file records the decisions that affect the shipped default bundle. Every
candidate was judged by three questions:

1. Does it fill a real execution gap in dsh's public seams?
2. Is the implementation trustworthy (not a mock, not contradicted by its own tests)?
3. Can its benefit be measured here, with a baseline and a guardrail?

A "no" to any of these means it stays out of the default bundle.

## Accepted

| Candidate | Evidence | Status |
|---|---|---|
| Safety-guarded fuzzy editing | 33.8% → 90.0% correct on 80 drift cases; 0 wrong edits; 100% control refusals (`experiments/results/patch-bench.json`) | Default on |
| Memory v2 (tiers, feedback, causal invalidation, deterministic consolidation, TTL, MEMORY.md) | Cross-session recall passes (10 pairs: baseline 0/10, treatment 10/10); consolidation 60 facts: recall@3 1.0 unchanged, stale 0, injected chars -1,210 (`experiments/results/memory-v2-bench.json`); tier/feedback/invalidate tests | Default on; lexical retrieval |
| Log retention | gzip + SHA-256 manifest, verified delete/restore, path traversal/symlink/overwrite refusal (`tests/retention.test.ts`) | Opt-in; destructive only when requested |
| Hash-chained audit ledger + evidence/export/signatures | Detects edit/delete/truncate/reorder; plain JSONL detects none (`experiments/results/audit-bench.json`); HMAC signatures, golden fixture, export tests | Default on; signing opt-in |
| Effects intent/commit + recovery plan | Pending→committed/failed, restart→unknown, duplicate irreversible denial, `effect_reconcile`/`effect_resolve` (`tests/effects.test.ts`); real kill-9: duplicateDenied=true, duplicateExecutions=0 (`experiments/results/kill9-effects.json`); 10k calls 0.073 ms/call | Default on; deny is opt-in |
| Content-addressed artifacts | Text/binary round-trip, tamper→verify false, restart read, invalid hash; kill-9 blob-without-index recovery and `artifact_reindex` (`tests/artifacts.test.ts`, `experiments/kill9-artifacts.ts`) | Default on; index is rebuildable |
| Multi-file `apply_patch` + advisory file locks | Preflight failure writes nothing; mid-write failure restores originals; duplicate path/maxFiles rejected; lock contention fails before any write (`tests/apply-patch.test.ts`, `tests/file-locks.test.ts`) | Default on; rollback/locks best-effort |
| Session notes | Path-safe session ids, malformed-line isolation, atomic compact, entry cap (`tests/notes.test.ts`) | `coding`/`full`; enable `notes: true` in core |
| Repo map | Same-named symbols in different files both survive; mtime rebuild; ignored build dirs (`tests/repo-map.test.ts`); 2,000 files cold 2.4–4.6 s, TTL warm 0.1 ms (`experiments/repo-map-perf.ts`) | `coding`/`full`; enable `repoMap: true` in core; regex heuristic |
| Versioned knowledge | Version chain/parentId, revert creates a new version, trust/expiry filtering, archived tombstones (`tests/knowledge.test.ts`) | `coding`/`full`; enable `knowledge: true` in core |
| Deterministic handoff + replay plan | Mixed events, injected-context filtering, apply_patch file extraction, missing-service errors (`tests/handoff.test.ts`); machine-readable actions (`tests/replay-plan.test.ts`); real-dsh smoke | `coding`/`full`; enable `handoff` / `replayPlan` in core |
| Budget reserve/settle | `BudgetLedger` reserve/settle/release, duplicate keys, cap refusal (`tests/budget-ledger.test.ts`); optional `reservePerRequest` (`tests/budget.test.ts`) | Enforcement opt-in |
| Capability token / causal clock / worker protocol | HMAC token + realpath scope, vector clock, NDJSON codec/FSM (`tests/capability.test.ts`, `tests/causal-clock.test.ts`, `tests/worker-protocol.test.ts`) | Tested libraries; not model tools |
| `core` / `coding` / `full` profiles | Tool overhead measured (21/37/41 tools, 2,953/4,984/5,610 schema tokens after repairs became opt-in); 5-task A/B at 24/40 tools: core 5/5 vs coding 5/5, input 18,490 vs 25,357, output 3,740 vs 5,605 (`experiments/results/profile-ab-bench.json`) | `core` is the default; coding/full opt-in |

## Conditional

| Candidate | Evidence | Status |
|---|---|---|
| Repair memory | Synthetic retrieval: known errors 10/10, unknown false hits 0/10 (`experiments/results/repair-bench.json`); 16-task agent A/B: both arms 16/16, hints reached 16/16 treatment sessions, +9.1% input and +15.4% output tokens (`experiments/results/repairs-ab-bench.json`); shell non-zero exits now trigger hints | **Not default.** Enable with `repairs: true`. The A/B is a ceiling corpus; it justifies opt-in, not deletion. |
| Verification gate | Both arms passed 4/4 seeded tasks; the model already ran tests unprompted. Treatment added ~1 step on two tasks and ~24% more output tokens, with no success gain (`experiments/results/agent-bench-verify.json`) | **Not default.** Available opt-in as a definition-of-done guarantee for models/workflows that do not self-verify. |
| Budget accounting/enforcement | Usage accumulation, total precedence, seq dedupe, enforce reject/allow (`tests/budget.test.ts`); no agent A/B yet | **Not default.** Enable with `budget`. |
| `denyUnresolvedIrreversible` | Duplicate irreversible call denied after a real kill-9 restart (`duplicateDenied: true`, `duplicateExecutions: 0`); pure tools unaffected (`experiments/results/kill9-effects.json`, `tests/effects.test.ts`) | **Not default.** Accounting is on; denial is opt-in. |

## Evaluated and not added

| Candidate | Evidence | Decision |
|---|---|---|
| Best-of-N planning | baseline 0.986, judge 0.995, oracle 1.000, judge top-1 75%, 2.64× tokens (`experiments/results/best-of-n-plan-bench.json`) | **Do not add.** Ceiling effect; oracle gain below +0.10. |
| Skill curation | Synthetic hit@3 83.3% → 100%, stale slots 25% → 0%, but only synthetic data (`experiments/results/skill-curation-bench.json`) | **Defer** until a real skill corpus/agent-task experiment. |

## Scope decisions

- **No durable execution runtime.** dsh owns session persistence and resume;
  SuperDSH provides recovery plans and ledgers around that.
- **No sandbox or authorization layer.** dsh approval/sandbox is the boundary;
  capability tokens are a library, not a replacement.
- **No embedding memory until a lexical gap is measured.** Current retrieval is
  deterministic and dependency-free.
- **No multi-region fuzzy replacement.** Proving every fuzzy region safe is
  materially harder; a wrong bulk edit is unrecoverable.
- **No LLM request cache or remote worker runtime.** Revisit only when a real
  workload or consumer exists.
- **Checkpoint identity, determinism context, and full event replay remain
  gaps**; they are tracked in `docs/status.md`, not claimed as implemented.
