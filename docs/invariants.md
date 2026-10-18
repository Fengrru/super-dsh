# Consistency guarantees and evidence

This document maps eight reliability guarantees to the SuperDSH tests and
experiments that exercise them, and separates three evidence classes:

- **fake-context** — deterministic Bun tests that drive the Cordis hooks with
  `tests/fake-context.ts` and temporary files. They prove hook semantics, not
  process-crash behavior.
- **real kill-9** — `experiments/kill9-effects.ts` and
  `experiments/kill9-artifacts.ts` spawn separate Bun processes, kill the crash
  child with `taskkill /F /T` (Windows) or `SIGKILL` (POSIX), and inspect the
  on-disk state from a new process. `kill9-audit-anchor.ts` and
  `kill9-budget.ts` reproduce the relevant crash window without a real kill.
- **gap** — no test or experiment exercises this yet.

## The eight invariants

| invariant | meaning | SuperDSH evidence | status (covered/partial/gap) |
|---|---|---|---|
| **I-1 State Authority** | The persisted state passes an integrity check after a restart; the database, not an in-memory report, is authoritative. | `audit_verify` checks record hashes, chain links, sequence monotonicity, and the head anchor; tamper/truncation/valid-chain cases are in `tests/plugin.test.ts` (**fake-context**), and HMAC signatures, stripped signatures, rehashed records, export, and a byte-pinned fixture are in `tests/audit-extra.test.ts` (**fake-context**). `experiments/kill9-audit-anchor.ts` detects a valid record appended without a head update (**simulated crash window**, not a real kill). The effects ledger is append-only JSONL and is folded from disk by a new process in `experiments/kill9-effects.ts` (**real kill-9**), but it has no hash anchor of its own. | **partial** — audit integrity is tested and the anchor gap is detectable, but not across a real kill; the effects ledger has no integrity hash. |
| **I-2 Checkpoint Identity** | A checkpoint's id and step index survive a restart. | No checkpoint/step subsystem exists in SuperDSH. The kill-9 experiment preserves the effect `callId` and canonical key across the process boundary, but that is an effect identity, not a checkpoint identity. | **gap** |
| **I-3 Replay Integrity** | Replaying the event log produces a byte-identical state. | There is no full event replay. The effects state is reconstructed by folding the append-only ledger (latest accepted record per `callId`) in a fresh process; `tests/effects.test.ts` covers restart/fold semantics with **fake-context**, and `experiments/kill9-effects.ts` covers the cross-process fold with **real kill-9**. The audit chain verifies order and hashes but does not materialize a replay state. | **partial** — ledger fold is verified; byte-identical full replay is not implemented. |
| **I-4 Artifact Integrity** | Vault artifact hashes remain valid after a restart. | `artifact_put`/`artifact_get`/`artifact_verify` use SHA-256 content addressing, re-verify on every read, and refuse tampered or missing blobs. `tests/artifacts.test.ts` covers text/binary round-trip, tamper detection, and reindex after index loss. `experiments/kill9-artifacts.ts` writes a valid blob with no index, kills the writer process, then a new process reads/verifies the blob and rebuilds the index with `artifact_reindex`. | **covered** — functional integrity + real kill-9 + index-loss recovery. |
| **I-5 Determinism Context** | Seed, model version, and input hash are preserved. | SuperDSH does not persist a model seed, model version, or determinism context. Audit records include an event data hash, but that is not a model determinism context. | **gap** |
| **I-6 Cost Integrity** | No duplicated LLM calls or double-charged usage. | Budget usage is accumulated once per session event seq (`tests/budget.test.ts`, **fake-context**), and `BudgetLedger` rejects duplicate reservation keys and refuses over-cap reservations (`tests/budget-ledger.test.ts`). Usage and seq dedupe are persisted under `$DSH_HOME/super-dsh/budget`; `experiments/kill9-budget.ts` shows 900 → 900 across a restart. Reservations remain in-memory and are cleared on restart. There is no LLM request cache. | **partial** — usage is durable; reservations are per-process. |
| **I-7 Resume Continuity** | Execution resumes from step N+1 rather than repeating or losing work. | dsh owns session resume. SuperDSH contributes effects reconciliation: a new process marks leftover `pending` intents `unknown`, reports them with `effect_status`, offers `effect_reconcile` (read-only plan), and denies a repeated unresolved irreversible call. The restart/`unknown` transition is covered by `tests/effects.test.ts` (**fake-context**) and by `experiments/kill9-effects.ts` (**real kill-9**); the committed/duplicate-allowed control also passes under real process restart, and the post-reconcile retry of the unresolved irreversible call is denied (`duplicateDenied: true`, `duplicateExecutions: 0`). It does not replay a tool call or resume a step. | **partial** — crash detection, post-crash denial, and the committed control are covered; step-level resume is absent. |
| **I-8 Eventual Consistency** | All transitions are reconstructable from the event log. | The effects ledger is reconstructable across processes: a new process reads the JSONL and folds it to `unknown`/`committed`/`pending` ( **real kill-9** for the crash case; **fake-context** for unit cases). The audit ledger provides a hash-chained view of session events and an anchor. `experiments/kill9-audit-anchor.ts` appends a valid record without updating the head anchor and `audit_verify` detects it (`head anchor expects N records`). No full event-log materialization is implemented. | **partial** — effects state is reconstructable and the audit anchor gap is detected; full session transition replay is absent. |

