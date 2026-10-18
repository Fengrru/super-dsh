# Experiments

SuperDSH follows a pre-registered experiment protocol:

1. State a hypothesis and a **decision rule** before running anything.
2. Define a baseline that reflects what dsh does without the feature.
3. Add guardrails that must not regress (wrong edits, unintended changes, test tampering).
4. Run in isolated workspaces with isolated `DSH_HOME`s.
5. Keep the feature as a default only if the hypothesis is supported **and** the guardrails hold. Otherwise document it and leave it off.

Environment for the reported runs: Windows 10 (10.0.19044), Node 24.18.1, dsh `0.2.1-rc.2` from source, DeepSeek `deepseek-flash`. Raw outputs live in `experiments/results/`.

## E1 — Patch reliability under formatting drift

**Hypothesis.** A tolerant matcher with safety guards recovers edits whose remembered `old_string` differs from the file only in whitespace, indentation, line endings, or token spacing, without increasing wrong-region edits.

**Baseline.** dsh `edit` semantics: exact literal match, must be unique; otherwise refuse.

**Treatment.** Literal first, then the vendored 8-strategy fuzzy matcher, followed by SuperDSH's guards:

- exact matched bytes must be unique in the file;
- the matched region must start and end on the request's first/last non-whitespace anchors;
- token-multiset similarity ≥0.98 (≥0.90 for the typo strategy);
- the region must cover at least half of the request's non-empty lines;
- whitespace-only boundary overreach is trimmed; substantive overreach is refused.

**Corpus.** 12 realistic templates (TypeScript, Python, Rust, Go, CSS, YAML, SQL, Markdown, shell, React, Java) × 6 mutations (exact, space drift, indentation drift, line-ending drift, token spacing, blank-line drift). Plus 8 controls: 4 ambiguous duplicate blocks and 4 no-match requests. 80 cases total.

**Decision rule.** Accept if treatment correct rate ≥ baseline + 20 percentage points, wrong-edit rate ≤2%, and refusal rate on controls = 100%.

**Results**

| Metric | Baseline | Treatment |
|---|---|---|
| Correct cases (80) | 27 (33.8%) | **72 (90.0%)** |
| Applied / applicable (72) | 19 (26.4%) | **64 (88.9%)** |
| Wrong-region edits | 0 | **0** |
| Correct refusals (8 controls) | 8 (100%) | **8 (100%)** |
| Median latency | 0.004 ms | 0.6 ms |
| p95 latency | 0.03 ms | 14.5 ms (noisy; 3–15 ms across runs) |

Per mutation (correct / 12): space drift 5 → 11, indentation 0 → 11, line endings 0 → 11, token spacing 2 → 9, blank-line drift 0 → 10; exact 12 → 12.

Match strategies used: literal 19, whitespace-normalized 29, token-match 10, indentation-normalized 3, line-ending-normalized 3. Eight cases were safely refused, not silently mis-edited.

**Verdict: accepted (default on).** The gain is large and the wrong-edit guardrail holds.

**Limitations.** The corpus isolates formatting drift; it does not estimate how often drift occurs in real sessions. Replace-all is not supported because proving multiple fuzzy regions safe is materially harder. Latency grows with the Levenshtein fallback; p95 stays in single-digit milliseconds on these inputs.

## E2 — Cross-session project memory

**Hypothesis.** A project-scoped, file-backed memory can carry durable facts from one session to a new session after the workspace has been wiped.

**Design.** Two arms, ten pairs each. The original two-pair run is archived in `experiments/results/agent-bench-memory-2pairs.json`; the expanded run below uses the same prompts and checker.

- Session 1: the user states a test command (`bun test --coverage`) and a naming convention (`snake_case`), asks the agent to remember them, and forbids file edits/commands.
- The workspace is deleted and recreated, so no file can carry state.
- Session 2: a new dsh process/session in the same workspace and `DSH_HOME`, asked to recall the two facts without reading files or running commands.

**Baseline.** dsh without the plugin. **Treatment.** SuperDSH memory only (fuzzy/audit/verify disabled to isolate the feature).

**Decision rule.** Accept if treatment recalls both facts in every pair and baseline recalls neither; the memory store must contain both facts after session 1.

**Results.**

| Metric | Baseline | Treatment |
|---|---|---|
| Pairs recalling both facts | 0/10 | **10/10** |
| Memory store after session 1 | absent | present in all 10 pairs, with both facts |
| Session-2 tool calls | 0 | 0 (memory injected automatically) |
| Session-2 output tokens | 222–678 | 44–107 |

