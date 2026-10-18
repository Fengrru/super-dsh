# Invariants: Nexus Phoenix mapped to SuperDSH evidence

Nexus Runtime's Phoenix suite names eight design invariants. This document maps
each one to the SuperDSH tests and experiments that actually exercise it, and
separates three evidence classes:

- **fake-context** — deterministic Bun tests that drive the Cordis hooks with
  `tests/fake-context.ts` and temporary files. They prove hook semantics, not
  process-crash behavior.
- **real kill-9** — `experiments/kill9-effects.ts` spawns separate Bun
  processes, kills the crash child with `taskkill /F /T` (Windows) or `SIGKILL`
  (POSIX), and inspects the ledger from a new process.
- **gap** — no test or experiment exercises this yet.

The canonical invariant names below come from the Phoenix table in
`nexus-runtime/README.md`. Note that `PhoenixInvariants::check_all` in
`crates/phoenix-tests/src/lib.rs` uses a slightly different local numbering
(I-2 is causal validity and I-5 is cost integrity there, and it checks only a
subset); this document follows the README's eight-invariant naming.

## The eight invariants

| invariant | meaning | SuperDSH evidence | status (covered/partial/gap) |
|---|---|---|---|
| **I-1 State Authority** | The persisted state passes an integrity check after a restart; the database, not an in-memory report, is authoritative. | `audit_verify` checks record hashes, chain links, sequence monotonicity, and the head anchor; tamper/truncation/valid-chain cases are in `tests/plugin.test.ts` (**fake-context**), and HMAC signatures, stripped signatures, rehashed records, export, and a byte-pinned fixture are in `tests/audit-extra.test.ts` (**fake-context**). The effects ledger is append-only JSONL and is folded from disk by a new process in `experiments/kill9-effects.ts` (**real kill-9**), but it has no hash anchor of its own. | **partial** — audit integrity is tested, but not across a crash, and the effects ledger has no integrity hash. |
| **I-2 Checkpoint Identity** | A checkpoint's id and step index survive a restart. | No checkpoint/step subsystem exists in SuperDSH. The kill-9 experiment preserves the effect `callId` and canonical key across the process boundary, but that is an effect identity, not a checkpoint identity. | **gap** |
| **I-3 Replay Integrity** | Replaying the event log produces a byte-identical state. | There is no full event replay. The effects state is reconstructed by folding the append-only ledger (latest accepted record per `callId`) in a fresh process; `tests/effects.test.ts` covers restart/fold semantics with **fake-context**, and `experiments/kill9-effects.ts` covers the cross-process fold with **real kill-9**. The audit chain verifies order and hashes but does not materialize a replay state. | **partial** — ledger fold is verified; byte-identical full replay is not implemented. |
| **I-4 Artifact Integrity** | Vault artifact hashes remain valid after a restart. | `artifact_put`/`artifact_get`/`artifact_verify` use SHA-256 content addressing, re-verify on every read, and refuse tampered or missing blobs. `tests/artifacts.test.ts` covers text/binary round-trip, idempotent put, tamper detection, malformed hashes, and a new instance reading an existing store (**fake-context + temp filesystem**). | **partial** — functional integrity is covered; **artifact crash** (kill during blob write or index append) is a gap. |
| **I-5 Determinism Context** | Seed, model version, and input hash are preserved. | SuperDSH does not persist a model seed, model version, or determinism context. Audit records include an event data hash, but that is not a model determinism context. | **gap** |
| **I-6 Cost Integrity** | No duplicated LLM calls or double-charged usage. | Budget usage is accumulated once per session event seq (`tests/budget.test.ts`, **fake-context**), and `BudgetLedger` rejects duplicate reservation keys and refuses over-cap reservations (`tests/budget-ledger.test.ts`; in-memory). There is no LLM request cache. | **partial** — duplicate usage is guarded in memory; **budget crash** (kill before flush/restart) is a gap. |
| **I-7 Resume Continuity** | Execution resumes from step N+1 rather than repeating or losing work. | dsh owns session resume. SuperDSH contributes effects reconciliation: a new process marks leftover `pending` intents `unknown`, reports them with `effect_status`, offers `effect_reconcile` (read-only plan), and denies a repeated unresolved irreversible call. The restart/`unknown` transition is covered by `tests/effects.test.ts` (**fake-context**) and by `experiments/kill9-effects.ts` (**real kill-9**); the committed/duplicate-allowed control also passes under real process restart, and the post-reconcile retry of the unresolved irreversible call is denied (`duplicateDenied: true`, `duplicateExecutions: 0`). It does not replay a tool call or resume a step. | **partial** — crash detection, post-crash denial, and the committed control are covered; step-level resume is absent. |
| **I-8 Eventual Consistency** | All transitions are reconstructable from the event log. | The effects ledger is reconstructable across processes: a new process reads the JSONL and folds it to `unknown`/`committed`/`pending` ( **real kill-9** for the crash case; **fake-context** for unit cases). The audit ledger provides a hash-chained view of session events and an anchor. No full event-log materialization or replay is implemented. | **partial** — effects state is reconstructable; full session transition replay and **audit anchor crash** are gaps. |

