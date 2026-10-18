# Status: coverage, experiments, and remaining gaps

Last updated with 0.2.0.

## What is covered

Runtime experiments exist for capabilities whose behavior or default could change a shipping decision. Deterministic tests cover the rest of the shipped surface.

Current inventory:

- **41 model-facing tools** at the `full` profile; the default `core` profile registers **21** (coding: 37). Repair memory's three tools are opt-in and outside every profile.
- **233 tests / 1,460 assertions** across 27 test files; **96.80% line / 94.34% function coverage**. The previous weak spots improved: `vendor/fuzzy-patch.ts` 95.2% lines, `verify.ts` 94.3%, `repo-map.ts` 86.2%.
- **19 experiment scripts** and **22 result JSON files** under `experiments/`.
- **8 quantitative agent/retrieval experiments**: patch drift, cross-session memory, memory core-tier, audit tamper, verification gate, profile A/B, repair memory A/B, search_code A/B.
- **Deterministic/prototype experiments**: effects performance + real kill-9, artifact crash, audit anchor gap, budget durability, memory v2 consolidation, repair memory, agentic search, repo-map performance, tool-schema overhead, cross-process store writes, package install smoke, best-of-N planning, skill curation.

## Shipped tools (41 at full)

| Group | Tools |
|---|---|
| Editing | `fuzzy_edit`, `apply_patch` |
| Memory | `memory_save`, `memory_search`, `memory_forget`, `memory_feedback`, `memory_invalidate`, `memory_consolidate`, `memory_export`, `memory_import` |
| Notes | `note_append`, `note_read`, `note_compact` |
| Code intelligence | `repo_map`, `find_symbol`, `impact_of`, `search_code` |
| Knowledge | `knowledge_add`, `knowledge_search`, `knowledge_history`, `knowledge_verify`, `knowledge_forget` |
| Context | `handoff`, `replay_plan`, `history_compact`, `reflect` |
| Repair (opt-in) | `repair_record`, `repair_search`, `repair_list` |
| Safety/effects | `effect_status`, `effect_reconcile`, `effect_resolve`, `audit_verify`, `audit_evidence`, `audit_export`, `verify`, `budget_status` |
| Artifacts | `artifact_put`, `artifact_get`, `artifact_verify`, `artifact_list`, `artifact_reindex` |
| Retention | `archive_ledgers`, `restore_archive` |

Plus tested libraries: capability tokens, causal clock, worker protocol, file locks, budget ledger.

The table lists the union. `core` = editing + memory + effects/audit + artifacts. `coding` adds notes, code intelligence, knowledge, and context tools. `full` adds verify, budget, and retention, which register only when configured. Repair memory is opt-in (`repairs: true`) after E14.

## What was added after experiments

- `search_code` — agentic-search experiment passed (hit@5 80%→100%, MRR 0.70→0.90).
- Memory v2, error-repair memory, retention — implemented and benchmarked; repair memory was later demoted to opt-in by E14.
- `artifact_reindex` — added after the real kill-9 artifact experiment showed blobs survive without an index and the index must be reconstructable.
- `core` / `coding` / `full` profiles — tool-overhead measurement plus the E12 agent A/B; `core` is now the default.
- Repo-map performance work — async reads, TTL cache, precomputed sorted symbols, bounded graph/PageRank; cold 33.3s → 2.4–4.6s.
- Cross-process locks for memory, repair, and knowledge read-modify-write cycles, with two-process tests.
- Shell-failure detection for repair hints, with deterministic injection/exit-zero/non-shell tests.
- Durable per-session budget usage under `$DSH_HOME/super-dsh/budget`; kill-9 restores 900 used tokens, while reservations remain in-memory.
- Memory core-tier A/B: core **9/10** vs long **0/10**, with the fact injected 10/10 vs 0/10 (E17).
- search_code A/B: **8/8 in both arms**, but treatment used **15,840 vs 8,679 input tokens**; repo map remains opt-in (E18).
- Package `npm pack` → `dsh plugin add` smoke in CI.
- Typecheck, coverage script, CI (Ubuntu + Windows), lockfile, and a schema-subset guard for registered tools.

## What was not added

Best-of-N planning was measured and rejected; skill curation is deferred pending real-world evidence. Repair memory is not rejected: E14 found no benefit on a 16-task ceiling corpus, so it moved from default core to opt-in. See `docs/experiments.md` and `docs/decisions.md`.

## Performance and default profile

| Profile | Tools | Approx schema tokens/request | Status |
|---|---:|---:|---|
| core | 21 | 2,953 | **Default** |
| coding | 37 | 4,984 | Opt-in |
| full | 41 | 5,610 | Opt-in; verify/budget/retention need config |