Baseline session 2 correctly abstained ("I can't answer either question reliably without inspecting the project"). Treatment session 2 answered both facts directly. The workspace was wiped between sessions, so only the external memory store could carry them.

**Verdict: accepted (default on).** Recall was complete in all 10 pairs; baseline was 0/10. The expanded run confirms the original two-pair result.

Raw data: `experiments/results/agent-bench.json` (`experiment: "memory"`).

**Limitations.** Lexical retrieval; no embedding. The experiment tests retention and injection, not long-horizon memory quality. The user explicitly asks the agent to remember, which is the supported contract.

## E3 — Verification gate

**Hypothesis.** Refusing to finish a turn until the project's test command passes increases task success and prevents "claimed success with failing tests."

**Design.** Four seeded repositories, each with a deliberately failing `node --test` suite covering edge cases (negatives, repeated spaces/punctuation, trailing junk, off-by-one). The agent is asked to fix `src.js`; the prompt does not require running tests. The test file is hashed and must remain unchanged.

- Baseline: dsh without the plugin.
- Treatment: SuperDSH verification gate with `command: "node --test"`, `maxAttempts: 2`.
- External checker after the session: run `node --test` again and verify the test file hash.

**Decision rule.** Keep the gate on by default only if it improves pass rate or reduces false success without materially increasing turns/tokens. Otherwise keep it opt-in and record the result.

**Results.**

| Metric | Baseline | Treatment |
|---|---|---|
| Tasks passing the external checker | 4/4 | 4/4 |
| Test file unchanged | 4/4 | 4/4 |
| Claimed success with failing tests | 0 | 0 |
| Turns | 1 per task | 1 per task |
| Steps (avg) | 4.0 | 4.75 |
| Output tokens (total) | 2,423 | 3,011 |
| Test runs observed (per task) | 1, 1, 1, 1 | 1, 2, 1, 1 |

This is a **ceiling effect**: `deepseek-flash` already ran the test suite unprompted in every baseline task, so the gate had nothing to catch. Treatment added one step on two tasks and about 24% more output tokens, with no success gain.

**Verdict: no default enablement.** The gate remains available (opt-in) as a definition-of-done guarantee for models or workflows that do not self-verify, but the evidence here does not justify turning it on by default.

Raw data: `experiments/results/agent-bench.json` (`experiment: "verify"`).

**Limitations.** Small sample, one model, visible tests only. The gate cannot verify untested behavior, and a slow test suite can dominate turn latency. The gate is bounded and fails open after `maxAttempts`; a permanently broken environment can still finish.

## E4 — Tamper-evident audit ledger

**Hypothesis.** A hash-chained ledger with a head anchor detects record edits, deletions, tail truncation, and reordering; a plain JSONL log detects none.

**Design.** 200 mixed session events. For each tamper scenario, rebuild a fresh ledger, apply the mutation, and verify. Baseline is a plain JSONL log checked only for parseability.

**Results**

| Tamper scenario | Hash chain | Plain JSONL | Chain's evidence |
|---|---|---|---|
| Edit one record | **detected** | missed | record hash mismatch |
| Delete a middle record | **detected** | missed | chain link mismatch |
| Truncate the tail | **detected** | missed | head anchor expects 200 records |
| Reorder records | **detected** | missed | chain link mismatch |

Append throughput: 120–215 records/s across runs (200 records in 0.9–1.7 s) on this machine, with a synchronous append plus head-anchor update per record. Valid ledger of 200 records verified OK.

**Verdict: accepted (default on).** All four scenarios are detected; the plain log detects none.

**Limitations.** The chain is unkeyed. An attacker with write access who recomputes every hash and the anchor can produce a consistent forged ledger. It detects accidental or naive tampering, not a full rewrite. Use an external WORM sink or signatures for adversarial models. The ledger stores data hashes and compact summaries, not payloads, so sensitive content stays only in dsh's own log.

## E5 — 0.2 suite checks

The 0.2 features are validated with deterministic tests plus a real dsh headless smoke. They do not yet have large agent-level A/B runs, so the claims below are guarantees tested in isolation, not benchmark wins.

**Command:** `bun test` → **82 tests / 427 assertions**, 12 files.

