# Decision log

> Full item-by-item coverage (48 awesome-agent-infra packages + 40 nexus-runtime components) is in [`analysis/README.md`](analysis/README.md). This file records the decisions that affect the shipped default bundle.

Every candidate enhancement was evaluated against three questions:

1. Does it fill a real gap in dsh's public seams?
2. Is the implementation trustworthy (not a mock, not contradicted by its own tests)?
3. Can its benefit be measured here, with a baseline and a guardrail?

A "no" to any of these means it stays out of the default bundle. This file records the reasoning, including the evidence that killed some attractive ideas.

## Accepted

| Candidate | Evidence | Status |
|---|---|---|
| Safety-guarded fuzzy editing (`fuzzy-patch` from awesome-agent-infra) | 33.8% → 90.0% correct on 80 drift cases; 0 wrong edits; 100% control refusals (`experiments/results/patch-bench.json`) | Default on |
| Project memory (file-backed, lexical retrieval, auto-injection, TTL, MEMORY.md import/export) | Cross-session recall passes with the workspace wiped; baseline fails (`experiments/results/agent-bench.json`); TTL/import tests | Default on |
| Hash-chained audit ledger + evidence/export/signatures (Nexus-inspired) | Detects edit/delete/truncate/reorder; plain JSONL detects none (`experiments/results/audit-bench.json`); HMAC signatures, golden fixture, export tests | Default on; signing opt-in |
| Effects intent/commit + recovery plan (Nexus effects/recovery, TS rewrite) | Pending→committed/failed, restart→unknown, duplicate irreversible denial, `effect_reconcile`/`effect_resolve` (`tests/effects.test.ts`); real kill-9: duplicateDenied=true, duplicateExecutions=0 (`experiments/results/kill9-effects.json`); 10k calls 0.073 ms/call | Default on; deny is opt-in |
| Content-addressed artifacts (Nexus vault, TS rewrite) | Text/binary round-trip, tamper→verify false, restart read, invalid hash (`tests/artifacts.test.ts`) | Default on |
| Multi-file `apply_patch` + advisory file locks | Preflight failure writes nothing; mid-write failure restores originals; duplicate path/maxFiles rejected; lock contention fails before any write (`tests/apply-patch.test.ts`, `tests/file-locks.test.ts`) | Default on; rollback/locks best-effort |
| Session notes | Path-safe session ids, malformed-line isolation, atomic compact, entry cap (`tests/notes.test.ts`) | Default on |
| Repo map | Same-named symbols in different files both survive; mtime rebuild; ignored build dirs (`tests/repo-map.test.ts`) | Default on; regex heuristic |
| Versioned knowledge | Version chain/parentId, revert creates a new version, trust/expiry filtering, archived tombstones (`tests/knowledge.test.ts`) | Default on; injection opt-in |
| Deterministic handoff + replay plan | Mixed events, injected-context filtering, apply_patch file extraction, missing-service errors (`tests/handoff.test.ts`); machine-readable actions (`tests/replay-plan.test.ts`); real-dsh smoke | Default on |
| Budget reserve/settle | `BudgetLedger` reserve/settle/release, duplicate keys, cap refusal (`tests/budget-ledger.test.ts`); optional `reservePerRequest` (`tests/budget.test.ts`) | Enforcement opt-in |
| Capability token / causal clock / worker protocol | HMAC token + realpath scope, vector clock, NDJSON codec/FSM (`tests/capability.test.ts`, `tests/causal-clock.test.ts`, `tests/worker-protocol.test.ts`) | Tested libraries; not model tools |

## Conditional

| Candidate | Evidence | Status |
|---|---|---|
| Verification gate | Both arms passed 4/4 seeded tasks; the model already ran tests unprompted. Treatment added ~1 step on two tasks and ~24% more output tokens, with no success gain (`experiments/results/agent-bench-verify.json`) | **Not default.** Available opt-in as a definition-of-done guarantee for models/workflows that do not self-verify. |
| Budget accounting/enforcement | Usage accumulation, total precedence, seq dedupe, enforce reject/allow (`tests/budget.test.ts`); no agent A/B yet | **Not default.** Enable with `budget`. |
| `denyUnresolvedIrreversible` | Duplicate irreversible call denied after a real kill-9 restart (`duplicateDenied: true`, `duplicateExecutions: 0`); pure tools unaffected (`experiments/results/kill9-effects.json`, `tests/effects.test.ts`) | **Not default.** Accounting is on; denial is opt-in. |

## Rejected or deferred

### Nexus Runtime as a runtime dependency

**Idea:** bridge dsh to the Rust kernel for durable execution, causal event logs, and crash recovery.

**Why rejected now:**

- No Rust toolchain on the test machine, and Nexus publishes no binary, npm package, PyPI package, or crates.io release. Building requires 500+ crates.
- Its Node SDK is an **in-memory mock**: it does not write SQLite, start workers, call an LLM, or call the kernel. `resumeSession()` loses the original state.
- The Rust CLI has no machine-readable output or server; `resume` prints a report but does not continue execution; `import` and `budget-set` are no-ops.
- dsh already has stronger, shipped persistence: append-only JSONL with continuous sequence numbers, single-writer flush barriers, torn-tail recovery, interrupted-turn repair, and checkpoint policies.
- The integration paths (Nexus as dsh persistence backend, or dsh as a Nexus worker) require translating two incompatible event models, double-writing, and maintaining both. The user value is mostly duplicated.

