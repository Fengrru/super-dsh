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

**Design.** Two arms, two pairs each.

- Session 1: the user states a test command (`bun test --coverage`) and a naming convention (`snake_case`), asks the agent to remember them, and forbids file edits/commands.
- The workspace is deleted and recreated, so no file can carry state.
- Session 2: a new dsh process/session in the same workspace and `DSH_HOME`, asked to recall the two facts without reading files or running commands.

**Baseline.** dsh without the plugin. **Treatment.** SuperDSH memory only (fuzzy/audit/verify disabled to isolate the feature).

**Decision rule.** Accept if treatment recalls both facts in every pair and baseline recalls neither; the memory store must contain both facts after session 1.

**Results.**

| Metric | Baseline | Treatment |
|---|---|---|
| Pairs recalling both facts | 0/2 | **2/2** |
| Memory store after session 1 | absent | present in both pairs, with both facts |
| Session-2 tool calls | 0 | 0 (memory injected automatically) |
| Session-2 output tokens | 240–317 | 69–87 |

Baseline session 2 correctly abstained ("I can't answer either question reliably without inspecting the project"). Treatment session 2 answered both facts directly. The workspace was wiped between sessions, so only the external memory store could carry them.

**Verdict: accepted (default on).** Recall was complete in both pairs; baseline was 0/2.

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
| Effects: no O(n²) | In-memory ledger index, append-only file | 10,000 calls in **809.73 ms (0.081 ms/call)**, `experiments/effects-bench.ts` |
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

## E7 — Rejected candidates


Several attractive ideas from `awesome-agent-infra` and `nexus-runtime` did **not** survive review. They are documented in [`decisions.md`](decisions.md): the Nexus kernel bridge, a code-graph repo map, hallucination/confidence heuristics, goal-verifier's fallback, replay/dynamic-workflow recovery, and the LLM request dedup cache. The common reasons were: the implementation was a mock or had correctness bugs, the capability duplicated a stronger dsh primitive, or there was no way to measure a benefit in this environment.

## Reproduction

```sh
cd super-dsh
bun run build
bun test                     # deterministic integration checks
bun run experiment:patch     # E1
bun experiments/audit-bench.ts   # E4

# Agent-level E2/E3 (requires a sibling deepseek-harness checkout and DEEPSEEK_API_KEY)
SUPER_DSH_BENCH_ONLY=memory SUPER_DSH_BENCH_REPS=2 bun experiments/agent-bench.ts
SUPER_DSH_BENCH_ONLY=verify bun experiments/agent-bench.ts
SUPER_DSH_BENCH_JUST_MERGE=1 bun experiments/agent-bench.ts   # re-merge saved per-experiment results
```

Per-experiment raw data is kept in `experiments/results/agent-bench-memory.json` and `agent-bench-verify.json`; the merged view is `agent-bench.json`.

The agent harness spawns the real dsh headless CLI with an explicit tsconfig so the session working directory can be an isolated task workspace. Each run gets its own `DSH_HOME`; the model is `deepseek-flash`; the title-generation request is disabled in every arm.
