# Status: coverage, experiments, and remaining gaps

Last updated with 0.4.0.

## Is every source component experimented?

**No.** All **88** source components were read and classified in [`docs/analysis/`](analysis/README.md), but a runtime experiment only exists for the items that could change a shipping decision or needed behavioral proof. Many C/D items are mocks, duplicates of stronger dsh features, or unsafe; they were rejected from source evidence, not benchmarked.

Current inventory:

- **43 model-facing tools** registered by the plugin.
- **205 tests / 1,352 assertions** across 24 test files.
- **17 experiment scripts** and **19 result JSON files** under `experiments/`.
- **4 quantitative agent/retrieval experiments**: patch drift, cross-session memory, audit tamper, verification gate.
- **Deterministic/prototype experiments**: effects perf + real kill-9, memory v2 consolidation, repair memory, agentic search, best-of-N, Valid8, skill curation, POMDP, reasoning-search, process-reward, agent-metacog, hallucination-detector, code-sandbox.

## Shipped tools (43)

| Group | Tools |
|---|---|
| Editing | `fuzzy_edit`, `apply_patch` |
| Memory | `memory_save`, `memory_search`, `memory_forget`, `memory_feedback`, `memory_invalidate`, `memory_consolidate`, `memory_export`, `memory_import` |
| Notes | `note_append`, `note_read`, `note_compact` |
| Code intelligence | `repo_map`, `find_symbol`, `impact_of`, `search_code` |
| Knowledge | `knowledge_add`, `knowledge_search`, `knowledge_history`, `knowledge_verify`, `knowledge_forget` |
| Context | `handoff`, `replay_plan`, `history_compact`, `reflect` |
| Repair | `repair_record`, `repair_search`, `repair_list` |
| Safety/effects | `effect_status`, `effect_reconcile`, `effect_resolve`, `audit_verify`, `audit_evidence`, `audit_export`, `verify`, `budget_status` |
| Artifacts | `artifact_put`, `artifact_get`, `artifact_verify`, `artifact_list` |
| Retention | `archive_ledgers`, `restore_archive` |

Plus tested libraries: capability tokens, causal clock, worker protocol, file locks, budget ledger.

## What was added after experiments

- `search_code` — agentic-search experiment passed (hit@5 80%→100%, MRR 0.70→0.90).
- Memory v2, error-repair memory, retention — recommended, implemented, tested, and benchmarked.
- The original fuzzy edit, memory, audit, effects, artifacts, apply_patch, notes, repo map, knowledge, handoff/replay, compact/reflection, budget were already implemented; most have deterministic tests, some have quantitative experiments.

## What was rejected after experiments

Best-of-N planning, Valid8 gate, POMDP, reasoning-search, process-reward, agent-metacog, hallucination-detector, code-sandbox. See `docs/experiments.md` E8/E9 and `docs/decisions.md`.

## Add-worthy candidates not yet fully resolved

These are **not** rejected; they were either not implemented or only partially covered. They are the honest gaps:

| Candidate | Status | What remains |
|---|---|---|
| Semantic/embedding memory retrieval | Not implemented. Memory v2 is lexical. | Add an embedding provider interface/experiment; compare recall@k and token cost vs lexical. |
| Canonical `MEMORY.md` project memory | Partial: JSONL memory has `memory_export`/`memory_import`, but MEMORY.md is not the source of truth. | Decide whether MEMORY.md should be canonical; add round-trip/locking tests. |
| `checkpoint-writer` 11-field structured handoff | Not implemented. `handoff` + `replay_plan` cover the deterministic path. | Add a structured checkpoint schema only if a real handoff consumer needs it. |
| `evidence-log` content-addressed event log | Partial: audit hash chain + `audit_evidence` + `audit_export`, not the package's evidence-log. | Compare against external WORM/ledger needs; decide whether a separate evidence index is worth it. |
| Python worker / external worker runtime | Protocol library only; no worker process. | Only if remote workers are needed; add capability/deadline/cancel and sandboxing. |
| Full session replay / checkpoint identity / determinism context | Not implemented. | Define a replay corpus and materialized-state comparison; currently only effects/audit replay. |
| Artifact crash, audit-anchor crash, budget crash | Not tested under real kill-9. | Add kill-9 experiments for each; `docs/invariants.md` lists them as gaps. |
| Skill curation / dreamdistill | Deferred after synthetic-only experiment. | Need real skill corpus + 30–50 agent tasks. |
| Guardrail / goal-verifier / confidence-gate | Source-level concern, no dedicated experiment. | Optional experiments if someone wants to use them; do not add by default. |
| D/C components (event bus, worker, state machine, branch, engine-db, replay, tracing, MCP client, dynamic-workflow, Nexus runtime/SDK/schedulers, etc.) | Not runtime-tested. | Not planned; source review shows mock/duplicate/unsafe behavior. |

## Are all "can add" features added?

- **Among the candidates that were actually tested:** yes. `search_code` was added; Best-of-N, Valid8, POMDP, reasoning-search, process-reward, agent-metacog, hallucination-detector, and code-sandbox were rejected; skill curation is deferred.
- **Among all potentially add-worthy items:** no. Semantic retrieval, canonical MEMORY.md, structured checkpoint handoff, content-addressed evidence log, external worker runtime, full replay, and the three crash tests remain unresolved.
- **Evidence quality:** only four features have agent-level quantitative experiments. The rest are deterministic tests, synthetic benchmarks, or real-dsh smoke. That is sufficient for guarantees (e.g., tamper detection, rollback), not for claiming task-success improvement. `search_code`/memory v2/repairs still need agent-level A/B before being called "proven stronger".

## Recommended next closures

1. Agent-level A/B for memory v2 + repairs (the two most likely to improve task outcomes).
2. Embedding/semantic retrieval experiment, only if lexical recall is the limiting factor.
3. Kill-9 artifact/audit/budget tests to close `docs/invariants.md` gaps.
4. Decide MEMORY.md canonical vs export-only.
5. Only then revisit worker runtime / structured checkpoint / evidence log.