| Area | Checked behavior | Evidence |
|---|---|---|
| Effects | pending→committed, failed result, restart marks pending `unknown`, duplicate irreversible denied, pure tools allowed, configured irreversible tools, `effect_status` counts | `tests/effects.test.ts` |
| Artifacts | text/binary round-trip, idempotent put, tamper→verify false, tamper→get error, restart read, invalid hash, list dedupe | `tests/artifacts.test.ts` |
| Apply patch | two-file success, preflight failure writes nothing, second write failure restores the first file, duplicate path and maxFiles rejected, drifted old_string accepted | `tests/apply-patch.test.ts` |
| Notes | append/read, tag filter, malformed-line isolation, 8000-char cap, hostile session id stays inside the directory, atomic compact, entry cap | `tests/notes.test.ts` |
| Repo map | same-named symbols in two files both survive, import-aware impact, mtime+size rebuild, ignored build directories, result limits | `tests/repo-map.test.ts` |
| Knowledge | version chain with parentId, content revert creates a new version, trust/expiry filtering, full history, archived hidden from search, injection once per turn | `tests/knowledge.test.ts` |
| Handoff | mixed events, injected-context filter, apply_patch edits-array file extraction, snapshot/array reads, missing service/session errors, disable switch | `tests/handoff.test.ts` |
| History compact / reflection | turn grouping, injected-context filter, budget truncation, ratio stats, repeated calls, error aggregation, unverified edits, unfinished turns | `tests/history-compact.test.ts`, `tests/reflection.test.ts` |
| Budget | usage accumulation, total precedence, seq dedupe, exhausted status, enforce reject/allow, boundary at limit | `tests/budget.test.ts` |
| Memory | TTL hides expired entries, Markdown export/import into a fresh store | `tests/memory-extra.test.ts` |
| Audit | evidence lookup by data hash, missing evidence | `tests/plugin.test.ts` |

**Real dsh smoke (headless, `deepseek-flash`, dsh `0.2.1-rc.2`):**

- `artifact_put` stored 14 bytes; `note_append` saved 1 note; `effect_status` reported 2 committed, 0 pending, 0 unknown, 0 failed.
- `apply_patch` changed `a.ts` port 3000→8080 and added a comment to `b.ts` as one transaction; re-read confirmed both.
- `repo_map` with query `start` returned `a.ts:6 start (function)` from a two-file workspace.
- `knowledge_add` created `test-command` v1 (draft).
- `handoff` produced a 43-event deterministic report with tool counts, errors, files, commands, and a resume checklist; `history_compact` and `reflect` returned deterministic reports in a live session; no model call for any of them.

**Known gaps.** Effects/artifacts/apply-patch/repo-map/knowledge/handoff have not been run through a multi-task agent A/B yet. The deterministic tests cover the invariants; agent-level benefit (fewer failed edits, fewer repeated explorations, better recall) remains to be measured in the next experiment round.

## E6 — Nexus design validation

The 0.3 work adopts Nexus's invariants rather than its runtime. Each design has a deterministic test and, where possible, a real-process experiment.

**Command:** `bun test` → **160 tests / 918 assertions**, 20 files.

| Design | SuperDSH implementation | Evidence |
|---|---|---|
| Effects: intent/commit + classification | `src/features/effects.ts` | `tests/effects.test.ts` |
| Effects: explicit recovery plan | `effect_reconcile` (`replay`/`compensate`/`query`) + `effect_resolve` | `tests/effects.test.ts` |
| Effects: no O(n²) | In-memory ledger index, append-only file | 10,000 calls in **732.98 ms (0.073 ms/call)**, `experiments/effects-bench.ts` |
| Real crash recovery | Separate Bun processes, `taskkill /F /T` / `SIGKILL`, new-process reconciliation | `experiments/kill9-effects.ts`: `unknown=1`, `duplicateDenied=true`, `duplicateExecutions=0`; committed control allows a repeat |
| Canonical serialization + golden fixture | Canonical JSON + SHA-256 pinned by a fixture | `tests/audit-extra.test.ts`, `tests/fixtures/audit-v1.json` |
| Audit signatures + export | HMAC-SHA256 record signatures, `audit_export` with head/verify/records | `tests/audit-extra.test.ts` |
| Checkpoint/ReplayAction → replay plan | `replay_plan` machine-readable actions | `tests/replay-plan.test.ts` |
| Capability token + path scope | HMAC token, realpath boundary (`/src2` cannot match `/src`) | `tests/capability.test.ts` |
| Causal vector | `CausalClock` tick/merge/compare/serialize | `tests/causal-clock.test.ts` |
| Worker protocol | JSON-RPC NDJSON codec + deadline-aware task FSM | `tests/worker-protocol.test.ts` |
| Resource locks | Advisory cross-process file locks, stale takeover, TTL; integrated into `apply_patch` | `tests/file-locks.test.ts`, `tests/apply-patch.test.ts` |
| Budget preflight/settle | `BudgetLedger` reserve/settle/release; optional `reservePerRequest` | `tests/budget-ledger.test.ts`, `tests/budget.test.ts` |
| Schema subset guard | Tool schemas checked against dsh's supported keyword set | `tests/schema.test.ts` (caught a real `maxItems` registration failure) |