- Profile A/B: core 5/5 and coding 5/5; input tokens 18,490 vs 25,357; output 3,740 vs 5,605. Coding did not win a task, so core is the default (E12; run before repairs was demoted, both arms included repairs).
- Cross-session memory replication: 10 pairs, baseline **0/10**, treatment **10/10**; session-2 output tokens **222–678** vs **44–107** (E2).
- Repair A/B: 16/16 passes in both arms; hints reached 16/16 treatment sessions but cost +9.1% input and +15.4% output tokens. Repairs moved to opt-in (E14).
- `repo_map` over 2,000 files: cold **2.4–4.6s** (was 33.3s), TTL warm p50 **0.1ms**, forced unchanged rescan p50 **230–363ms** (E11).
- Effects recording: **0.073ms/call**. Audit: ~1.76ms/event.
- Artifact crash: a blob written before the process was killed is readable/verifiable by hash, and `artifact_reindex` restores the index.
- Cross-process stores: 50/50 memory rows, 50 repair increments, and 50 contiguous knowledge versions across two writers (E15).
- Package install smoke: tarball installs via `dsh plugin add` and appears in `--dump-config` (E16).

## Crash and invariant coverage

`docs/invariants.md` has the full mapping. Current state:

| Area | Evidence | Status |
|---|---|---|
| Effects intent crash | `experiments/kill9-effects.ts` (real kill-9) | covered: `pending → unknown`, duplicate irreversible denied |
| Artifact blob/index crash | `experiments/kill9-artifacts.ts` (real kill-9) | covered: read/verify by hash + reindex |
| Audit anchor gap | `experiments/kill9-audit-anchor.ts` (simulated crash window) | detected, no repair |
| Budget restart | `experiments/kill9-budget.ts` | covered: used tokens 900 → 900; reservations cleared on restart |
| Checkpoint identity, determinism context, worker crash | none | gaps |

## Scope closure

Three items are intentionally outside the plugin layer:

- **Semantic/embedding retrieval** is not implemented. The lexical path is
  deterministic and dependency-free; add a provider adapter only after a real
  query corpus shows a lexical recall gap.
- **Checkpoint identity, determinism context, and full event replay** are dsh
  host responsibilities. The plugin provides effects recovery, audit, and
  recovery plans, but does not claim resumable step identity or byte-identical
  replay.
- **Remote worker runtime** is protocol-only; no process, scheduler, or remote
  transport is bundled.

## Add-worthy candidates not yet fully resolved

These are **not** rejected; they were either not implemented or only partially covered. They are the honest gaps:

| Candidate | Status | What remains |
|---|---|---|
| Large-repo search_code A/B | Small source-tree A/B is null (8/8 both, +82.5% input tokens). | Test an unfamiliar 1,000–2,000-file repository before making a positive coding-profile claim. |
| Memory consolidation / long-horizon quality | Tier priority is tested; consolidation is synthetic-only. | Run a multi-session consolidation/recall experiment if consolidation becomes automatic. |
| Semantic/embedding memory retrieval | Not implemented. Memory v2 is lexical. | Add an embedding provider interface/experiment; compare recall@k and token cost vs lexical. |
| Canonical `MEMORY.md` project memory | Partial: JSONL memory has export/import, but MEMORY.md is not the source of truth. | Decide whether MEMORY.md should be canonical; add round-trip/locking tests. |
| Structured checkpoint handoff | Not implemented. `handoff` + `replay_plan` cover the deterministic path. | Add a structured checkpoint schema only if a real handoff consumer needs it. |
| Content-addressed evidence log | Partial: audit hash chain + `audit_evidence` + `audit_export`. | Compare against external WORM/ledger needs; decide whether a separate evidence index is worth it. |
| Python worker / external worker runtime | Protocol library only; no worker process. | Only if remote workers are needed; add capability/deadline/cancel and sandboxing. |
| Full session replay / checkpoint identity / determinism context | Host scope; not planned. | dsh owns session persistence and resume; the plugin provides effects/audit recovery instead. |
| Skill curation | Deferred after synthetic-only experiment. | Need real skill corpus + 30–50 agent tasks. |
| Out-of-scope runtime features (event bus, remote workers, schedulers, full replay) | Not implemented. | Revisit only with a real consumer; not part of the reliability layer. |

## Are all "can add" features added?

- **Among the candidates that were actually tested:** yes. `search_code`, `artifact_reindex`, and profiles were added; repair memory was measured and moved to opt-in; Best-of-N was rejected; skill curation is deferred.
- **Among all potentially add-worthy items:** no. Large-repo search_code evidence, memory consolidation/long-horizon evidence, semantic retrieval, canonical MEMORY.md, structured checkpoint handoff, content-addressed evidence log, external worker runtime, and full replay remain unresolved.
- **Evidence quality:** eight features have agent-level quantitative experiments (fuzzy patch, cross-session memory, memory tier, audit, verification gate, profile choice, repair memory, search_code). The rest are deterministic tests, synthetic benchmarks, or real-dsh smoke. That is sufficient for guarantees (e.g., tamper detection, rollback, crash detection), not for claiming task-success improvement. `search_code`'s small-tree A/B is null and a large-repo test remains; memory tier priority is tested but consolidation is not. Repair memory's A/B supports *not* defaulting it, but its ceiling corpus does not prove it can never help.

## Recommended next closures

1. Large-repo search_code A/B and a long-horizon memory consolidation experiment.
2. Decide MEMORY.md canonical vs export-only.
3. Embedding/semantic retrieval experiment, only if lexical recall is the limiting factor.
4. Revisit structured checkpoint / evidence log / worker runtime only when a real consumer exists.
5. Re-test repair hints on hard, cross-session failures before considering any promotion back to default.