**Decision:** do not run Nexus. Adopt its **invariants** instead: event log as truth, hash-chained audit, external verification over self-report, bounded side-effect semantics, and content-addressed artifacts. The audit ledger, verification gate, effects ledger, and artifact store are the concrete TS implementations.

### Code-graph repo map (`codegraph`)

**Update in 0.2:** shipped a **lightweight regex repo-map rewrite** (`repo_map`, `find_symbol`, `impact_of`) instead of vendoring `codegraph`. The rewrite keeps per-file symbol ids, mtime/size invalidation, and ignored build directories; the original package's defects below remain the reason it was not copied.

**Idea:** register a `repo_map` / symbol-graph tool based on awesome-agent-infra's `codegraph`.

**Why deferred:**

- The symbol id is `symbol:<type>:<name>` without the file path, so same-named functions in different files collide and overwrite each other — a serious accuracy bug on real repositories.
- `build()` returns a cached persisted graph without checking file mtimes, so it can serve stale code.
- The "watcher" has no `fs.watch`; it only applies manually supplied changes.
- Without tree-sitter, it falls back to regex extraction; the tree-sitter dependencies are not declared as regular dependencies.
- There is no evidence yet that it beats dsh's existing `grep`/`glob` + LSP navigation on measurable tasks.

**Decision:** defer until symbol ids and cache invalidation are fixed and a file/symbol hit-rate benchmark shows a gain over grep/LSP. Do not ship a known-corrupt graph.

### awesome `txn-fs` (multi-file transactions)

**Update in 0.2:** shipped `apply_patch` as a **rewrite**, not the upstream transaction manager. It preflights every edit, writes only after all replacements are computed, and restores originals in reverse order on a write failure.

**Why not vendor `txn-fs`:** its `RealGitTransactionManager.rollback()` writes the staged/proposed content instead of the baseline, so a merge-conflict rollback can corrupt files; empty files cannot be written, deletion is unsupported, and writes are not atomic. The shipped implementation keeps the useful contract (all-or-nothing preflight, rollback, conflict refusal) without the data-loss bug.

### `goal-verifier`

**Idea:** use it to decide whether the agent completed the user's goal.

**Why rejected:**

- The no-LLM fallback only checks `completed/total` DAG counts; it does not inspect files, tests, or tool evidence.
- When `retryCount >= maxRetries`, it returns `satisfied: true` — a false-completion machine.
- LLM `temperature`, `maxTokens`, and `model` config are not forwarded to the provider.

**Decision:** reject. A verifier that cannot verify is worse than none. The verification gate runs the project's actual tests instead.

### `confidence-gate` and `hallucination-detector`

**Idea:** calibrate confidence and flag hallucinations.

**Why rejected as a hallucination solution:**

- `confidence-gate` is real calibration math (ECE/Brier/temperature), but it needs labeled correctness data; it does not determine factual truth. Its `fit()` also clamps reported metrics, which corrupts reporting.
- `hallucination-detector` compares claims within one text via TF-IDF/Jaccard; that is internal consistency, not factuality. Its "spectral" path is dead code, and the spectral subclass is never called by `detect()`.

**Decision:** do not claim hallucination reduction. If calibration is needed later, reuse the math with unclamped metrics and real labels.

### `replay`, `dynamic-workflow`, `healix`, `process-reward`, `agent-metacog`

**Why rejected:**

- `replay`: `getStateTrajectory()` and `getDifferences()` return `[]`; the tests assert the empty arrays. Not usable as a recovery base.
- `dynamic-workflow`: `scriptPath` is never assigned, so `resume()` cannot resume; checkpoints store only the last result, not program state; file primitives accept arbitrary absolute paths.
- `healix`: the exact-hash tiers compare against the recovery action rather than the original error; the test that claims an exact-hash match actually hits a condition fallback.
- `process-reward`: no real PRM; registered scorers and score caches are never used; the "trainer" leaks labels and only nudges predictions toward them.
- `agent-metacog`: the calibrator's "training" subtracts random noise scaled by loss; it cannot learn. Its ECE uses token likelihood thresholds as pseudo-labels.

**Decision:** reject. These are prototypes or placeholders, not building blocks for a reliability layer.

### LLM request dedup cache

**Idea:** port Nexus's prompt-hash cache to dsh's `llm/stream` seam.

**Why rejected:**

- dsh already guarantees a signed step is never re-run within a session; its retry layer owns failures.
- Cross-session identical requests are rare for agent prompts (dynamic system prompt, context, tools, and history).
- A persistent cache needs a canonical key over model/provider/messages/tools/temperature and a failure-closed write path; the measured benefit would likely be near zero here.

**Decision:** not implemented. Revisit only with a workload where repeated prompts are common (batch classifiers, evals), and key the cache correctly.

### Fuzzy `replace_all`

**Idea:** expose multi-region tolerant replacement.

**Why rejected:** proving that every fuzzy match is the intended one is substantially harder than a single region. A wrong bulk edit is catastrophic. The tool intentionally exposes single-region edits only; use literal `edit` with `replace_all` when the text is exact.