**Real dsh smoke:** `audit_export` returned 17 records with an intact chain; `effect_reconcile` reported zero unresolved; `replay_plan` produced one `read` action for a changed file; `apply_patch` edited `a.ts` through the lock path and a re-read confirmed the change. Earlier smoke covered artifacts, notes, repo map, knowledge, handoff, history compaction, and reflection.

**Not claimed:** the effect/artifact/apply-patch/lock/budget designs are deterministic guarantees, not agent-level A/B wins. `docs/invariants.md` maps each Phoenix invariant to its evidence and still lists artifact crash, audit-anchor crash, budget crash, checkpoint identity, and determinism context as gaps.

## E7 — Memory v2, error-repair memory, retention

These adopt the useful parts of awesome-agent-infra's memory/repair/archive packages without their data bugs.

**Command:** `bun test` → **197 tests / 1,184 assertions**, 23 files.

### Memory v2

- Tiers `core` / `long` / `working`; working entries are session-scoped.
- `memory_feedback` adjusts confidence/uses; `memory_invalidate` and `forget` cascade through `derivedFrom`.
- `memory_consolidate` deterministically merges near-duplicates (token Jaccard ≥ 0.85), archives expired/over-cap entries, and promotes frequent entries.
- `experiments/memory-v2-bench.ts`: 60 facts / 35 queries.

| Metric | Before | After |
|---|---:|---:|
| Active entries | 55 | 35 |
| recall@3 | 1.000 | 1.000 |
| Stale injections | 0 | 0 |
| Injection chars | 13,775 | 12,565 |
| Consolidation | — | merged 15, archived 20, promoted 0 |

The consolidation reduces injected bytes by 1,210 with no recall or stale-injection regression. It is lexical/deterministic; no embeddings or LLM summarization.

### Error-repair memory

- `repair_record` / `repair_search` / `repair_list`; normalized signature (tool + code + path/number/UUID-normalized message).
- `tools/post-execute` attaches a matching prior hint as data on a tool error; unknown errors are not guessed.
- `experiments/repair-bench.ts`: 5 hints, 10 known + 10 unknown errors.

| Metric | Result |
|---|---:|
| Known errors hit | 10/10 (100%) |
| Correct hint | 10/10 |
| Unknown-error false hits | 0/10 |
| Injected context | 212 chars average, 219 max |

### Retention

- `archive_ledgers`: gzip + SHA-256 manifest, verified round-trip, optional verified source deletion, `maxTotalBytes` trimming.
- `restore_archive`: full preflight, path traversal/symlink/overwrite refusal, `dry_run`.
- 15 tests cover archive, manifest, restore, corruption, and hostile paths.
- Opt-in only (`retention` config).

**Real-dsh smoke:** memory tier save + feedback + consolidate, and repair record + search were exercised in a live headless session. Retention is covered by tests and is intentionally not default-on.

## E8 — Deferred-candidate experiments

These candidates were not added by default in 0.2/0.3. Each experiment had a **pre-registered decision rule**; results below are from this machine.

### E8.1 Best-of-N planning (`max-mode-sampler`)

- 4 coding tasks, baseline: 2 single plans at temperature 0.3; treatment: 3 plans at 0.9 + judge at 0.1.
- Deterministic score: 0.4 files coverage + 0.3 concepts + 0.15 verification + 0.15 path validity.

| Metric | Result |
|---|---:|
| baseline average | 0.9860 |
| judge-selected average | 0.9947 |
| oracle best-of-3 | 1.0000 |
| judge top-1 accuracy | 75% (3/4) |
| token multiplier | **2.64×** |
| judge gain over baseline | **+0.0087** |

**Decision: do not add.** Baseline plans were already near ceiling; the oracle headroom was +0.0140, far below the +0.10 threshold, while treatment cost 2.64× tokens. The judge also missed the best candidate once (though that case was a path-normalization tie). Raw: `experiments/results/best-of-n-plan-bench.json`.

### E8.2 Agentic search (`agentic-search`)

- 12-file fixture, 15 queries (5 definition, 5 caller, 5 text); baseline = self-implemented lexical file scan; treatment = intent router over `find_symbol` / `impact_of` / `repo_map` + text fallback.
- Decision rule: hit@5 ≥ baseline + 0.15, higher MRR, latency <3×.

| Metric | Baseline | Treatment |
|---|---:|---:|
| hit@5 | 80.0% | **100%** |
| MRR | 0.700 | **0.900** |
| warm query latency | 2.56 ms | 3.50 ms (1.37×) |
| cold index | — | 165 ms |