### Evidence summary

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| `tests/effects.test.ts` | pending → committed/failed, restart pending → unknown, duplicate irreversible denial while pending, classification, `effect_reconcile` plans, `effect_resolve` terminal rules. **fake-context** | Real process death, OS kill behavior, cross-process file durability. |
| `experiments/kill9-effects.ts` | A real Bun child writes an irreversible intent, is killed after `READY`, and a new process reconciles it to `unknown`; the repeated unresolved irreversible call is denied and the committed control differs correctly (`duplicateDenied: true`, `duplicateExecutions: 0`). **real kill-9** | dsh host behavior, actual `git push`, artifact/audit/budget crash paths. |
| `tests/artifacts.test.ts` | Content-addressed integrity and restart read. **fake-context + temp filesystem** | Kill during artifact write, cross-process index recovery under crash. |
| `tests/plugin.test.ts`, `tests/audit-extra.test.ts` | Audit hash chain, tamper/truncation detection, HMAC signatures, export, golden fixture. **fake-context** | Kill between record append and head-anchor update; on-disk anchor torn-write recovery. |
| `tests/budget.test.ts`, `tests/budget-ledger.test.ts` | Usage deduplication, enforcement, reservation keys. **fake-context / in-memory** | Durable budget state across a crash. |
| `experiments/audit-bench.ts`, `experiments/patch-bench.ts`, agent benches | Throughput/false-positive/patch/memory measurements, not crash recovery. | Crash invariants. |

## Crash-stage coverage

| crash stage | evidence | method | status |
|---|---|---|---|
| Effect intent written, process killed before `tools/result` | `experiments/kill9-effects.ts` | **real kill-9**; taskkill /F /T on Windows, SIGKILL on POSIX; new process reconciles `pending → unknown`, and the duplicate irreversible retry is denied. | **covered** — detection + post-crash denial |
| Effect intent still `pending` (no `agent/created` yet) | `tests/effects.test.ts` duplicate-irreversible test | **fake-context**; duplicate pre-execute returns `deny` | covered in-process, not crash recovery |
| Effect result committed, new process restarts | `experiments/kill9-effects.ts` phases C/D | Separate process, **normal exit** (not a kill); committed status and `unresolved: 0` are re-read; repeat is allowed | covered for the committed control |
| Kill during effect ledger append (torn tail) | `tests/effects.test.ts` only parses malformed/torn lines in unit tests (`readRecords` skips a torn tail) | **fake-context**, no real torn write | partial |
| Artifact blob/index write crash | none | — | **gap** |
| Audit record append vs. head-anchor update crash | none; `audit_verify` tamper/truncation is **fake-context** | — | **gap** |
| Budget usage flush/restart crash | none; budget state and `BudgetLedger` are in memory | — | **gap** |
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

- **Artifact crash** is not tested. The artifact tests cover a new instance in
  the same test process, not a process killed between blob write and index
  append.
- **Audit anchor crash** is not tested. Tamper detection is tested with a
  completed ledger; a kill between `appendFileSync` and `writeHead` is not.
- **Budget crash** is not tested. `budget` state is per-process memory and
  `BudgetLedger` is in-memory, so a restart loses accounting rather than
  recovering it.
- **Checkpoint identity** and **determinism context** have no SuperDSH
  counterpart; both remain gaps.
- The kill-9 experiment uses a minimal fake Cordis context, not a live dsh
  host. It proves the effects hook and on-disk ledger behavior under real
  process death, not the host's own crash-recovery path.
- **Post-reconcile duplicate denial is fixed.** The unresolved-key index now
  tracks both `pending` and `unknown`, and `tools/pre-execute` checks it before
  appending a new intent. The kill-9 experiment records
  `unknown=1`, `duplicateDenied=true`, `duplicateExecutions=0`; the committed
  control still allows a repeat.

## Reproduction

```sh
cd super-dsh
bun experiments/kill9-effects.ts
cat experiments/results/kill9-effects.json
bun test
```

On Windows the parent uses `taskkill /F /T`; on POSIX it sends `SIGKILL`.
Both paths await the child exit and then read the same `DSH_HOME` ledger in a
new process.