### Evidence summary

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| `tests/effects.test.ts` | pending → committed/failed, restart pending → unknown, duplicate irreversible denial while pending, classification, `effect_reconcile` plans, `effect_resolve` terminal rules. **fake-context** | Real process death, OS kill behavior, cross-process file durability. |
| `experiments/kill9-effects.ts` | A real Bun child writes an irreversible intent, is killed after `READY`, and a new process reconciles it to `unknown`; the repeated unresolved irreversible call is denied and the committed control differs correctly (`duplicateDenied: true`, `duplicateExecutions: 0`). **real kill-9** | dsh host behavior, actual `git push`, artifact/audit crash paths. |
| `tests/artifacts.test.ts` | Content-addressed integrity, restart read, reindex after index loss. **fake-context + temp filesystem** | Cross-process blob write under a real kill (covered separately by kill9-artifacts). |
| `tests/concurrency.test.ts` | Two real Bun processes serialize memory/repair/knowledge read-modify-write cycles: 50/50 rows, 50 repair increments, contiguous knowledge versions. **real multi-process** | Cross-store transactions, reader snapshots during a concurrent write, or process crash during a store write. |
| `experiments/kill9-artifacts.ts` | A child writes a valid blob with no index and is killed; a new process reads/verifies it and `artifact_reindex` rebuilds the index. **real kill-9**. | Artifact integrity is content-based; index metadata (name/media type) for a never-indexed blob is reconstructed generically. |
| `tests/plugin.test.ts`, `tests/audit-extra.test.ts` | Audit hash chain, tamper/truncation detection, HMAC signatures, export, golden fixture. **fake-context** | No automatic repair after an anchor gap. |
| `experiments/kill9-audit-anchor.ts` | A record appended without a head update is detected as `head anchor expects N records`. **simulated crash window** | Detection only; no repair/rollback. |
| `tests/budget.test.ts`, `tests/budget-ledger.test.ts`, `experiments/kill9-budget.ts` | Usage deduplication, enforcement, reservation keys, durable used/seq state. **fake-context + two processes** | Reservations are not durable; there is no LLM request cache. |
| `experiments/audit-bench.ts`, `experiments/patch-bench.ts`, agent benches | Throughput/false-positive/patch/memory measurements, not crash recovery. | Crash invariants. |

## Crash-stage coverage

| crash stage | evidence | method | status |
|---|---|---|---|
| Effect intent written, process killed before `tools/result` | `experiments/kill9-effects.ts` | **real kill-9**; taskkill /F /T on Windows, SIGKILL on POSIX; new process reconciles `pending → unknown`, and the duplicate irreversible retry is denied. | **covered** — detection + post-crash denial |
| Effect intent still `pending` (no `agent/created` yet) | `tests/effects.test.ts` duplicate-irreversible test | **fake-context**; duplicate pre-execute returns `deny` | covered in-process, not crash recovery |
| Effect result committed, new process restarts | `experiments/kill9-effects.ts` phases C/D | Separate process, **normal exit** (not a kill); committed status and `unresolved: 0` are re-read; repeat is allowed | covered for the committed control |
| Kill during effect ledger append (torn tail) | `tests/effects.test.ts` only parses malformed/torn lines in unit tests (`readRecords` skips a torn tail) | **fake-context**, no real torn write | partial |
| Artifact blob/index write crash | `experiments/kill9-artifacts.ts` | A child writes a valid blob and is killed before any index entry; a new process reads/verifies by hash and `artifact_reindex` restores the index. **real kill-9** | **covered** |
| Audit record append vs. head-anchor update crash | `experiments/kill9-audit-anchor.ts` | A valid record is appended without updating the anchor; `audit_verify` fails with `head anchor expects 3 records`. | **partial** — detection, no repair |
| Budget usage flush/restart crash | `experiments/kill9-budget.ts`, `tests/budget.test.ts` | Child accumulates 900 tokens; a new process reads 900 from `$DSH_HOME/super-dsh/budget`. Reservations are released on restart. | **covered for used tokens; reservations are per-process** |
| Checkpoint/step resume crash | none; no checkpoint subsystem | — | **gap** |
| Worker process crash | none; no SuperDSH worker protocol | — | **gap** |