**Decision: add as `search_code`.** It passed the rule. Caveat: the baseline is a synthetic substring scan, not the model's actual grep/ripgrep tool choice; caller MRR dropped 0.8→0.7 because comments count as references. `repoMap.search: false` disables the extra tool. Raw: `experiments/results/agentic-search-bench.json`.

### E8.3 Valid8 output gate

- 20 snippets: 10 correct (including `any`, `console.log`, one acceptable empty catch) and 10 buggy (syntax, duplicate declaration, brackets, injection, off-by-one, assignment-in-condition, missing await).
- Logic: syntax + security layers, default threshold 0.7.
- Decision rule: false positives ≤10% **and** buggy detection ≥50%.

| Metric | Result |
|---|---:|
| correct snippets flagged (FP) | 0/10 (0%) |
| buggy snippets caught (TP) | **1/10 (10%)** |
| syntax-only TP | 0/10 (0%) |

**Decision: do not add.** The AST path degraded (TypeScript 7.0.2 lacks the expected `createSourceFile` surface), so only regex checks ran; even with AST, single-issue scoring often stays above 0.7. It does not catch logic errors. Raw: `experiments/results/valid8-bench.json`.

### E8.4 Skill curation (`skillforge` / `skill-curator` / `dreamdistill`)

- 24 synthetic skills (16 active, 4 stale, 4 near-duplicates), 12 queries, lexical top-3.
- Treatment: archive stale/duplicates and pin top 20% by uses.
- Decision rule: hit@3 +0.10, stale/duplicate selections −50%, no character-cost increase; but require real evidence before adding.

| Metric | Baseline | Treatment |
|---|---:|---:|
| hit@3 | 83.3% | 100% |
| MRR | 0.875 | 1.000 |
| stale/duplicate top-3 slots | 25% | 0% |
| average description chars | 70.86 | 64.47 |

**Decision: defer, not add.** The mechanical rule passed, but the gain came entirely from two deliberately crowded synthetic queries; there is no real dsh skill corpus or agent-task evidence. Revisit with 30–50 real tasks and actual skill usage. Raw: `experiments/results/skill-curation-bench.json`.

## E9 — Research-prototype experiments

Six remaining candidates were tested instead of rejected by reputation. Each had a pre-registered rule. **All six end as do-not-add**; POMDP is the one rule-design caveat.

### E9.1 POMDP planner

- 3×3 gridworld, 20% perpendicular slip, goal bottom-right; 100 runs/policy (20 starts × 5 repetitions), same starts.
- Baselines: seeded random, greedy shortest-path replanned after every observed position.
- POMDP: `POMDPPlanner.plan` + `QMDPSolver`; **no observations supplied**, so the belief is predicted but never corrected.

| Policy | Success | Avg steps | Plan time |
|---|---:|---:|---:|
| POMDP | 100% | 3.45 | 163.5 ms avg (p99 420 ms, max 479 ms) |
| Greedy | 100% | **2.98** | ~0.006 ms |
| Random | 57% | 13.22 | ~0.006 ms |

The written rule passed only through the `random + 0.20` branch; it did **not** beat greedy (`+0.00`), used more steps, and paid ~163 ms/plan with a 1.4 s tail in another run. **Final decision: do-not-add.** The OR rule was too permissive; a production planner should beat a competent greedy baseline, not just random. Raw: `experiments/results/pomdp-bench.json`.

### E9.2 reasoning-search

- Synthetic 10-option multiple choice, 20 tasks, shared candidate streams; same 20-call/20-candidate budget for all strategies.
- Budget-matched standard sampling was the baseline, not a single 1-call sample.

| Strategy | Solve rate | Generate calls | Issue |
|---|---:|---:|---|
| standard sampling (1 call) | 30% | 1.0 | finalScore always 0 |
| budget-matched standard (20-call cap) | **100%** | 3.9 | — |
| best_of_n | 100% | 3.9 | no gain over matched baseline |
| MCTS (`general`) | 0% | 0.0 | root considered complete; empty solution |
| MCTS (`math`) | 25% | 10.0 | finalScore constant; no correctness discrimination |
| true guided beam | 30% | 1.0 | returns first complete candidate |

**Decision: do-not-add.** No strategy beat the budget-matched baseline by +0.10; MCTS-general never generated a token, and finalScore is unusable. Raw: `experiments/results/reasoning-search-bench.json`.

### E9.3 process-reward

- 100 synthetic arithmetic trajectories, 5 steps each, 50 train / 50 holdout; hidden intermediate-value rule, no labels in text.
- Untrained `scorePathHeuristic` holdout step AUC **0.5000**; after `PRMTrainer.train`, AUC **0.5000** (0/250 scores changed).
- Weak-supervision labels collapsed to two values; the trainer has no inference path; oracle-label training still cannot predict holdout.
- **Decision: do-not-add.** Not a usable PRM; raw: `experiments/results/process-reward-bench.json`.

### E9.4 agent-metacog

- 200 synthetic confidence/correctness samples, 100 train / 100 holdout, 8 seeds; external ECE/Brier against true correctness.
- Holdout ECE **0.3345 → 0.3361** (mean change **-0.0016**); Brier **0.3626 → 0.3654** (-0.0028). Raw stated confidence alone had ECE **0.0826** / Brier **0.2048**, far better.
- Knowledge-boundary F1 1.0 on clean synthetic domains, but forgetting F1 0.6667 (old-unknown false positives).
- Training applies zero-mean random weight noise, not gradients; loss increased in 8/8 seeds.
- **Decision: do-not-add.** Raw: `experiments/results/agent-metacog-bench.json`.

### E9.5 hallucination-detector

- 30 claims: 15 true and 15 false but plausible/internal-consistent, plus 5 contradictions.
- Default `detect()` over the combined text: TP 12, FP 12, FN 3, TN 3, **F1 0.6154**.
- 15/15 true/false pairs received identical verdicts; single claims are never flagged (single-member cluster coherence 1). The score is TF-IDF/Jaccard consistency, not factuality; `referenceFacts`/`knowledgeBase` are still lexical.
- **Decision: do-not-add.** Raw: `experiments/results/hallucination-detector-bench.json`.

### E9.6 code-sandbox

- 7 escape probes against `SecureExecutor` with a temporary secret file and env marker.
- `require('fs')`, `child_process`, dynamic `import('node:fs')` were blocked; timeout killed an infinite loop; normal code ran.
- **E7 escaped**: `process.getBuiltinModule('fs')` read the secret and created the marker file, bypassing the require hook. E6 also obtained the host `process`.
- **Decision: do-not-add.** A single escape fails the security gate; dsh's own approval/sandbox remains the boundary. Raw: `experiments/results/code-sandbox-security-bench.json`.

## E10 — Tool schema overhead and profiles

Every model request pays for the schemas of all registered tools. This experiment measures three profiles; no model call is involved.

**Command:** `bun experiments/tool-overhead-bench.ts` → `experiments/results/tool-overhead-bench.json`.

| Profile | Features | Tools | Schema chars | Approx tokens |
|---|---|---:|---:|---:|
| core | edit, memory, audit, effects, artifacts, apply_patch | 21 | 11,812 | **2,953** |
| coding | core + repo map/search, notes, knowledge, handoff/replay, compact/reflection | 37 | 19,934 | **4,984** |
| full | coding + verify, budget, retention | 41 | 22,438 | **5,610** |

SuperDSH 0.1.0 ships these as `core` / `coding` / `full`, with explicit feature flags overriding the profile. `full` includes verify, budget, and retention, but those three register only when their config is present, so an empty `full` profile stays at the 37-tool coding surface. Repair memory is opt-in after E14 and is not part of any profile; `repairs: true` adds its three tools.

**Initial decision (before E12):** do not keep growing the default tool count. Build the profiles, fix the repo-map cold start, then run an agent A/B to choose the default. E12 resolved the choice: **core is the default**. E14 later removed repair memory from core, which is why the current counts are 21/37/41 rather than 24/40/44.

## E11 — Repo-map performance

**Hypothesis.** After asynchronous concurrent file reads and a TTL cache, a 2,000-file cold build completes in under 5 s and a warm no-query call returns in under 100 ms, while keeping the tool's output contract (with bounded graph construction for very large repositories).

**Changes under test.**

- `readSources` reads up to 32 files concurrently instead of synchronously one at a time.
- A TTL cache (`repoMap.refreshMs`, default 5,000 ms) serves the last index without re-scanning; `refreshMs: 0` forces a signature check on every call.
- The no-query symbol list is precomputed and sorted instead of rebuilt per call.
- PageRank is capped at 10 iterations, graph edges at 50,000, and definitions per token at 20.

**Design.** Run `applyRepoMap` against the sibling `deepseek-harness` checkout with an explicit `maxFiles: 2000` (the shipped default is 1000), measure the first call (cold), then three TTL-warm calls. A second instance with `refreshMs: 0` measures three forced rescans on an unchanged tree.