## What the real kill-9 experiment actually does

1. **Phase A** (`crash-intent`): sets `DSH_HOME` to a fresh temp directory, calls
   `applyEffects(ctx, { effects: { denyUnresolvedIrreversible: true } })`, runs
   the `tools/pre-execute` hook for `bash` with
   `{ command: 'git push origin main' }` (classified `irreversible`), does
   **not** call `tools/result`, prints `INTENT` and `READY`, then sleeps 30 s.
2. **Kill**: the parent waits for `READY`, runs `taskkill /F /T /PID <pid>` on
   Windows or `process.kill(pid, 'SIGKILL')` on POSIX, and awaits the child's
   exit. The ledger is read from disk after the exit; it must contain one
   `pending`, `irreversible` record with the canonical key for the arguments.
3. **Phase B** (`crash-verify`): a new Bun process with the same `DSH_HOME`
   calls `applyEffects`, emits `agent/created` (which appends `unknown` for the
   leftover `pending` record), calls `effect_reconcile` when registered
   (otherwise `effect_status`), then repeats the same `tools/pre-execute` call
   with a new `callId`. The experiment requires `{ kind: 'deny' }` and reports
   `unknown`, `duplicateDenied`, and `duplicateExecutions`; the current run
   returns `unknown=1`, `duplicateDenied=true`, `duplicateExecutions=0`.
4. **Phase C** (`commit`): a separate session records the same irreversible
   intent and sends `tools/result` with `isError: false`, producing
   `committed`.
5. **Phase D** (`committed-verify`): a new process emits `agent/created`, reads
   status (must be `committed`, zero unresolved), repeats the call, and must
   not be denied.

The command is never executed. There is no `git push` subprocess: the child
only runs the effects hooks, and `next()`/`tools/result` are stubs. The child
script is a real `.ts` file written under the OS temp directory and executed by
`process.execPath` (Bun), so the crash and restart are real OS processes, not
event-array simulations.

## Known gaps called out by this mapping

- **Artifact crash** is covered for blob-without-index: `kill9-artifacts.ts` proves a new process can read/verify the blob and `artifact_reindex` rebuilds the index. Blob bytes are verified by SHA-256; index-only metadata (name/media type) is not recoverable for a blob that was never indexed.
- **Audit anchor crash** is detected, not repaired. `kill9-audit-anchor.ts` appends a valid record without updating the anchor and `audit_verify` fails; there is no automatic rollback/repair.
- **Budget reservations** are in-memory: used tokens survive a restart, but an unsettled reservation is released rather than recovered.
- **Checkpoint identity** and **determinism context** have no SuperDSH
  counterpart; both remain gaps.
- The kill-9 experiments use a minimal fake Cordis context, not a live dsh
  host. They prove the effects/artifact/audit hooks and on-disk behavior under
  real process death, not the host's own crash-recovery path.
- **Post-reconcile duplicate denial is fixed.** The unresolved-key index now
  tracks both `pending` and `unknown`, and `tools/pre-execute` checks it before
  appending a new intent. The kill-9 experiment records
  `unknown=1`, `duplicateDenied=true`, `duplicateExecutions=0`; the committed
  control still allows a repeat.

## Reproduction

```sh
cd super-dsh
bun experiments/kill9-effects.ts
bun experiments/kill9-artifacts.ts
bun experiments/kill9-audit-anchor.ts
bun experiments/kill9-budget.ts
bun test
```

On Windows the parent uses `taskkill /F /T`; on POSIX it sends `SIGKILL`.
Both paths await the child exit and then read the same `DSH_HOME` ledger in a
new process.