**Decision rule.** Accept if cold <5,000 ms and warm p50 <100 ms.

**Results** (`experiments/results/repo-map-perf.json`):

| Metric | Result |
|---|---:|
| Files indexed | 2,000 |
| Cold build | **4,607.7 ms** (2,375.6 ms in a warm-cache run; previous implementation: 33.3 s) |
| Warm TTL query p50 | **0.1 ms** |
| Warm TTL query max | 0.2 ms |
| Forced unchanged rescan p50 | 267.5 ms (230.3–363.4 ms across runs) |
| Forced unchanged rescan max | 2,636.2 ms (includes the first cold build) |

**Verdict: accepted.** Both thresholds pass in every run. The previous 33.3 s cold start is no longer a blocker for `search_code`; even the uncached 4.5 s run stays under the 5 s limit. The 0.1 ms warm number measures a TTL cache hit, not a re-scan; the forced-rescan number is the honest cost when the cache is bypassed.

**Limitations.** The TTL can serve an index up to 5 s stale after an edit; `refreshMs: 0` trades latency for freshness. The cold build is 2.4–4.6 s on this 2,000-file checkout depending on OS cache state. Indexing remains regex-heuristic (comments and strings can be misread) and keys invalidation on mtime+size. The bounded graph (50k reference edges, 20 definitions per token) and 10 PageRank iterations can make centrality/reference results approximate on very dense repositories.

## E12 — Agent A/B: core vs coding profile

**Hypothesis.** The coding-only tools (repo map/search_code, notes, knowledge, handoff/replay, compaction/reflection) improve task success enough to justify their ~2k extra schema tokens per request.

**Design.** Five tasks against a fixture workspace, run through the real dsh headless CLI on `deepseek-flash` with an isolated workspace and `DSH_HOME` per arm:

| Task | Kind | Checker |
|---|---|---|
| config-callers | navigation | list both files that reference the config value |
| server-caller | navigation | name the exported server start function |
| transitive-impact | navigation | list direct and transitive callers of `validateToken` |
| two-file-fix | edit | project tests pass and `test.js` is unchanged |
| single-file-fix | edit | project tests pass and `test.js` is unchanged |

**Arms.** `core` profile (24 tools) vs `coding` profile (40 tools); all other config disabled. No `verify` gate in either arm.

**Decision rule (pre-registered).** Prefer `coding` only if it passes at least one more task than `core`; on a tie prefer the arm with lower input tokens.

**Results** (`experiments/results/profile-ab-bench.json`):

| Metric | core | coding |
|---|---:|---:|
| Tasks passed | **5/5** | 5/5 |
| Input tokens | **18,490** | 25,357 |
| Output tokens | **3,740** | 5,605 |
| Wall time | **86.3 s** | 101.5 s |

Per-task input tokens: config-callers 11,775 vs 13,464; server-caller 857 vs 872; transitive-impact 1,563 vs 1,635; two-file-fix 2,273 vs 7,316; single-file-fix 2,022 vs 2,070. The coding arm called `impact_of` once on transitive-impact, but both arms answered correctly.

**Verdict: default profile is `core`.** The coding tools did not win a task in this sample and cost 37% more input tokens. They remain available via `profile: coding` and `presets/coding.yml`. This run used 24 core / 40 coding tools, before repair memory was demoted by E14; both arms included repairs, so the comparison isolates the coding extras.

**Limitations.** n=5, one model, navigation and small edit tasks only. It does not exercise long-horizon knowledge accumulation, handoff, or multi-session memory, where coding-profile tools could pay off. Absence of a win here is not evidence that coding is useless; it is evidence that it should not be the default without a task-level win.

## E13 — Rejected candidates


Several attractive ideas from `awesome-agent-infra` and `nexus-runtime` did **not** survive review. They are documented in [`decisions.md`](decisions.md): the Nexus kernel bridge, a code-graph repo map, hallucination/confidence heuristics, goal-verifier's fallback, replay/dynamic-workflow recovery, and the LLM request dedup cache. The common reasons were: the implementation was a mock or had correctness bugs, the capability duplicated a stronger dsh primitive, or there was no way to measure a benefit in this environment.

## E14 — Repair memory agent A/B

**Hypothesis.** Automatically injecting a prior fix hint after a failure improves task success or reduces token use enough to justify keeping `repairs` in the default core.

**Design.** Sixteen single-file debugging tasks. Both arms enable the repairs feature and therefore expose the same three repair tools; only the treatment DSH_HOME is pre-seeded. For each task, the broken workspace is run once to capture the real `node --test` failure, and that output is recorded as the hint's error message. The hint is the task-specific fix.

**Decision rule (pre-registered).** Keep repairs default-on only if treatment passes at least two more tasks than baseline, or passes no fewer tasks while using at least 15% fewer input tokens. Otherwise make it opt-in.

**Results** (`experiments/results/repairs-ab-bench.json`):

| Metric | baseline | treatment |
|---|---:|---:|
| Tasks passed | **16/16** | **16/16** |
| Input tokens | **28,546** | 31,156 |
| Output tokens | **12,358** | 14,259 |
| Wall time | **205.7 s** | 213.7 s |
| Sessions with an injected hint | 0/16 | **16/16** |

A session-log check confirms the hint reached every treatment session; this is not a wiring failure. The hint costs 9.1% more input and 15.4% more output tokens, with no additional pass.

**Verdict: move `repairs` to opt-in.** The pre-registered rule fails. Core drops from 24 to 21 tools; `repairs: true` restores the feature.

**Limitations.** The corpus is a ceiling experiment: all tasks are small, single-file fixes that the model solves without help. It does not test hard, cross-session, or error-shape-specific failures where a hint could pay for itself. It also uses one model. The result justifies not making repairs a default, not deleting the feature. During this work, shell failures (`exitCode != 0`, `isError: false`) were added to the injection path so `node --test` failures are visible to repair memory at all.

## E15 — Cross-process store safety

**Hypothesis.** Two dsh processes sharing one workspace must not lose or corrupt memory, repair, or knowledge rows.

**Design.** Two independent Bun processes each write 25 rows to the same store:

- memory: 25 unique `memory_save` entries per process;
- repairs: 25 `repair_record` calls with the same signature per process;
- knowledge: 25 `knowledge_add` versions for the same key per process.

Mutations hold a per-file advisory lock and reload the file after acquiring it. Tests: `tests/concurrency.test.ts`.

| Store | Invariant | Result |
|---|---|---|
| memory | all rows preserved, ids unique | 50/50 rows, 50 unique ids |
| repairs | final successCount includes both processes | 50 |
| knowledge | versions contiguous, ids unique | 1..50, 50 unique ids |

**Verdict: accepted.** The read-modify-write cycles serialize instead of interleaving. Readers can still observe a snapshot from before a concurrent write; the lock protects writers, not a consistent multi-file transaction.

## E16 — Package install smoke

**Hypothesis.** The published file set can be installed through the same path users will use.

**Design.** `npm pack` → `dsh plugin --profile headless add <tarball>` in an isolated `DSH_HOME` → `dsh --profile headless --dump-config`, asserting the `id: super-dsh` entry. The smoke script is `scripts/install-smoke.ts`; it runs in CI after the build. A manual follow-up used the real headless CLI and called `artifact_put` / `artifact_verify` successfully against dsh `0.2.1-rc.2`.

**Verdict: accepted.** Packaging and profile installation work. Publishing itself is external and not performed by CI.

## Reproduction

```sh
cd super-dsh
bun run build
bun test                     # deterministic integration checks
bun run typecheck
bun run experiment:patch     # E1
bun experiments/audit-bench.ts   # E4
bun experiments/repo-map-perf.ts # E11
bun experiments/tool-overhead-bench.ts # E10
bun experiments/kill9-effects.ts       # real kill-9
bun experiments/kill9-artifacts.ts
bun experiments/kill9-audit-anchor.ts
bun experiments/kill9-budget.ts
bun tests/concurrency.test.ts     # E15
bun run smoke:install             # E16

# Agent-level E2/E3, the profile A/B, and the repair A/B (requires a sibling
# deepseek-harness checkout and DEEPSEEK_API_KEY)
SUPER_DSH_BENCH_ONLY=memory SUPER_DSH_BENCH_REPS=2 bun experiments/agent-bench.ts
SUPER_DSH_BENCH_ONLY=verify bun experiments/agent-bench.ts
SUPER_DSH_BENCH_JUST_MERGE=1 bun experiments/agent-bench.ts   # re-merge saved per-experiment results
bun experiments/profile-ab-bench.ts                            # E12
bun experiments/repairs-ab-bench.ts                             # E14
SUPER_DSH_REPAIR_LIMIT=2 bun experiments/repairs-ab-bench.ts    # quick subset
```

Per-experiment raw data is kept in `experiments/results/agent-bench-memory.json` and `agent-bench-verify.json`; the merged view is `agent-bench.json`.

The agent harness spawns the real dsh headless CLI with an explicit tsconfig so the session working directory can be an isolated task workspace. Each run gets its own `DSH_HOME`; the model is `deepseek-flash`; the title-generation request is disabled in every arm.
